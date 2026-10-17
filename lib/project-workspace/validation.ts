import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ProjectRef, ProjectWorkspaceOptions } from "./index.ts";
import { projectWorkspace } from "./index.ts";
import { assertNoSymlinks, resolveWorkspacePath } from "./path.ts";
import { workflowWorkspace } from "./workflow-workspace.ts";

const validationConfigSchema = z.object({
  profiles: z.record(
    z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    z.object({
      command: z.array(z.string().min(1).max(2000)).min(1).max(33),
      timeoutSeconds: z.number().int().min(1).max(600).default(120),
      requiresConfirmation: z.boolean().default(false),
    }),
  ),
});

export type ValidationResult = {
  profile: string;
  command: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

type ValidationProfile = {
  command: string[];
  timeoutSeconds: number;
  requiresConfirmation: boolean;
};

const genericValidationScript = String.raw`
const fs=require("node:fs"),p=require("node:path");
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.name.startsWith(".")?[]:e.isDirectory()?walk(p.join(d,e.name)):[p.join(d,e.name)]);
const files=walk(".").filter(f=>!f.endsWith("opc-validation.json"));
const empty=files.filter(f=>fs.statSync(f).size===0);
if(!files.length){console.error("没有可验证的项目文件");process.exit(1)}
if(empty.length){console.error("存在空文件: "+empty.join(", "));process.exit(1)}
console.log(JSON.stringify({profile:"default",files:files.length}));
`.trim();

const documentationValidationScript = String.raw`
const fs=require("node:fs"),p=require("node:path");
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.name.startsWith(".")?[]:e.isDirectory()?walk(p.join(d,e.name)):[p.join(d,e.name)]);
const files=walk(".").filter(f=>/\.(?:md|txt|html?)$/i.test(f));
const empty=files.filter(f=>fs.statSync(f).size===0);
if(!files.length){console.error("没有可验证的文档文件");process.exit(1)}
if(empty.length){console.error("存在空文档: "+empty.join(", "));process.exit(1)}
console.log(JSON.stringify({profile:"docs",files:files.length}));
`.trim();

const staticSiteValidationScript = String.raw`
const fs=require("node:fs"),p=require("node:path"),root=p.resolve(".");
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.name.startsWith(".")?[]:e.isDirectory()?walk(p.join(d,e.name)):[p.join(d,e.name)]);
const html=walk(".").filter(f=>/\.html?$/i.test(f)),errors=[];
if(!html.length){console.error("没有可验证的 HTML 文件");process.exit(1)}
for(const file of html){const text=fs.readFileSync(file,"utf8");if(!/<html[\s>]/i.test(text))errors.push(file+": 缺少 html 根元素");for(const match of text.matchAll(/(?:src|href)=["']([^"']+)["']/gi)){const ref=match[1];if(/^(?:https?:|data:|#|mailto:|javascript:)/i.test(ref))continue;const target=p.resolve(p.dirname(file),ref.split(/[?#]/)[0]);if(!target.startsWith(root+p.sep)||!fs.existsSync(target))errors.push(file+": 找不到 "+ref)}}
if(errors.length){console.error(errors.join("\n"));process.exit(1)}
console.log(JSON.stringify({profile:"static-site",html:html.length}));
`.trim();

const builtInValidationProfiles: Record<string, ValidationProfile> = {
  default: { command: [process.execPath, "-e", genericValidationScript], timeoutSeconds: 30, requiresConfirmation: false },
  docs: { command: [process.execPath, "-e", documentationValidationScript], timeoutSeconds: 30, requiresConfirmation: false },
  spec: { command: [process.execPath, "-e", documentationValidationScript], timeoutSeconds: 30, requiresConfirmation: false },
  frontend: { command: [process.execPath, "-e", staticSiteValidationScript], timeoutSeconds: 30, requiresConfirmation: false },
  "static-site": { command: [process.execPath, "-e", staticSiteValidationScript], timeoutSeconds: 30, requiresConfirmation: false },
};

export const builtInValidationProfileNames = Object.freeze(Object.keys(builtInValidationProfiles));

const ignoredNames = new Set([".git", ".next", ".opc", "node_modules"]);
const OUTPUT_LIMIT = 256 * 1024;

function assertWorkflowId(workflowId: string): void {
  if (!/^wf-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workflowId)) {
    throw new Error("协作任务编号不合法");
  }
}

function validationEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP", "NODE_ENV"];
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production" };
  for (const name of allowed) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

async function loadValidationProfile(ref: ProjectRef, profile: string, options: ProjectWorkspaceOptions) {
  const workspace = projectWorkspace(ref, options);
  let raw: string | null = null;
  try {
    raw = (await workspace.read("opc-validation.json")).content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const configuredProfiles = raw ? validationConfigSchema.parse(JSON.parse(raw)).profiles : {};
  const selected = configuredProfiles[profile] ?? builtInValidationProfiles[profile];
  if (!selected) {
    const available = [...new Set([...Object.keys(configuredProfiles), ...builtInValidationProfileNames])];
    throw new Error(`找不到验证配置：${profile}。可用 profile：${available.join("、")}`);
  }
  if (selected.requiresConfirmation) throw new Error(`验证配置需要用户确认：${profile}`);
  return selected;
}

async function materializeSandbox(
  input: ProjectRef & { workflowId: string },
  options: ProjectWorkspaceOptions,
): Promise<string> {
  assertWorkflowId(input.workflowId);
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const projectRoot = path.resolve(repoRoot, "workspaces", input.companyId, input.projectId);
  const workflowRoot = path.resolve(repoRoot, ".opc", "workflows", input.workflowId);
  const sandboxRoot = path.resolve(workflowRoot, "sandbox");
  if (!sandboxRoot.startsWith(`${workflowRoot}${path.sep}`)) throw new Error("验证沙箱目录不合法");
  await assertNoSymlinks(repoRoot, projectRoot);
  await assertNoSymlinks(repoRoot, workflowRoot);
  await fs.rm(sandboxRoot, { recursive: true, force: true });
  await fs.mkdir(sandboxRoot, { recursive: true });

  let copied = 0;
  async function copyDirectory(source: string, relativeDirectory: string): Promise<void> {
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || ignoredNames.has(entry.name)) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const sourcePath = path.join(source, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`验证沙箱拒绝符号链接：${relative}`);
      const destination = resolveWorkspacePath(sandboxRoot, relative).absolute;
      if (entry.isDirectory()) {
        await fs.mkdir(destination, { recursive: true });
        await copyDirectory(sourcePath, relative);
      } else if (entry.isFile()) {
        copied += 1;
        if (copied > 2000) throw new Error("验证沙箱文件超过 2000 个");
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(sourcePath, destination);
      }
    }
  }
  try {
    await copyDirectory(projectRoot, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const staged = workflowWorkspace(input, options);
  for (const change of await staged.changes()) {
    const destination = resolveWorkspacePath(sandboxRoot, change.path).absolute;
    const file = await staged.read(change.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.content, "utf8");
  }
  return sandboxRoot;
}

export async function runValidationProfile(
  input: ProjectRef & { workflowId: string; profile: string },
  options: ProjectWorkspaceOptions = {},
): Promise<ValidationResult> {
  const selected = await loadValidationProfile(input, input.profile, options);
  const sandboxRoot = await materializeSandbox(input, options);
  const [command, ...args] = selected.command;
  const started = Date.now();

  return new Promise<ValidationResult>((resolve, reject) => {
    const child = spawn(command!, args, {
      cwd: sandboxRoot,
      env: validationEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>, mark: () => void) => {
      if (current.byteLength >= OUTPUT_LIMIT) {
        mark();
        return current;
      }
      const remaining = OUTPUT_LIMIT - current.byteLength;
      if (chunk.byteLength > remaining) mark();
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk, () => {
        stdoutTruncated = true;
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk, () => {
        stderrTruncated = true;
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, selected.timeoutSeconds * 1000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        profile: input.profile,
        command: selected.command,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

