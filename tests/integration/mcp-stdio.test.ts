import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { claimWorkItem, createCollaborationWorkflow } from "../../lib/application/collaboration.ts";
import { closePool, databaseConfig, migrate } from "../../lib/infrastructure/db.ts";
import { createOpcMcpConnection } from "../../lib/mcp/client.ts";
import { callOpcMcpTool, closeOpcMcpConnection } from "../../lib/mcp/gateway.ts";

test.after(async () => {
  await closePool();
});

async function unusedProjectPair(connection: Connection): Promise<{ companyId: string; projectId: string }> {
  const [companies] = await connection.query<RowDataPacket[]>("SELECT id FROM companies");
  const [projects] = await connection.query<RowDataPacket[]>("SELECT id FROM projects");
  const usedCompanies = new Set(companies.map((row) => String(row.id)));
  const usedProjects = new Set(projects.map((row) => String(row.id)));
  for (let value = 800; value <= 899; value += 1) {
    const suffix = String(value).padStart(3, "0");
    const companyId = `c-${suffix}`;
    const projectId = `p-${suffix}`;
    if (!usedCompanies.has(companyId) && !usedProjects.has(projectId)) return { companyId, projectId };
  }
  throw new Error("没有可用的 MCP 测试项目编号");
}

test("OPC MCP stdio server discovers and runs authorized read tools", async () => {
  await migrate();
  const database = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const { companyId, projectId } = await unusedProjectPair(database);
  const createdAt = "2026-10-13 14:00:00.000";
  let workflowId = "";
  let workspaceRoot = "";
  const connection = await createOpcMcpConnection();
  try {
    await database.query("INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)", [
      companyId,
      "MCP 集成测试公司",
      createdAt,
    ]);
    await database.query("INSERT INTO projects (id, company_id, name, created_at) VALUES (?, ?, ?, ?)", [
      projectId,
      companyId,
      "MCP 集成测试项目",
      createdAt,
    ]);
    for (const roleId of ["planner", "engineer"]) {
      await database.query(
        "INSERT INTO project_members (project_id, role_id, created_at) VALUES (?, ?, ?)",
        [projectId, roleId, createdAt],
      );
    }
    const view = await createCollaborationWorkflow({
      projectId,
      title: "读取项目文件",
      requestText: "读取项目说明",
      coordinatorRoleId: "planner",
      workItems: [
        {
          key: "read",
          title: "读取说明",
          objective: "读取 notes.txt",
          acceptance: ["返回文件内容和哈希"],
          ownerRoleId: "engineer",
          reviewerRoleId: "planner",
        },
        {
          key: "review-notes",
          title: "复核说明",
          objective: "并行复核 notes.txt",
          acceptance: ["确认说明内容"],
          ownerRoleId: "planner",
        },
      ],
    });
    workflowId = view.workflow.id;
    const workItemId = view.items.find((item) => item.ownerRoleId === "engineer")!.id;
    const plannerItemId = view.items.find((item) => item.ownerRoleId === "planner")!.id;
    workspaceRoot = path.resolve("workspaces", companyId, projectId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "notes.txt"), "mcp works\n", "utf8");

    const tools = await connection.client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "opc.project.get_diff",
        "opc.project.list_changes",
        "opc.project.list_files",
        "opc.project.read_file",
        "opc.project.stage_write",
        "opc.validation.run",
        "opc.workflow.get_context",
        "opc.workflow.request_decision",
      ],
    );

    const context = { workflowId, workItemId, roleId: "engineer" };
    const listed = await connection.client.callTool({
      name: "opc.project.list_files",
      arguments: { ...context, path: ".", depth: 2 },
    });
    assert.equal(listed.isError, undefined);
    assert.deepEqual(
      (listed.structuredContent as { entries?: { path: string }[] }).entries?.map((entry) => entry.path),
      ["notes.txt"],
    );

    const read = await connection.client.callTool({
      name: "opc.project.read_file",
      arguments: { ...context, path: "notes.txt" },
    });
    assert.equal(read.isError, undefined);
    assert.equal((read.structuredContent as { content?: string }).content, "mcp works\n");
    const formalSha = (read.structuredContent as { sha256?: string }).sha256!;

    const workflowContext = await connection.client.callTool({
      name: "opc.workflow.get_context",
      arguments: { ...context, roleId: "planner" },
    });
    assert.equal(workflowContext.isError, undefined);
    assert.equal(
      (workflowContext.structuredContent as { workflow?: { id?: string } }).workflow?.id,
      workflowId,
    );

    await claimWorkItem(workItemId, "engineer");
    await claimWorkItem(plannerItemId, "planner");
    const builtInValidation = await connection.client.callTool({
      name: "opc.validation.run",
      arguments: { ...context, profile: "default" },
    });
    assert.equal(builtInValidation.isError, undefined);
    assert.equal((builtInValidation.structuredContent as { exitCode?: number }).exitCode, 0);
    await fs.writeFile(
      path.join(workspaceRoot, "opc-validation.json"),
      JSON.stringify(
        {
          profiles: {
            "staged-check": {
              command: [
                process.execPath,
                "-e",
                "process.stdout.write(require('node:fs').readFileSync('notes.txt','utf8'))",
              ],
              timeoutSeconds: 10,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const staged = await connection.client.callTool({
      name: "opc.project.stage_write",
      arguments: { ...context, path: "notes.txt", content: "staged by mcp\n", baseSha256: formalSha },
    });
    assert.equal(staged.isError, undefined);
    assert.equal(await fs.readFile(path.join(workspaceRoot, "notes.txt"), "utf8"), "mcp works\n");

    const stagedFrontend = await connection.client.callTool({
      name: "opc.project.stage_write",
      arguments: {
        ...context,
        path: "frontend/index.html",
        content: "<!doctype html><html><body>staged</body></html>\n",
        baseSha256: null,
      },
    });
    assert.equal(stagedFrontend.isError, undefined);
    const stagedDirectory = await connection.client.callTool({
      name: "opc.project.list_files",
      arguments: { ...context, path: "frontend", depth: 2 },
    });
    assert.equal(stagedDirectory.isError, undefined);
    assert.deepEqual(
      (stagedDirectory.structuredContent as { entries?: { path: string }[] }).entries?.map((entry) => entry.path),
      ["frontend/index.html"],
    );

    const changes = await connection.client.callTool({
      name: "opc.project.list_changes",
      arguments: context,
    });
    assert.equal((changes.structuredContent as { changes?: unknown[] }).changes?.length, 2);

    const diff = await connection.client.callTool({
      name: "opc.project.get_diff",
      arguments: { ...context, path: "notes.txt" },
    });
    assert.match((diff.structuredContent as { diff?: string }).diff ?? "", /\+staged by mcp/);

    const leaseDenied = await connection.client.callTool({
      name: "opc.project.stage_write",
      arguments: {
        workflowId,
        workItemId: plannerItemId,
        roleId: "planner",
        path: "notes.txt",
        content: "planner overwrite\n",
        baseSha256: (staged.structuredContent as { afterSha256?: string }).afterSha256,
      },
    });
    assert.equal(leaseDenied.isError, true);

    const validation = await connection.client.callTool({
      name: "opc.validation.run",
      arguments: { ...context, profile: "staged-check" },
    });
    assert.equal(validation.isError, undefined);
    assert.equal((validation.structuredContent as { stdout?: string }).stdout, "staged by mcp\n");
    assert.equal((validation.structuredContent as { exitCode?: number }).exitCode, 0);

    const denied = await connection.client.callTool({
      name: "opc.project.read_file",
      arguments: { ...context, roleId: "researcher", path: "notes.txt" },
    });
    assert.equal(denied.isError, true);

    const decision = await connection.client.callTool({
      name: "opc.workflow.request_decision",
      arguments: {
        ...context,
        scope: "current",
        question: "采用哪个说明标题？",
        options: [
          { id: "a", label: "MCP 说明", impact: "保持当前范围" },
          { id: "b", label: "工具说明", impact: "表达更宽泛" },
        ],
        recommendation: "a",
        reason: "需要老板确认产品用语。",
      },
    });
    assert.equal(decision.isError, undefined);
    const [decisionRows] = await database.query<RowDataPacket[]>(
      "SELECT blocking_work_item_ids FROM project_decision_requests WHERE workflow_id = ?",
      [workflowId],
    );
    const blockingIds =
      typeof decisionRows[0]?.blocking_work_item_ids === "string"
        ? JSON.parse(decisionRows[0].blocking_work_item_ids)
        : decisionRows[0]?.blocking_work_item_ids;
    assert.deepEqual(blockingIds, [workItemId]);

    const audited = await callOpcMcpTool({
      name: "opc.workflow.get_context",
      context,
    });
    assert.equal(audited.isError, undefined);
    const [auditRows] = await database.query<RowDataPacket[]>(
      `SELECT status, policy_result, arguments_summary, result_summary
       FROM mcp_tool_calls WHERE workflow_id = ? ORDER BY id`,
      [workflowId],
    );
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0]?.status, "succeeded");
    assert.equal(auditRows[0]?.policy_result, "allow");
    const [toolEvents] = await database.query<RowDataPacket[]>(
      `SELECT kind FROM project_events
       WHERE workflow_id = ? AND kind IN ('tool_call', 'tool_result') ORDER BY id`,
      [workflowId],
    );
    assert.deepEqual(toolEvents.map((row) => row.kind), ["tool_call", "tool_result"]);
  } finally {
    await connection.close();
    await closeOpcMcpConnection();
    if (workflowId) {
      await database.query("DELETE FROM mcp_tool_calls WHERE workflow_id = ?", [workflowId]);
      await database.query("DELETE FROM project_events WHERE workflow_id = ?", [workflowId]);
      await database.query("DELETE FROM project_decision_requests WHERE workflow_id = ?", [workflowId]);
      await database.query(
        `DELETE dependency FROM project_work_item_dependencies dependency
         INNER JOIN project_work_items item ON item.id = dependency.work_item_id
         WHERE item.workflow_id = ?`,
        [workflowId],
      );
      await database.query("DELETE FROM project_work_items WHERE workflow_id = ?", [workflowId]);
      await database.query("DELETE FROM project_workflows WHERE id = ?", [workflowId]);
    }
    await database.query("DELETE FROM project_members WHERE project_id = ?", [projectId]);
    await database.query("DELETE FROM project_event_backfill_state WHERE project_id = ?", [projectId]);
    await database.query("DELETE FROM projects WHERE id = ?", [projectId]);
    await database.query("DELETE FROM companies WHERE id = ?", [companyId]);
    await database.end();
    if (workspaceRoot) await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

