import { z } from "zod";
import type { EmployeeToolDefinition, EmployeeToolset } from "./tools";
import type { FirstPartyToolName } from "../mcp/gateway";
import { decisionScopeSchema } from "../collaboration/action-protocol.ts";
import { ToolExecutionError, toolFailureFromUnknown } from "../mcp/error.ts";

type McpCall = (input: {
  name: FirstPartyToolName;
  context: { workflowId: string; workItemId: string; roleId: string };
  arguments?: Record<string, unknown>;
}) => Promise<{ isError?: boolean; structuredContent?: unknown; content: { type: string; text?: string }[] }>;

const listSchema = z.object({
  path: z.string().default("."),
  depth: z.number().int().min(1).max(5).default(2),
});
const readSchema = z.object({ path: z.string().min(1).max(500) });
const writeSchema = z.object({ path: z.string().min(1).max(500), content: z.string() });
const diffSchema = z.object({ path: z.string().min(1).max(500) });
const validationSchema = z.object({ profile: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/) });
const decisionSchema = z.object({
  scope: decisionScopeSchema,
  question: z.string().min(1),
  options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), impact: z.string().min(1) })).min(2).max(5),
  recommendation: z.string().min(1),
  reason: z.string().min(1),
});

const definitions: EmployeeToolDefinition[] = [
  {
    name: "list_files",
    description: "列出项目工作区和当前协作任务已暂存的文件。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "项目相对目录，默认 ." },
        depth: { type: "integer", minimum: 1, maximum: 5 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "读取 UTF-8 文本文件。若协作任务已经暂存该路径，返回暂存版本。写入前必须先读取现有文件。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "暂存完整 UTF-8 文件内容，不直接修改正式项目文件。更新现有文件前必须先 read_file。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "run_validation",
    description: "在隔离沙箱中运行验证 profile。内置可用：default、docs、spec、frontend、static-site；项目配置可覆盖同名 profile。",
    inputSchema: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description: "通用检查用 default，文档用 docs/spec，静态网页用 frontend/static-site。",
        },
      },
      required: ["profile"],
      additionalProperties: false,
    },
  },
  {
    name: "request_decision",
    description: "当产品取舍、权限或老板偏好无法由员工决定时，提交结构化选项。只选择当前工作项或当前工作项及其后继，不填写内部编号。提交后当前工作项立即进入阻塞状态，你将失去写文件权限；不要再调用其他工具，直接给出当前进度摘要并结束本轮执行，等待老板回复后系统会自动恢复。",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["current", "current_and_dependents"],
          description: "current 只暂停当前工作项；current_and_dependents 同时暂停所有未结束后继。",
        },
        question: { type: "string" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" }, impact: { type: "string" } },
            required: ["id", "label", "impact"],
          },
          minItems: 2,
          maxItems: 5,
        },
        recommendation: { type: "string" },
        reason: { type: "string" },
      },
      required: ["scope", "question", "options", "recommendation", "reason"],
      additionalProperties: false,
    },
  },
];

const reviewDefinitions: EmployeeToolDefinition[] = [
  definitions[0]!,
  definitions[1]!,
  {
    name: "get_diff",
    description: "读取某个已暂存文件相对于正式版本的统一 diff。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_changes",
    description: "列出当前工作项已暂存的文件改动（路径、新旧哈希与大小）。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  definitions[3]!,
];

function structured<T>(
  result: { isError?: boolean; structuredContent?: unknown; content: { type: string; text?: string }[] },
  name: string,
): T {
  if (result.isError) {
    const message = result.content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n")
      .trim();
    throw new ToolExecutionError(toolFailureFromUnknown(new Error(message || `${name} 执行失败`)));
  }
  if (result.structuredContent === undefined) {
    throw new ToolExecutionError({
      code: "provider_rejected",
      message: `${name} 没有返回结构化结果`,
      retryable: true,
    });
  }
  return result.structuredContent as T;
}

export function createMcpReviewTools(input: {
  context: { workflowId: string; workItemId: string; roleId: string };
  call?: McpCall;
}): EmployeeToolset {
  const invoke: McpCall =
    input.call ??
    (async (request) => {
      const { callOpcMcpTool } = await import("../mcp/gateway");
      return callOpcMcpTool(request);
    });
  return {
    definitions: reviewDefinitions,
    async execute(name, raw) {
      if (name === "list_files") {
        const value = listSchema.parse(raw);
        return structured(
          await invoke({ name: "opc.project.list_files", context: input.context, arguments: value }),
          name,
        );
      }
      if (name === "read_file") {
        const value = readSchema.parse(raw);
        return structured(
          await invoke({ name: "opc.project.read_file", context: input.context, arguments: value }),
          name,
        );
      }
      if (name === "get_diff") {
        const value = diffSchema.parse(raw);
        return structured(
          await invoke({ name: "opc.project.get_diff", context: input.context, arguments: value }),
          name,
        );
      }
      if (name === "list_changes") {
        const result = structured<{ changes: { lease?: { workItemId?: string } | null }[] }>(
          await invoke({ name: "opc.project.list_changes", context: input.context }),
          name,
        );
        return { changes: result.changes.filter((change) => change.lease?.workItemId === input.context.workItemId) };
      }
      if (name === "run_validation") {
        const value = validationSchema.parse(raw);
        return structured(
          await invoke({ name: "opc.validation.run", context: input.context, arguments: value }),
          name,
        );
      }
      throw new Error(`未知工具：${name}`);
    },
    async changedPaths() {
      return [];
    },
  };
}

export function createMcpWorkflowTools(input: {
  context: { workflowId: string; workItemId: string; roleId: string };
  call?: McpCall;
}): EmployeeToolset {
  const hashes = new Map<string, string>();
  const invoke: McpCall =
    input.call ??
    (async (request) => {
      const { callOpcMcpTool } = await import("../mcp/gateway");
      return callOpcMcpTool(request);
    });
  return {
    definitions,
    async execute(name, raw) {
      if (name === "list_files") {
        const value = listSchema.parse(raw);
        return structured(
          await invoke({ name: "opc.project.list_files", context: input.context, arguments: value }),
          name,
        );
      }
      if (name === "read_file") {
        const value = readSchema.parse(raw);
        const file = structured<{ sha256: string }>(
          await invoke({ name: "opc.project.read_file", context: input.context, arguments: value }),
          name,
        );
        hashes.set(value.path, file.sha256);
        return file;
      }
      if (name === "write_file") {
        const value = writeSchema.parse(raw);
        const change = structured<{ afterSha256: string }>(
          await invoke({
            name: "opc.project.stage_write",
            context: input.context,
            arguments: { ...value, baseSha256: hashes.get(value.path) ?? null },
          }),
          name,
        );
        hashes.set(value.path, change.afterSha256);
        return change;
      }
      if (name === "run_validation") {
        const value = validationSchema.parse(raw);
        return structured(
          await invoke({ name: "opc.validation.run", context: input.context, arguments: value }),
          name,
        );
      }
      if (name === "request_decision") {
        const value = decisionSchema.parse(raw);
        return structured(
          await invoke({ name: "opc.workflow.request_decision", context: input.context, arguments: value }),
          name,
        );
      }
      throw new Error(`未知工具：${name}`);
    },
    async changedPaths() {
      const result = structured<{ changes: { path: string; lease?: { workItemId?: string } | null }[] }>(
        await invoke({ name: "opc.project.list_changes", context: input.context }),
        "list_changes",
      );
      return result.changes
        .filter((change) => change.lease?.workItemId === input.context.workItemId)
        .map((change) => change.path);
    },
  };
}

