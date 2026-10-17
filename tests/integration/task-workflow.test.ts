import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import {
  approveCollaborationWorkflow,
  claimWorkItem,
  createCollaborationWorkflow,
  loadCollaborationWorkflow,
  reviewWorkItem,
  submitWorkflowForReview,
  submitWorkItemForReview,
} from "../../lib/application/collaboration.ts";
import { closePool, databaseConfig, migrate } from "../../lib/infrastructure/db.ts";
import { getTask, insertTask } from "../../lib/infrastructure/store.ts";
import { workflowWorkspace } from "../../lib/project-workspace/workflow-workspace.ts";

test.after(async () => {
  await closePool();
});

async function unusedIds(connection: Connection) {
  const [companies] = await connection.query<RowDataPacket[]>("SELECT id FROM companies");
  const [projects] = await connection.query<RowDataPacket[]>("SELECT id FROM projects");
  const [tasks] = await connection.query<RowDataPacket[]>("SELECT id FROM tasks");
  const usedCompanies = new Set(companies.map((row) => String(row.id)));
  const usedProjects = new Set(projects.map((row) => String(row.id)));
  const usedTasks = new Set(tasks.map((row) => String(row.id)));
  for (let value = 700; value <= 799; value += 1) {
    const suffix = String(value).padStart(3, "0");
    const companyId = `c-${suffix}`;
    const projectId = `p-${suffix}`;
    const taskId = `t-${suffix}`;
    if (!usedCompanies.has(companyId) && !usedProjects.has(projectId) && !usedTasks.has(taskId)) {
      return { companyId, projectId, taskId };
    }
  }
  throw new Error("没有可用的任务 workflow 测试编号");
}

test("task workflow applies files and approves the task in one action", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const { companyId, projectId, taskId } = await unusedIds(connection);
  const now = "2026-10-13T16:00:00+08:00";
  let workflowId = "";
  const formalFile = path.resolve("workspaces", companyId, projectId, "result.txt");
  try {
    await connection.query("INSERT INTO companies (id, name, created_at) VALUES (?, ?, '2026-10-13 16:00:00.000')", [companyId, "任务协作测试公司"]);
    await connection.query(
      "INSERT INTO projects (id, company_id, name, created_at) VALUES (?, ?, ?, '2026-10-13 16:00:00.000')",
      [projectId, companyId, "任务协作测试项目"],
    );
    for (const roleId of ["planner", "engineer"]) {
      await connection.query(
        "INSERT INTO project_members (project_id, role_id, created_at) VALUES (?, ?, '2026-10-13 16:00:00.000')",
        [projectId, roleId],
      );
    }
    await insertTask(connection, {
      id: taskId,
      title: "团队协作任务",
      brief: "创建结果文件",
      goal: "项目中存在 result.txt",
      acceptance: ["result.txt 内容为 done"],
      role: "planner",
      status: "inbox",
      priority: "now",
      artifacts: [],
      notes: "",
      needsApproval: true,
      blockReason: "",
      decision: null,
      createdAt: now,
      updatedAt: now,
    });

    let view = await createCollaborationWorkflow({
      projectId,
      taskId,
      title: "团队协作任务",
      requestText: "创建 result.txt",
      coordinatorRoleId: "planner",
      workItems: [
        {
          key: "implement",
          title: "创建结果",
          objective: "创建 result.txt",
          acceptance: ["文件内容为 done"],
          ownerRoleId: "engineer",
          reviewerRoleId: "planner",
        },
      ],
    });
    workflowId = view.workflow.id;
    assert.equal((await getTask(connection, taskId))?.status, "doing");
    const item = view.items[0]!;
    await claimWorkItem(item.id, "engineer");
    await workflowWorkspace({ companyId, projectId, workflowId }).write({
      path: "result.txt",
      content: "done\n",
      baseSha256: null,
      workItemId: item.id,
      roleId: "engineer",
      updatedAt: now,
    });
    await submitWorkItemForReview({
      workItemId: item.id,
      roleId: "engineer",
      summary: "已创建 result.txt",
      evidence: ["result.txt"],
    });
    await reviewWorkItem({
      workItemId: item.id,
      reviewerRoleId: "planner",
      approved: true,
    });
    view = await submitWorkflowForReview({
      workflowId,
      coordinatorRoleId: "planner",
      summary: "文件已创建并复核。",
    });
    assert.equal(view.workflow.status, "review");
    assert.equal((await getTask(connection, taskId))?.status, "review");

    const approved = await approveCollaborationWorkflow(workflowId, "团队协作通过", false);
    assert.deepEqual(approved.paths, ["result.txt"]);
    assert.equal(await fs.readFile(formalFile, "utf8"), "done\n");
    assert.equal((await loadCollaborationWorkflow(workflowId)).workflow.status, "approved");
    assert.equal((await getTask(connection, taskId))?.status, "done");
  } finally {
    await fs.rm(formalFile, { force: true });
    if (workflowId) {
      await fs.rm(path.resolve(".opc", "workflows", workflowId), { recursive: true, force: true });
      await connection.query("DELETE FROM mcp_tool_calls WHERE workflow_id = ?", [workflowId]);
      await connection.query("DELETE FROM project_decision_requests WHERE workflow_id = ?", [workflowId]);
      await connection.query("DELETE FROM workflow_artifacts WHERE workflow_id = ?", [workflowId]);
      await connection.query("DELETE FROM project_events WHERE workflow_id = ?", [workflowId]);
      await connection.query(
        `DELETE dependency FROM project_work_item_dependencies dependency
         INNER JOIN project_work_items item ON item.id = dependency.work_item_id
         WHERE item.workflow_id = ?`,
        [workflowId],
      );
      await connection.query("DELETE FROM project_work_items WHERE workflow_id = ?", [workflowId]);
      await connection.query("DELETE FROM project_workflows WHERE id = ?", [workflowId]);
    }
    await connection.query("DELETE FROM tasks WHERE id = ?", [taskId]);
    await connection.query("DELETE FROM project_members WHERE project_id = ?", [projectId]);
    await connection.query("DELETE FROM project_event_backfill_state WHERE project_id = ?", [projectId]);
    await connection.query("DELETE FROM projects WHERE id = ?", [projectId]);
    await connection.query("DELETE FROM companies WHERE id = ?", [companyId]);
    await fs.rm(path.resolve("tasks", `${taskId}.json`), { force: true });
    await connection.end();
  }
});

