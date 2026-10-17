import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import {
  projectWorkspace,
  type ProjectRef,
  type ProjectWorkspaceOptions,
  type WorkspaceFile,
} from "./index.ts";
import { assertNoSymlinks, resolveWorkspacePath } from "./path.ts";

export type StagedChange = {
  path: string;
  operation: "create" | "update";
  beforeSha256: string | null;
  afterSha256: string;
  beforeSize: number;
  afterSize: number;
};

export type ApplyResult = {
  paths: string[];
};

export type AtomicFileWriter = {
  replace(file: string, content: Uint8Array): Promise<void>;
  remove(file: string): Promise<void>;
};

export type RunWorkspaceOptions = ProjectWorkspaceOptions & {
  writer?: AtomicFileWriter;
};

type RunManifest = {
  version: 1;
  changes: StagedChange[];
};

const binaryExtensions = new Set([
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".pdf",
  ".zip",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".mp3",
  ".mp4",
]);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeAtomic(file: string, content: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.opc-tmp-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, content, { flag: "wx" });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

const nodeWriter: AtomicFileWriter = {
  replace: writeAtomic,
  async remove(file) {
    await fs.rm(file, { force: true });
  },
};

function assertRunId(runId: string): void {
  if (!/^r-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    throw new Error("执行编号不合法");
  }
}

export async function removeRunWorkspace(
  runId: string,
  options: ProjectWorkspaceOptions = {},
): Promise<void> {
  assertRunId(runId);
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const runsRoot = path.resolve(repoRoot, ".opc", "runs");
  const target = path.resolve(runsRoot, runId);
  if (!target.startsWith(`${runsRoot}${path.sep}`)) throw new Error("执行目录不合法");
  await assertNoSymlinks(repoRoot, target);
  await fs.rm(target, { recursive: true, force: true });
}

