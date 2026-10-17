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
import type { StagedChange } from "./run-workspace.ts";
import type { ApplyResult, AtomicFileWriter } from "./run-workspace.ts";

export type WorkflowLease = {
  path: string;
  workItemId: string;
  roleId: string;
  updatedAt: string;
};

type WorkflowManifest = {
  version: 1;
  changes: StagedChange[];
  leases: WorkflowLease[];
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

const workflowLocks = new Map<string, Promise<void>>();

export type WorkflowWorkspaceOptions = ProjectWorkspaceOptions & {
  writer?: AtomicFileWriter;
};

const nodeWriter: AtomicFileWriter = {
  replace: writeAtomic,
  async remove(file) {
    await fs.rm(file, { force: true });
  },
};

function assertWorkflowId(workflowId: string): void {
  if (!/^wf-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workflowId)) {
    throw new Error("协作任务编号不合法");
  }
}

function assertWorkItemId(workItemId: string): void {
  if (!/^wi-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workItemId)) {
    throw new Error("工作项编号不合法");
  }
}

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

async function withWorkflowLock<T>(workflowId: string, action: () => Promise<T>): Promise<T> {
  const previous = workflowLocks.get(workflowId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => current);
  workflowLocks.set(workflowId, chain);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (workflowLocks.get(workflowId) === chain) workflowLocks.delete(workflowId);
  }
}

export async function removeWorkflowWorkspace(
  workflowId: string,
  options: ProjectWorkspaceOptions = {},
): Promise<void> {
  assertWorkflowId(workflowId);
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const workflowsRoot = path.resolve(repoRoot, ".opc", "workflows");
  const target = path.resolve(workflowsRoot, workflowId);
  if (!target.startsWith(`${workflowsRoot}${path.sep}`)) throw new Error("协作任务目录不合法");
  await assertNoSymlinks(repoRoot, target);
  await fs.rm(target, { recursive: true, force: true });
}

