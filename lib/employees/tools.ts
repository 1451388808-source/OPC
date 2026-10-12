import { z } from "zod";
import type { StagedChange } from "../project-workspace/run-workspace";
import type { WorkspaceEntry, WorkspaceFile } from "../project-workspace";

export type EmployeeToolDefinition = {
  name: "list_files" | "read_file" | "write_file";
  description: string;
  inputSchema: Record<string, unknown>;
};

export type EmployeeToolset = {
  definitions: EmployeeToolDefinition[];
  execute(name: string, input: unknown): Promise<unknown>;
  changedPaths(): Promise<string[]>;
};

type ProjectReader = {
  list(input?: { path?: string; depth?: number }): Promise<WorkspaceEntry[]>;
};

type RunEditor = {
  read(path: string): Promise<WorkspaceFile>;
  write(path: string, content: string): Promise<StagedChange>;
  changes(): Promise<StagedChange[]>;
};

const listSchema = z.object({
  path: z.string().default("."),
  depth: z.number().int().min(1).max(5).default(2),
});
const readSchema = z.object({ path: z.string().min(1).max(500) });
const writeSchema = z.object({
  path: z.string().min(1).max(500),
  content: z.string(),
});

const definitions: EmployeeToolDefinition[] = [
  {
    name: "list_files",
    description: "列出项目工作区内的文件和目录。只能使用项目相对路径。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "项目相对目录，默认 ." },
        depth: { type: "integer", minimum: 1, maximum: 5, description: "递归深度" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "读取一个 UTF-8 文本文件。若本次执行已修改该文件，返回暂存版本。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "项目相对文件路径" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "创建或更新 UTF-8 文本文件。修改只进入暂存区，等待老板批准。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "项目相对文件路径" },
        content: { type: "string", description: "完整文件内容" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];

export function createProjectFileTools(input: {
  project: ProjectReader;
  run: RunEditor;
}): EmployeeToolset {
  return {
    definitions,
    async execute(name, raw) {
      if (name === "list_files") return input.project.list(listSchema.parse(raw));
      if (name === "read_file") {
        const value = readSchema.parse(raw);
        return input.run.read(value.path);
      }
      if (name === "write_file") {
        const value = writeSchema.parse(raw);
        return input.run.write(value.path, value.content);
      }
      throw new Error(`未知工具：${name}`);
    },
    async changedPaths() {
      return (await input.run.changes()).map((change) => change.path);
    },
  };
}
