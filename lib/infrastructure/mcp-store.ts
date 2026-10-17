import type { RowDataPacket } from "mysql2/promise";
import { toSql } from "../domain/time";
import type { Sql } from "./db";

export type McpToolPolicy = "allow" | "confirm" | "deny";
export type McpToolRisk = "read" | "reversible_write" | "controlled_execute" | "external_action";

export async function upsertMcpServer(
  sql: Sql,
  input: {
    id: string;
    name: string;
    transport: "stdio" | "streamable_http";
    config: unknown;
    enabled: boolean;
    discoveredAt: string;
    createdAt: string;
    updatedAt: string;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO mcp_servers
      (id, name, transport, config, enabled, discovered_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) AS incoming
     ON DUPLICATE KEY UPDATE
      name = incoming.name,
      transport = incoming.transport,
      config = incoming.config,
      enabled = incoming.enabled,
      discovered_at = incoming.discovered_at,
      updated_at = incoming.updated_at`,
    [
      input.id,
      input.name,
      input.transport,
      JSON.stringify(input.config),
      input.enabled,
      toSql(input.discoveredAt),
      toSql(input.createdAt),
      toSql(input.updatedAt),
    ],
  );
}

export async function upsertMcpTool(
  sql: Sql,
  input: {
    serverId: string;
    name: string;
    description: string;
    inputSchema: unknown;
    schemaSha256: string;
    riskLevel: McpToolRisk;
    policy: McpToolPolicy;
    enabled: boolean;
    discoveredAt: string;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO mcp_tools
      (server_id, name, description, input_schema, schema_sha256, risk_level, policy, enabled, discovered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) AS incoming
     ON DUPLICATE KEY UPDATE
      description = incoming.description,
      input_schema = incoming.input_schema,
      schema_sha256 = incoming.schema_sha256,
      risk_level = incoming.risk_level,
      policy = incoming.policy,
      enabled = incoming.enabled,
      discovered_at = incoming.discovered_at`,
    [
      input.serverId,
      input.name,
      input.description,
      JSON.stringify(input.inputSchema),
      input.schemaSha256,
      input.riskLevel,
      input.policy,
      input.enabled,
      toSql(input.discoveredAt),
    ],
  );
}

export async function insertMcpToolCall(
  sql: Sql,
  input: {
    projectId: string;
    workflowId: string;
    workItemId: string;
    roleId: string;
    serverId: string;
    toolName: string;
    policyResult: McpToolPolicy;
    argumentsSummary: unknown;
    status: "requested" | "running" | "denied";
    startedAt: string;
  },
): Promise<number> {
  const [result] = await sql.query(
    `INSERT INTO mcp_tool_calls
      (project_id, workflow_id, work_item_id, role_id, server_id, tool_name, policy_result,
       arguments_summary, status, result_summary, error_text, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', ?, NULL)`,
    [
      input.projectId,
      input.workflowId,
      input.workItemId,
      input.roleId,
      input.serverId,
      input.toolName,
      input.policyResult,
      JSON.stringify(input.argumentsSummary),
      input.status,
      toSql(input.startedAt),
    ],
  );
  return Number((result as { insertId?: number }).insertId ?? 0);
}

export async function finishMcpToolCall(
  sql: Sql,
  input: {
    id: number;
    status: "succeeded" | "failed" | "cancelled" | "denied";
    resultSummary: unknown;
    errorText: string;
    finishedAt: string;
  },
): Promise<void> {
  await sql.query(
    `UPDATE mcp_tool_calls
     SET status = ?, result_summary = ?, error_text = ?, finished_at = ?
     WHERE id = ?`,
    [
      input.status,
      JSON.stringify(input.resultSummary),
      input.errorText,
      toSql(input.finishedAt),
      input.id,
    ],
  );
}

export async function listMcpToolCalls(sql: Sql, workflowId: string) {
  const [rows] = await sql.query<RowDataPacket[]>(
    `SELECT id, project_id, workflow_id, work_item_id, role_id, server_id, tool_name,
            policy_result, arguments_summary, status, result_summary, error_text, started_at, finished_at
     FROM mcp_tool_calls WHERE workflow_id = ? ORDER BY id`,
    [workflowId],
  );
  return rows;
}