export function workflowWorkspace(
  input: ProjectRef & { workflowId: string },
  options: WorkflowWorkspaceOptions = {},
) {
  assertWorkflowId(input.workflowId);
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const projectRoot = path.join(repoRoot, "workspaces", input.companyId, input.projectId);
  const workflowRoot = path.join(repoRoot, ".opc", "workflows", input.workflowId);
  const beforeRoot = path.join(workflowRoot, "before");
  const afterRoot = path.join(workflowRoot, "after");
  const manifestFile = path.join(workflowRoot, "manifest.json");
  const project = projectWorkspace(input, options);
  const writer = options.writer ?? nodeWriter;

  async function ensureRoot(): Promise<void> {
    await assertNoSymlinks(repoRoot, workflowRoot);
    await fs.mkdir(workflowRoot, { recursive: true });
    await assertNoSymlinks(repoRoot, workflowRoot);
  }

  async function loadManifest(): Promise<WorkflowManifest> {
    try {
      const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8")) as Partial<WorkflowManifest>;
      return { version: 1, changes: manifest.changes ?? [], leases: manifest.leases ?? [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, changes: [], leases: [] };
      throw error;
    }
  }

  async function saveManifest(manifest: WorkflowManifest): Promise<void> {
    await ensureRoot();
    await writeAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return {
    async read(relativePath: string): Promise<WorkspaceFile> {
      const target = resolveWorkspacePath(projectRoot, relativePath);
      const manifest = await loadManifest();
      if (!manifest.changes.some((change) => change.path === target.relative)) {
        return project.read(target.relative);
      }
      const staged = resolveWorkspacePath(afterRoot, target.relative);
      await assertNoSymlinks(repoRoot, staged.absolute);
      const bytes = await fs.readFile(staged.absolute);
      return {
        path: target.relative,
        content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        size: bytes.byteLength,
        sha256: sha256(bytes),
      };
    },

    async write(inputWrite: {
      path: string;
      content: string;
      baseSha256: string | null;
      workItemId: string;
      roleId: string;
      updatedAt: string;
    }): Promise<StagedChange> {
      assertWorkItemId(inputWrite.workItemId);
      return withWorkflowLock(input.workflowId, async () => {
        await project.ensure();
        await ensureRoot();
        if (binaryExtensions.has(path.extname(inputWrite.path).toLowerCase())) {
          throw new Error("当前只支持文本文件，不能创建这种二进制格式");
        }
        const bytes = Buffer.from(inputWrite.content, "utf8");
        if (bytes.byteLength > 1024 * 1024) throw new Error("文件超过 1 MiB，不能暂存");
        if (bytes.includes(0)) throw new Error("二进制文件不能暂存");
        const target = resolveWorkspacePath(projectRoot, inputWrite.path);
        await assertNoSymlinks(repoRoot, target.absolute);
        const manifest = await loadManifest();
        const lease = manifest.leases.find((item) => item.path === target.relative);
        if (lease && lease.workItemId !== inputWrite.workItemId) {
          throw new Error(`文件正由工作项 ${lease.workItemId} 修改：${target.relative}`);
        }
        const existing = manifest.changes.find((change) => change.path === target.relative);
        if (!existing && manifest.changes.length >= 100) throw new Error("一个协作任务最多修改 100 个文件");
        if (existing && inputWrite.baseSha256 !== existing.afterSha256) {
          throw new Error(`暂存版本已变化，需要重新读取：${target.relative}`);
        }
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
            if (inputWrite.baseSha256 !== before.sha256) {
              throw new Error(`正式文件已变化，需要重新读取：${target.relative}`);
            }
            beforeSha256 = before.sha256;
            beforeSize = before.size;
            operation = "update";
            const snapshot = resolveWorkspacePath(beforeRoot, target.relative);
            await writeAtomic(snapshot.absolute, Buffer.from(before.content, "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (inputWrite.baseSha256 !== null) throw new Error(`文件不存在，需要重新读取：${target.relative}`);
          }
        }

        const staged = resolveWorkspacePath(afterRoot, target.relative);
        await assertNoSymlinks(workflowRoot, staged.absolute);
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
        manifest.leases = [
          ...manifest.leases.filter((item) => item.path !== change.path),
          {
            path: change.path,
            workItemId: inputWrite.workItemId,
            roleId: inputWrite.roleId,
            updatedAt: inputWrite.updatedAt,
          },
        ].sort((left, right) => left.path.localeCompare(right.path));
        await saveManifest(manifest);
        return change;
      });
    },

    async changes(): Promise<(StagedChange & { lease: WorkflowLease | null })[]> {
      const manifest = await loadManifest();
      return manifest.changes.map((change) => ({
        ...change,
        lease: manifest.leases.find((lease) => lease.path === change.path) ?? null,
      }));
    },

    async diff(relativePath: string): Promise<string> {
      const target = resolveWorkspacePath(projectRoot, relativePath);
      const manifest = await loadManifest();
      const change = manifest.changes.find((item) => item.path === target.relative);
      if (!change) throw new Error("这个文件没有暂存修改");
      const after = await fs.readFile(resolveWorkspacePath(afterRoot, target.relative).absolute, "utf8");
      let before = "";
      if (change.operation === "update") {
        before = await fs.readFile(resolveWorkspacePath(beforeRoot, target.relative).absolute, "utf8");
      }
      return createTwoFilesPatch(target.relative, target.relative, before, after, "", "", { context: 3 });
    },

    async releaseWorkItemLeases(workItemId: string): Promise<void> {
      assertWorkItemId(workItemId);
      await withWorkflowLock(input.workflowId, async () => {
        const manifest = await loadManifest();
        manifest.leases = manifest.leases.filter((lease) => lease.workItemId !== workItemId);
        await saveManifest(manifest);
      });
    },

    async apply(finalize: () => Promise<void> = async () => {}): Promise<ApplyResult> {
      return withWorkflowLock(input.workflowId, async () => {
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
            before = await fs.readFile(resolveWorkspacePath(beforeRoot, change.path).absolute);
          } else {
            try {
              await fs.lstat(target.absolute);
              throw new Error(`文件已变化：${change.path}`);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
          const staged = resolveWorkspacePath(afterRoot, change.path);
          const after = await fs.readFile(staged.absolute);
          if (sha256(after) !== change.afterSha256) throw new Error(`暂存文件已变化：${change.path}`);
          prepared.push({ change, target: target.absolute, before, after });
        }
        const applied: typeof prepared = [];
        try {
          for (const item of prepared) {
            await assertNoSymlinks(repoRoot, path.dirname(item.target));
            await fs.mkdir(path.dirname(item.target), { recursive: true });
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
      });
    },
  };
}