export function runWorkspace(
  input: ProjectRef & { runId: string },
  options: RunWorkspaceOptions = {},
) {
  assertRunId(input.runId);
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const projectRoot = path.join(repoRoot, "workspaces", input.companyId, input.projectId);
  const runRoot = path.join(repoRoot, ".opc", "runs", input.runId);
  const beforeRoot = path.join(runRoot, "before");
  const afterRoot = path.join(runRoot, "after");
  const manifestFile = path.join(runRoot, "manifest.json");
  const project = projectWorkspace(input, options);
  const writer = options.writer ?? nodeWriter;

  async function ensureRunRoot(): Promise<void> {
    await assertNoSymlinks(repoRoot, runRoot);
    await fs.mkdir(runRoot, { recursive: true });
    await assertNoSymlinks(repoRoot, runRoot);
  }

  async function loadManifest(): Promise<RunManifest> {
    try {
      return JSON.parse(await fs.readFile(manifestFile, "utf8")) as RunManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, changes: [] };
      throw error;
    }
  }

  async function saveManifest(manifest: RunManifest): Promise<void> {
    await ensureRunRoot();
    await writeAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return {
    async read(relativePath: string): Promise<WorkspaceFile> {
      const projectTarget = resolveWorkspacePath(projectRoot, relativePath);
      const manifest = await loadManifest();
      if (!manifest.changes.some((change) => change.path === projectTarget.relative)) {
        return project.read(projectTarget.relative);
      }
      const staged = resolveWorkspacePath(afterRoot, projectTarget.relative);
      await assertNoSymlinks(repoRoot, staged.absolute);
      const bytes = await fs.readFile(staged.absolute);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return {
        path: projectTarget.relative,
        content,
        size: bytes.byteLength,
        sha256: sha256(bytes),
      };
    },
    async write(relativePath: string, content: string): Promise<StagedChange> {
      await project.ensure();
      await ensureRunRoot();
      if (binaryExtensions.has(path.extname(relativePath).toLowerCase())) {
        throw new Error("当前只支持文本文件，不能创建这种二进制格式");
      }
      const bytes = Buffer.from(content, "utf8");
      if (bytes.byteLength > 1024 * 1024) throw new Error("文件超过 1 MiB，不能暂存");
      if (bytes.includes(0)) throw new Error("二进制文件不能暂存");
      const target = resolveWorkspacePath(projectRoot, relativePath);
      await assertNoSymlinks(repoRoot, target.absolute);
      const manifest = await loadManifest();
      const existing = manifest.changes.find((change) => change.path === target.relative);
      if (!existing && manifest.changes.length >= 20) throw new Error("一次执行最多修改 20 个文件");
      const totalSize = manifest.changes.reduce(
        (sum, change) => sum + (change.path === target.relative ? 0 : change.afterSize),
        bytes.byteLength,
      );
      if (totalSize > 5 * 1024 * 1024) throw new Error("暂存内容超过 5 MiB");
      let beforeSha256: string | null = null;
      let beforeSize = 0;
      let operation: StagedChange["operation"] = "create";

      if (existing) {
        beforeSha256 = existing.beforeSha256;
        beforeSize = existing.beforeSize;
        operation = existing.operation;
      } else {
        try {
          const before = await project.read(target.relative);
          beforeSha256 = before.sha256;
          beforeSize = before.size;
          operation = "update";
          const snapshot = resolveWorkspacePath(beforeRoot, target.relative);
          await writeAtomic(snapshot.absolute, Buffer.from(before.content, "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }

      const staged = resolveWorkspacePath(afterRoot, target.relative);
      await assertNoSymlinks(runRoot, staged.absolute);
      await writeAtomic(staged.absolute, bytes);
      const change: StagedChange = {
        path: target.relative,
        operation,
        beforeSha256,
        afterSha256: sha256(bytes),
        beforeSize,
        afterSize: bytes.byteLength,
      };
      manifest.changes = [...manifest.changes.filter((item) => item.path !== change.path), change].sort((left, right) =>
        left.path.localeCompare(right.path),
      );
      await saveManifest(manifest);
      return change;
    },
    async changes(): Promise<StagedChange[]> {
      return (await loadManifest()).changes;
    },
    async diff(relativePath: string): Promise<string> {
      const target = resolveWorkspacePath(projectRoot, relativePath);
      const manifest = await loadManifest();
      const change = manifest.changes.find((item) => item.path === target.relative);
      if (!change) throw new Error("这个文件没有暂存修改");
      const staged = resolveWorkspacePath(afterRoot, target.relative);
      const after = await fs.readFile(staged.absolute, "utf8");
      let before = "";
      if (change.operation === "update") {
        const snapshot = resolveWorkspacePath(beforeRoot, target.relative);
        before = await fs.readFile(snapshot.absolute, "utf8");
      }
      return createTwoFilesPatch(target.relative, target.relative, before, after, "", "", { context: 3 });
    },
    async apply(finalize: () => Promise<void> = async () => {}): Promise<ApplyResult> {
      const manifest = await loadManifest();
      const prepared: {
        change: StagedChange;
        target: string;
        before: Buffer | null;
        after: Buffer;
      }[] = [];

      for (const change of manifest.changes) {
        const target = resolveWorkspacePath(projectRoot, change.path);
        await assertNoSymlinks(repoRoot, target.absolute);
        let before: Buffer | null = null;
        if (change.operation === "update") {
          const current = await project.read(change.path);
          if (current.sha256 !== change.beforeSha256) throw new Error(`文件已变化：${change.path}`);
          const snapshot = resolveWorkspacePath(beforeRoot, change.path);
          before = await fs.readFile(snapshot.absolute);
        } else {
          try {
            await fs.lstat(target.absolute);
            throw new Error(`文件已变化：${change.path}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        const staged = resolveWorkspacePath(afterRoot, change.path);
        await assertNoSymlinks(repoRoot, staged.absolute);
        const after = await fs.readFile(staged.absolute);
        if (sha256(after) !== change.afterSha256) throw new Error(`暂存文件已变化：${change.path}`);
        prepared.push({ change, target: target.absolute, before, after });
      }

      const applied: typeof prepared = [];
      try {
        for (const item of prepared) {
          await assertNoSymlinks(repoRoot, path.dirname(item.target));
          await fs.mkdir(path.dirname(item.target), { recursive: true });
          await assertNoSymlinks(repoRoot, path.dirname(item.target));
          await writer.replace(item.target, item.after);
          applied.push(item);
        }
        await finalize();
      } catch (error) {
        let recoveryError: unknown = null;
        for (const item of [...applied].reverse()) {
          try {
            if (item.before) await writer.replace(item.target, item.before);
            else await writer.remove(item.target);
          } catch (caught) {
            recoveryError ??= caught;
          }
        }
        if (recoveryError) {
          const message = recoveryError instanceof Error ? recoveryError.message : "恢复失败";
          throw new Error(`应用失败，且恢复未完成：${message}`, { cause: error });
        }
        throw error;
      }
      return { paths: prepared.map((item) => item.change.path) };
    },
  };
}
