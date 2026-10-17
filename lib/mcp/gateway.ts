import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { createOpcMcpConnection, type OpcMcpConnection } from "./client";
import { shanghaiTime } from "../domain/time";
import { getPool } from "../infrastructure/db";
import { appendProjectEvent, getProjectWorkflow } from "../infrastructure/collaboration-store";
import {
  finishMcpToolCall,
  insertMcpToolCall,
  upsertMcpServer,
  upsertMcpTool,
  type McpToolPolicy,
  type McpToolRisk,
} from "../infrastructure/mcp-store";
import { toolFailureFromUnknown } from "./error.ts";

const FIRST_PARTY_POLICIES = {
  "opc.project.list_files": "allow",
  "opc.project.read_file": "allow",
  "opc.project.stage_write": "allow",
  "opc.project.get_diff": "allow",
  "opc.project.list_changes": "allow",
  "opc.workflow.get_context": "allow",
  "opc.validation.run": "allow",
  "opc.workflow.request_decision": "allow",
} as const;

const OPC_MCP_RUNTIME_VERSION = "0.5.0";

// opc.validation.run 的 profile 最长允许 600 秒（见 validation.ts），MCP SDK 默认请求超时只有 60 秒，
// 验证命令跑久一点就会被客户端提前判定为 "Request timed out" 并触发协作任务失败。这里把客户端超时放宽到比服务端上限更长。
const MCP_CALL_TIMEOUT_MSEC = 650_000;

export type FirstPartyToolName = keyof typeof FIRST_PARTY_POLICIES;

declare global {
  var __opcMcpConnection: Promise<OpcMcpConnection> | undefined;
  var __opcMcpRegistry: Promise<void> | undefined;
  var __opcMcpRuntimeVersion: string | undefined;
}

async function connection(): Promise<OpcMcpConnection> {
  if (globalThis.__opcMcpConnection && globalThis.__opcMcpRuntimeVersion !== OPC_MCP_RUNTIME_VERSION) {
    const stale = globalThis.__opcMcpConnection;
    globalThis.__opcMcpConnection = undefined;
    globalThis.__opcMcpRegistry = undefined;
    globalThis.__opcMcpRuntimeVersion = undefined;
    await stale.then((handle) => handle.close()).catch(() => {});
  }
  globalThis.__opcMcpConnection ??= createOpcMcpConnection().catch((error) => {
    globalThis.__opcMcpConnection = undefined;
    globalThis.__opcMcpRuntimeVersion = undefined;
    throw error;
  });
  globalThis.__opcMcpRuntimeVersion = OPC_MCP_RUNTIME_VERSION;
  return globalThis.__opcMcpConnection;
}

export async function listOpcMcpTools() {
  const handle = await connection();
  await ensureRegistry(handle);
  return handle.client.listTools();
}

function policyFor(name: string): McpToolPolicy {
  return name in FIRST_PARTY_POLICIES ? FIRST_PARTY_POLICIES[name as FirstPartyToolName] : "deny";
}

function riskFor(name: string): McpToolRisk {
  if (name === "opc.validation.run") return "controlled_execute";
  return name === "opc.project.stage_write" || name === "opc.workflow.request_decision"
    ? "reversible_write"
    : "read";
}

function schemaHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function argumentSummary(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "content" && typeof item === "string"
        ? { omitted: true, characters: item.length, sha256: createHash("sha256").update(item).digest("hex") }
        : item,
    ]),
  );
}

