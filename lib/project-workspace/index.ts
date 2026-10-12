import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertNoSymlinks, resolveWorkspacePath, WorkspacePathError } from "./path.ts";

export type ProjectRef = {
  companyId: string;
  projectId: string;
};

export type ProjectWorkspaceOptions = {
  repoRoot?: string;
};

export type WorkspaceEntry = {
  path: string;
  type: "file" | "directory";
  size: number;
};

export type WorkspaceFile = {
  path: string;
  content: string;
  size: number;
  sha256: string;
};

const ignoredNames = new Set([".git", ".next", ".opc", "node_modules"]);

function visibleName(name: string): boolean {
  return !name.startsWith(".") && !ignoredNames.has(name);
}

export function projectWorkspace(ref: ProjectRef, options: ProjectWorkspaceOptions = {}) {
  if (!/^c-\d{3}$/.test(ref.companyId)) throw new Error("公司编号不合法");
  if (!/^p-\d{3}$/.test(ref.projectId)) throw new Error("项目编号不合法");
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const root = path.resolve(repoRoot, "workspaces", ref.companyId, ref.projectId);

  async function ensureRoot(): Promise<void> {
    await assertNoSymlinks(repoRoot, root);
    await fs.mkdir(root, { recursive: true });
    await assertNoSymlinks(repoRoot, root);
  }

  return {
    async ensure(): Promise<void> {
      await ensureRoot();
    },
    async list(input: { path?: string; depth?: number } = {}): Promise<WorkspaceEntry[]> {
      const maxDepth = input.depth ?? 2;
      if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 5) {
        throw new Error("列表深度必须在 1 到 5 之间");
      }
      await ensureRoot();
      const requested = input.path && input.path !== "." ? resolveWorkspacePath(root, input.path) : null;
      const start = requested?.absolute ?? root;
      const relativeStart = requested?.relative ?? "";
      await assertNoSymlinks(root, start);
      const startInfo = await fs.stat(start);
      if (!startInfo.isDirectory()) throw new Error("这个路径不是目录");
      const entries: WorkspaceEntry[] = [];

      async function visit(directory: string, relativeDirectory: string, depth: number): Promise<void> {
        const children = (await fs.readdir(directory, { withFileTypes: true }))
          .filter((entry) => visibleName(entry.name))
          .sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
          const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
          const absolute = path.join(directory, child.name);
          if (child.isSymbolicLink()) throw new WorkspacePathError(`禁止通过符号链接访问文件：${relative}`);
          if (child.isDirectory()) {
            entries.push({ path: relative, type: "directory", size: 0 });
            if (entries.length > 500) throw new Error("文件列表超过 500 项");
            if (depth < maxDepth) await visit(absolute, relative, depth + 1);
          } else if (child.isFile()) {
            const info = await fs.stat(absolute);
            entries.push({ path: relative, type: "file", size: info.size });
            if (entries.length > 500) throw new Error("文件列表超过 500 项");
          }
        }
      }

      await visit(start, relativeStart, 1);
      return entries;
    },
    async read(relativePath: string): Promise<WorkspaceFile> {
      const target = resolveWorkspacePath(root, relativePath);
      await assertNoSymlinks(repoRoot, target.absolute);
      const info = await fs.stat(target.absolute);
      if (!info.isFile()) throw new Error("这个路径不是文件");
      if (info.size > 1024 * 1024) throw new Error("文件超过 1 MiB，不能读取");
      const bytes = await fs.readFile(target.absolute);
      if (bytes.includes(0)) throw new Error("二进制文件不能读取");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("文件不是有效的 UTF-8 文本");
      }
      return {
        path: target.relative,
        content,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
  };
}
