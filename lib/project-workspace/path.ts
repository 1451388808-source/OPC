import fs from "node:fs/promises";
import path from "node:path";

const blockedSegments = new Set([".git", ".next", ".opc", "node_modules"]);
const windowsDeviceName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export function resolveWorkspacePath(root: string, input: string): { absolute: string; relative: string } {
  if (!input || input.length > 500 || input.includes("\0")) {
    throw new WorkspacePathError("路径不合法");
  }
  if (
    input.includes("\\") ||
    input.startsWith("/") ||
    input.startsWith("//") ||
    /^[a-zA-Z]:/.test(input)
  ) {
    throw new WorkspacePathError("路径不合法");
  }

  const segments = input.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        /[ .]$/.test(segment) ||
        windowsDeviceName.test(segment) ||
        segment.length > 255,
    )
  ) {
    throw new WorkspacePathError("路径不合法");
  }
  if (segments.some((segment) => segment.startsWith(".") || blockedSegments.has(segment.toLowerCase()))) {
    throw new WorkspacePathError("禁止访问这个路径");
  }

  const workspaceRoot = path.resolve(root);
  const absolute = path.resolve(workspaceRoot, ...segments);
  const relative = path.relative(workspaceRoot, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new WorkspacePathError("路径不合法");
  }
  return { absolute, relative: segments.join("/") };
}

export async function assertNoSymlinks(root: string, absolute: string): Promise<void> {
  const workspaceRoot = path.resolve(root);
  const relative = path.relative(workspaceRoot, absolute);
  const targets = [workspaceRoot];
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    targets.push(current);
  }

  for (const target of targets) {
    try {
      const info = await fs.lstat(target);
      if (info.isSymbolicLink()) throw new WorkspacePathError("禁止通过符号链接访问文件");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
