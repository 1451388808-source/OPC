import assert from "node:assert/strict";
import test from "node:test";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import {
  claimWorkItem,
  createCollaborationWorkflow,
  loadCollaborationWorkflow,
  submitWorkItemForReview,
} from "../../lib/application/collaboration.ts";
import {
  driveCollaborationWorkflow,
  type CollaborationRunnerDependencies,
  type WorkItemExecutionResult,
} from "../../lib/collaboration/agent-runner.ts";
import { closePool, databaseConfig, migrate } from "../../lib/infrastructure/db.ts";

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
  throw new Error("没有可用的复核测试项目编号");
}

async function setUpWorkflow(connection: Connection): Promise<string> {
  const { companyId, projectId } = await unusedProjectPair(connection);
  const createdAt = "2026-10-16 09:00:00.000";
  await connection.query("INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)", [
    companyId,
    "复核测试公司",
    createdAt,
  ]);
  await connection.query("INSERT INTO projects (id, company_id, name, created_at) VALUES (?, ?, ?, ?)", [
    projectId,
    companyId,
    "复核测试项目",
    createdAt,
  ]);
  for (const roleId of ["planner", "engineer"]) {
    await connection.query(
      "INSERT INTO project_members (project_id, role_id, created_at) VALUES (?, ?, ?)",
      [projectId, roleId, createdAt],
    );
  }
  const view = await createCollaborationWorkflow({
    projectId,
    title: "复核结论路径测试",
    requestText: "验证复核三种结论都能正确驱动工作项状态",
    coordinatorRoleId: "planner",
    workItems: [
      {
        key: "work",
        title: "完成一个产出",
        objective: "完成一个可检查的产出",
        acceptance: ["产出存在"],
        ownerRoleId: "engineer",
        reviewerRoleId: "planner",
      },
    ],
  });
  return view.workflow.id;
}

async function cleanUpWorkflow(connection: Connection, workflowId: string, projectId: string): Promise<void> {
  await connection.query("DELETE FROM project_decision_requests WHERE workflow_id = ?", [workflowId]);
  await connection.query("DELETE FROM workflow_artifacts WHERE workflow_id = ?", [workflowId]);
  await connection.query(
    `DELETE source FROM project_event_sources source
     INNER JOIN project_events event ON event.id = source.project_event_id
     WHERE event.workflow_id = ?`,
    [workflowId],
  );
  await connection.query("DELETE FROM project_events WHERE workflow_id = ?", [workflowId]);
  await connection.query(
    `DELETE dependency FROM project_work_item_dependencies dependency
     INNER JOIN project_work_items item ON item.id = dependency.work_item_id
     WHERE item.workflow_id = ?`,
    [workflowId],
  );
  await connection.query("DELETE FROM project_work_items WHERE workflow_id = ?", [workflowId]);
  await connection.query("DELETE FROM project_workflows WHERE id = ?", [workflowId]);
  await connection.query("DELETE FROM project_members WHERE project_id = ?", [projectId]);
  await connection.query(
    `DELETE source FROM project_event_sources source
     INNER JOIN project_events event ON event.id = source.project_event_id
     WHERE event.project_id = ?`,
    [projectId],
  );
  await connection.query("DELETE FROM project_events WHERE project_id = ?", [projectId]);
}

const fakeExecute = async (): Promise<WorkItemExecutionResult> => ({
  summary: "已完成产出",
  evidence: ["已创建 output.txt"],
});

test("a work item with a legacy reviewer completes without AI review and waits for owner approval", async () => {
  await migrate();
  const connection = await mysql.createConnection({ ...databaseConfig(), dateStrings: true, charset: "utf8mb4" });
  let workflowId = "";
  try {
    workflowId = await setUpWorkflow(connection);
    const projectId = (await loadCollaborationWorkflow(workflowId)).workflow.projectId;
    const dependencies: CollaborationRunnerDependencies = {
      execute: fakeExecute,
    };
    await driveCollaborationWorkflow(workflowId, dependencies);
    const view = await loadCollaborationWorkflow(workflowId);
    assert.equal(view.items[0]?.status, "done");
    assert.equal(view.workflow.status, "review");
    assert.equal(view.events.some((event) => event.kind === "return"), false);
    assert.equal(view.events.some((event) => event.kind === "review_submitted" && event.workItemId !== null), false);
    await cleanUpWorkflow(connection, workflowId, projectId);
    workflowId = "";
  } finally {
    if (workflowId) {
      const projectId = (await loadCollaborationWorkflow(workflowId)).workflow.projectId;
      await cleanUpWorkflow(connection, workflowId, projectId);
    }
    await connection.end();
  }
});

test("old retry counts do not restart or block work when AI review is disabled", async () => {
  await migrate();
  const connection = await mysql.createConnection({ ...databaseConfig(), dateStrings: true, charset: "utf8mb4" });
  let workflowId = "";
  try {
    workflowId = await setUpWorkflow(connection);
    const projectId = (await loadCollaborationWorkflow(workflowId)).workflow.projectId;
    const itemId = (await loadCollaborationWorkflow(workflowId)).items[0]!.id;
    await connection.query("UPDATE project_work_items SET retry_count = 10 WHERE id = ?", [itemId]);
    let executionCalls = 0;
    const dependencies: CollaborationRunnerDependencies = {
      async execute() {
        executionCalls += 1;
        return fakeExecute();
      },
    };
    await driveCollaborationWorkflow(workflowId, dependencies);
    const view = await loadCollaborationWorkflow(workflowId);
    assert.equal(executionCalls, 1);
    assert.equal(view.items[0]?.status, "done");
    assert.equal(view.items[0]?.retryCount, 10);
    assert.equal(view.workflow.status, "review");
    await cleanUpWorkflow(connection, workflowId, projectId);
    workflowId = "";
  } finally {
    if (workflowId) {
      const projectId = (await loadCollaborationWorkflow(workflowId)).workflow.projectId;
      await cleanUpWorkflow(connection, workflowId, projectId);
    }
    await connection.end();
  }
});

test("a work item already awaiting AI review resumes without another model call", async () => {
  await migrate();
  const connection = await mysql.createConnection({ ...databaseConfig(), dateStrings: true, charset: "utf8mb4" });
  let workflowId = "";
  try {
    workflowId = await setUpWorkflow(connection);
    const projectId = (await loadCollaborationWorkflow(workflowId)).workflow.projectId;
    const itemId = (await loadCollaborationWorkflow(workflowId)).items[0]!.id;
    await claimWorkItem(itemId, "engineer");
    await submitWorkItemForReview({
      workItemId: itemId,
      roleId: "engineer",
      summary: "已完成产出",
      evidence: ["已创建 output.txt"],
    });
    let executionCalls = 0;
    await driveCollaborationWorkflow(workflowId, {
      async execute() {
        executionCalls += 1;
        return fakeExecute();
      },
    });
    const view = await loadCollaborationWorkflow(workflowId);
    assert.equal(executionCalls, 0);
    assert.equal(view.items[0]?.status, "done");
    assert.equal(view.workflow.status, "review");
    await cleanUpWorkflow(connection, workflowId, projectId);
    workflowId = "";
  } finally {
    if (workflowId) {
      const projectId = (await loadCollaborationWorkflow(workflowId)).workflow.projectId;
      await cleanUpWorkflow(connection, workflowId, projectId);
    }
    await connection.end();
  }
});