function toolResultErrorText(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

async function ensureRegistry(handle: OpcMcpConnection): Promise<void> {
  globalThis.__opcMcpRegistry ??= (async () => {
    const now = shanghaiTime().iso;
    const tools = await handle.client.listTools();
    await upsertMcpServer(getPool(), {
      id: "opc-local",
      name: "OPC Local MCP Server",
      transport: "stdio",
      config: { command: "node", entry: "mcp/server.ts", environment: ["DATABASE_URL"] },
      enabled: true,
      discoveredAt: now,
      createdAt: now,
      updatedAt: now,
    });
    for (const tool of tools.tools) {
      await upsertMcpTool(getPool(), {
        serverId: "opc-local",
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
        schemaSha256: schemaHash(tool.inputSchema),
        riskLevel: riskFor(tool.name),
        policy: policyFor(tool.name),
        enabled: policyFor(tool.name) !== "deny",
        discoveredAt: now,
      });
    }
  })().catch((error) => {
    globalThis.__opcMcpRegistry = undefined;
    throw error;
  });
  await globalThis.__opcMcpRegistry;
}

export async function callOpcMcpTool(input: {
  name: FirstPartyToolName;
  context: { workflowId: string; workItemId: string; roleId: string };
  arguments?: Record<string, unknown>;
}) {
  const handle = await connection();
  await ensureRegistry(handle);
  const workflow = await getProjectWorkflow(getPool(), input.context.workflowId);
  if (!workflow) throw new Error("找不到这个协作任务");
  const policy = policyFor(input.name);
  const argumentsWithContext = { ...input.arguments, ...input.context };
  const startedAt = shanghaiTime().iso;
  const callId = await insertMcpToolCall(getPool(), {
    projectId: workflow.projectId,
    workflowId: input.context.workflowId,
    workItemId: input.context.workItemId,
    roleId: input.context.roleId,
    serverId: "opc-local",
    toolName: input.name,
    policyResult: policy,
    argumentsSummary: argumentSummary(argumentsWithContext),
    status: policy === "allow" ? "running" : "denied",
    startedAt,
  });
  await appendProjectEvent(getPool(), {
    projectId: workflow.projectId,
    workflowId: input.context.workflowId,
    workItemId: input.context.workItemId,
    actorType: "tool",
    actorId: "opc-local",
    kind: "tool_call",
    body: { callId, name: input.name, policy, arguments: argumentSummary(argumentsWithContext), hidden: true },
    createdAt: startedAt,
  });
  if (policy !== "allow") {
    const message = policy === "confirm" ? "MCP 工具需要用户确认" : "MCP 工具未获授权";
    await finishMcpToolCall(getPool(), {
      id: callId,
      status: "denied",
      resultSummary: {},
      errorText: message,
      finishedAt: shanghaiTime().iso,
    });
    throw new Error(message);
  }
  try {
    const result = await handle.client.callTool(
      { name: input.name, arguments: argumentsWithContext },
      { timeout: MCP_CALL_TIMEOUT_MSEC },
    );
    const finishedAt = shanghaiTime().iso;
    const failure = result.isError
      ? toolFailureFromUnknown(new Error(toolResultErrorText(result) || "MCP 工具返回失败"))
      : null;
    const summary = {
      isError: result.isError === true,
      contentTypes: result.content.map((item) => item.type),
      structuredBytes: result.structuredContent === undefined ? 0 : JSON.stringify(result.structuredContent).length,
      ...(failure ? { failure } : {}),
    };
    await finishMcpToolCall(getPool(), {
      id: callId,
      status: result.isError ? "failed" : "succeeded",
      resultSummary: summary,
      errorText: failure?.message ?? "",
      finishedAt,
    });
    await appendProjectEvent(getPool(), {
      projectId: workflow.projectId,
      workflowId: input.context.workflowId,
      workItemId: input.context.workItemId,
      actorType: "tool",
      actorId: "opc-local",
      kind: "tool_result",
      body: { callId, name: input.name, ...summary, hidden: true },
      createdAt: finishedAt,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP 工具调用失败";
    const finishedAt = shanghaiTime().iso;
    await finishMcpToolCall(getPool(), {
      id: callId,
      status: "failed",
      resultSummary: {},
      errorText: message,
      finishedAt,
    });
    await appendProjectEvent(getPool(), {
      projectId: workflow.projectId,
      workflowId: input.context.workflowId,
      workItemId: input.context.workItemId,
      actorType: "tool",
      actorId: "opc-local",
      kind: "tool_result",
      body: { callId, name: input.name, isError: true, error: message, hidden: true },
      createdAt: finishedAt,
    });
    throw error;
  }
}

export async function closeOpcMcpConnection(): Promise<void> {
  const current = globalThis.__opcMcpConnection;
  globalThis.__opcMcpConnection = undefined;
  globalThis.__opcMcpRegistry = undefined;
  globalThis.__opcMcpRuntimeVersion = undefined;
  if (current) await (await current).close();
}

export type OpcMcpClient = Client;

