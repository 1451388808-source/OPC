import assert from "node:assert/strict";
import test from "node:test";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import {
  approveCollaborationWorkflow,
  claimWorkItem,
  createCollaborationWorkflow,
  handoffWorkItem,
  loadCollaborationWorkflow,
  requestWorkflowDecision,
  retryFailedWorkflow,
  resumeRecoverableWorkflowBlocks,
  resolveWorkflowDecision,
  returnCollaborationWorkflow,
  reviewWorkItem,
  submitWorkflowForReview,
  submitWorkItemForReview,
} from "../../lib/application/collaboration.ts";
import {
  driveCollaborationWorkflow,
  recoverCollaborationWorkflows,
} from "../../lib/collaboration/agent-runner.ts";
import { saveProjectMessageToTimeline } from "../../lib/application/org.ts";
import { ensureProjectEventHistory } from "../../lib/application/project-event.ts";
import { closePool, databaseConfig, migrate } from "../../lib/infrastructure/db.ts";
import { ToolExecutionError } from "../../lib/mcp/error.ts";

test.after(async () => {
  await closePool();
});

async function unusedProjectPair(connection: Connection): Promise<{ companyId: string; projectId: string }> {
  const [companies] = await connection.query<RowDataPacket[]>("SELECT id FROM companies");
  const [projects] = await connection.query<RowDataPacket[]>("SELECT id FROM projects");
  const usedCompanies = new Set(companies.map((row) => String(row.id)));
  const usedProjects = new Set(projects.map((row) => String(row.id)));
  for (let value = 900; value <= 999; value += 1) {
    const suffix = String(value).padStart(3, "0");
    const companyId = `c-${suffix}`;
    const projectId = `p-${suffix}`;
    if (!usedCompanies.has(companyId) && !usedProjects.has(projectId)) return { companyId, projectId };
  }
  throw new Error("没有可用的协作测试项目编号");
}

test("two fake agents complete dependent work and submit one workflow for final review", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const { companyId, projectId } = await unusedProjectPair(connection);
  const createdAt = "2026-10-13 13:00:00.000";
  let workflowId = "";
  try {
    await connection.query("INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)", [
      companyId,
      "协作集成测试公司",
      createdAt,
    ]);
    await connection.query("INSERT INTO projects (id, company_id, name, created_at) VALUES (?, ?, ?, ?)", [
      projectId,
      companyId,
      "协作集成测试项目",
      createdAt,
    ]);
    for (const roleId of ["planner", "researcher", "engineer"]) {
      await connection.query(
        "INSERT INTO project_members (project_id, role_id, created_at) VALUES (?, ?, ?)",
        [projectId, roleId, createdAt],
      );
    }

    const [legacyResult] = await connection.query(
      `INSERT INTO project_messages (project_id, speaker, role_id, body, created_at)
       VALUES (?, 'boss', NULL, '并发回填测试', '2026-10-13 13:00:30.000')`,
      [projectId],
    );
    const legacyMessageId = Number((legacyResult as { insertId?: number }).insertId ?? 0);
    await Promise.all([ensureProjectEventHistory(projectId), ensureProjectEventHistory(projectId)]);
    const [legacySources] = await connection.query<RowDataPacket[]>(
      `SELECT project_event_id FROM project_event_sources
       WHERE source_type = 'project_message' AND source_id = ?`,
      [String(legacyMessageId)],
    );
    assert.equal(legacySources.length, 1);

    const savedMessage = await saveProjectMessageToTimeline({
      projectId,
      speaker: "boss",
      roleId: "",
      storedBody: "先确认约定，再实现健康检查。",
      publicText: "先确认约定，再实现健康检查。",
      createdAt: "2026-10-13T13:01:00+08:00",
    });
    const [mirroredRows] = await connection.query<RowDataPacket[]>(
      `SELECT message.id AS message_id, event.id AS event_id, source.source_type
       FROM project_messages message
       INNER JOIN project_event_sources source
         ON source.source_type = 'project_message'
        AND source.source_id = CONVERT(message.id, CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
       INNER JOIN project_events event ON event.id = source.project_event_id
       WHERE message.id = ? AND event.project_id = ?`,
      [savedMessage.messageId, projectId],
    );
    assert.equal(mirroredRows.length, 1);
    assert.equal(Number(mirroredRows[0]?.event_id), savedMessage.eventId);

    let view = await createCollaborationWorkflow({
      projectId,
      title: "实现健康检查",
      requestText: "先确认现有约定，再实现健康检查并补测试",
      coordinatorRoleId: "planner",
      workItems: [
        {
          key: "research",
          title: "确认接口约定",
          objective: "读取项目约定并给出健康检查接口建议",
          acceptance: ["形成带证据的接口结论"],
          ownerRoleId: "researcher",
          reviewerRoleId: "planner",
        },
        {
          key: "implementation",
          title: "实现并验证",
          objective: "根据研究结论实现接口和测试",
          acceptance: ["实现文件已暂存", "测试通过"],
          ownerRoleId: "engineer",
          reviewerRoleId: "planner",
          dependsOn: ["research"],
        },
      ],
    });
    workflowId = view.workflow.id;
    const research = view.items[0]!;
    const implementation = view.items[1]!;
    assert.equal(view.workflow.status, "collaborating");
    assert.deepEqual(view.items.map((item) => item.status), ["ready", "queued"]);

    await assert.rejects(() => claimWorkItem(research.id, "engineer"), /只有主责员工/);
    assert.equal((await claimWorkItem(research.id, "researcher")).status, "running");
    const decision = await requestWorkflowDecision({
      workflowId,
      workItemId: research.id,
      askedByRoleId: "researcher",
      question: "健康检查路径使用哪一个？",
      options: [
        { id: "health", label: "/health", impact: "沿用常见约定" },
        { id: "status", label: "/status", impact: "名称更直观" },
      ],
      recommendation: "health",
      reason: "项目没有已有路径决定",
      blockingWorkItemIds: [research.id],
    });
    assert.equal(decision.workflowStatus, "waiting_user");
    assert.equal((await loadCollaborationWorkflow(workflowId)).items[0]?.status, "blocked");
    const resolved = await resolveWorkflowDecision({ decisionId: decision.decisionId, answer: "health：/health" });
    assert.equal(resolved.workflowStatus, "collaborating");
    assert.equal((await loadCollaborationWorkflow(workflowId)).items[0]?.status, "ready");
    assert.equal((await claimWorkItem(research.id, "researcher")).status, "running");
    view = await submitWorkItemForReview({
      workItemId: research.id,
      roleId: "researcher",
      summary: "确认使用 /health 和 200 响应",
      evidence: ["README 中已有 /health 约定"],
    });
    assert.equal(view.items[0]?.status, "review");

    view = await reviewWorkItem({
      workItemId: research.id,
      reviewerRoleId: "planner",
      approved: true,
    });
    assert.deepEqual(view.items.map((item) => item.status), ["done", "ready"]);

    let handedOff = await handoffWorkItem({
      workItemId: implementation.id,
      fromRoleId: "engineer",
      toRoleId: "researcher",
      reason: "研究员工先补充接口示例",
    });
    assert.equal(handedOff.ownerRoleId, "researcher");
    handedOff = await handoffWorkItem({
      workItemId: implementation.id,
      fromRoleId: "researcher",
      toRoleId: "engineer",
      reason: "示例已补齐，交回工程实现",
    });
    assert.equal(handedOff.ownerRoleId, "engineer");

    const claims = await Promise.allSettled([
      claimWorkItem(implementation.id, "engineer"),
      claimWorkItem(implementation.id, "engineer"),
    ]);
    assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(claims.filter((result) => result.status === "rejected").length, 1);
    view = await submitWorkItemForReview({
      workItemId: implementation.id,
      roleId: "engineer",
      summary: "接口和测试已经完成",
      evidence: ["npm test: 12 passed", "修改 app/health.ts"],
    });
    view = await reviewWorkItem({
      workItemId: implementation.id,
      reviewerRoleId: "planner",
      approved: true,
    });
    assert.equal(view.workflow.status, "verifying");
    assert.equal(view.items.every((item) => item.status === "done"), true);

    view = await submitWorkflowForReview({
      workflowId,
      coordinatorRoleId: "planner",
      summary: "研究、实现和测试均已完成，提交老板验收。",
    });
    assert.equal(view.workflow.status, "review");
    assert.equal(view.events.some((event) => event.kind === "review_submitted"), true);
    assert.equal(view.events.some((event) => event.kind === "workflow_status"), true);
    assert.deepEqual(await approveCollaborationWorkflow(workflowId), { paths: [], exportWarning: null });
    assert.equal((await loadCollaborationWorkflow(workflowId)).workflow.status, "approved");
  } finally {
    if (workflowId) {
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
    }
    await connection.query("DELETE FROM project_members WHERE project_id = ?", [projectId]);
    await connection.query(
      `DELETE source FROM project_event_sources source
       INNER JOIN project_events event ON event.id = source.project_event_id
       WHERE event.project_id = ?`,
      [projectId],
    );
    await connection.query("DELETE FROM project_events WHERE project_id = ?", [projectId]);
    await connection.query("DELETE FROM project_messages WHERE project_id = ?", [projectId]);
    await connection.query("DELETE FROM project_event_backfill_state WHERE project_id = ?", [projectId]);
    await connection.query("DELETE FROM projects WHERE id = ?", [projectId]);
    await connection.query("DELETE FROM companies WHERE id = ?", [companyId]);
    await connection.end();
  }
});

test("a work item cannot have two open decision requests at once", async () => {
  await migrate();
  const connection = await mysql.createConnection({ ...databaseConfig(), dateStrings: true, charset: "utf8mb4" });
  const { companyId, projectId } = await unusedProjectPair(connection);
  const createdAt = "2026-10-16 09:00:00.000";
  let workflowId = "";
  try {
    await connection.query("INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)", [
      companyId,
      "重复待决问题测试公司",
      createdAt,
    ]);
    await connection.query("INSERT INTO projects (id, company_id, name, created_at) VALUES (?, ?, ?, ?)", [
      projectId,
      companyId,
      "重复待决问题测试项目",
      createdAt,
    ]);
    for (const roleId of ["planner", "researcher", "engineer"]) {
      await connection.query("INSERT INTO project_members (project_id, role_id, created_at) VALUES (?, ?, ?)", [
        projectId,
        roleId,
        createdAt,
      ]);
    }
    const created = await createCollaborationWorkflow({
      projectId,
      title: "重复待决问题",
      requestText: "验证同一个工作项不能同时存在两个未解决的待决问题",
      coordinatorRoleId: "planner",
      workItems: [
        {
          key: "research",
          title: "研究",
          objective: "形成结论",
          acceptance: ["有研究证据"],
          ownerRoleId: "researcher",
          reviewerRoleId: "planner",
        },
        {
          key: "implement",
          title: "独立实现",
          objective: "完成一个不依赖研究的实现",
          acceptance: ["有实现证据"],
          ownerRoleId: "engineer",
          reviewerRoleId: "planner",
        },
      ],
    });
    workflowId = created.workflow.id;
    const research = created.items[0]!;
    await claimWorkItem(research.id, "researcher");
    const first = await requestWorkflowDecision({
      workflowId,
      workItemId: research.id,
      askedByRoleId: "researcher",
      question: "健康检查路径使用哪一个？",
      options: [
        { id: "health", label: "/health", impact: "沿用常见约定" },
        { id: "status", label: "/status", impact: "名称更直观" },
      ],
      recommendation: "health",
      reason: "项目没有已有路径决定",
      blockingWorkItemIds: [research.id],
    });
    assert.equal(first.workflowStatus, "collaborating");
    await assert.rejects(
      () =>
        requestWorkflowDecision({
          workflowId,
          workItemId: research.id,
          askedByRoleId: "researcher",
          question: "换个问法问同一件事",
          options: [
            { id: "health", label: "/health", impact: "沿用常见约定" },
            { id: "status", label: "/status", impact: "名称更直观" },
          ],
          recommendation: "health",
          reason: "重复提交",
          blockingWorkItemIds: [research.id],
        }),
      /已经有一个待决问题/,
    );
    await resolveWorkflowDecision({ decisionId: first.decisionId, answer: "health：/health" });
  } finally {
    if (workflowId) {
      await connection.query("DELETE FROM project_decision_requests WHERE workflow_id = ?", [workflowId]);
      await connection.query(
        `DELETE dependency FROM project_work_item_dependencies dependency
         INNER JOIN project_work_items item ON item.id = dependency.work_item_id
         WHERE item.workflow_id = ?`,
        [workflowId],
      );
      await connection.query("DELETE FROM project_events WHERE workflow_id = ?", [workflowId]);
      await connection.query("DELETE FROM project_work_items WHERE workflow_id = ?", [workflowId]);
      await connection.query("DELETE FROM project_workflows WHERE id = ?", [workflowId]);
    }
    await connection.query("DELETE FROM project_members WHERE project_id = ?", [projectId]);
    await connection.query("DELETE FROM project_event_backfill_state WHERE project_id = ?", [projectId]);
    await connection.query("DELETE FROM projects WHERE id = ?", [projectId]);
    await connection.query("DELETE FROM companies WHERE id = ?", [companyId]);
    await connection.end();
  }
});

test("workflow driver executes dependent fake agents and submits final review", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const { companyId, projectId } = await unusedProjectPair(connection);
  const createdAt = "2026-10-13 13:30:00.000";
  let workflowId = "";
  try {
    await connection.query("INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)", [companyId, "驱动测试公司", createdAt]);
    await connection.query("INSERT INTO projects (id, company_id, name, created_at) VALUES (?, ?, ?, ?)", [
      projectId,
      companyId,
      "驱动测试项目",
      createdAt,
    ]);
    for (const roleId of ["planner", "researcher", "engineer"]) {
      await connection.query(
        "INSERT INTO project_members (project_id, role_id, created_at) VALUES (?, ?, ?)",
        [projectId, roleId, createdAt],
      );
    }
    const created = await createCollaborationWorkflow({
      projectId,
      title: "自动协作",
      requestText: "先研究再实现",
      coordinatorRoleId: "planner",
      workItems: [
        {
          key: "research",
          title: "研究",
          objective: "形成结论",
          acceptance: ["有研究证据"],
          ownerRoleId: "researcher",
          reviewerRoleId: "planner",
        },
        {
          key: "implement",
          title: "实现",
          objective: "完成实现",
          acceptance: ["有实现证据"],
          ownerRoleId: "engineer",
          reviewerRoleId: "planner",
          dependsOn: ["research"],
        },
      ],
    });
    workflowId = created.workflow.id;
    await claimWorkItem(created.items[0]!.id, "researcher");
    const recovered: string[] = [];
    await recoverCollaborationWorkflows((id) => recovered.push(id), workflowId);
    assert.equal(recovered.includes(workflowId), true);
    assert.equal((await loadCollaborationWorkflow(workflowId)).items[0]?.status, "ready");
    const executionOrder: string[] = [];
    await driveCollaborationWorkflow(workflowId, {
      async execute({ item }) {
        executionOrder.push(item.ownerRoleId);
        return { summary: `${item.title}完成`, evidence: [`${item.id}:evidence`] };
      },
    });

    const result = await loadCollaborationWorkflow(workflowId);
    assert.deepEqual(executionOrder, ["researcher", "engineer"]);
    assert.equal(result.workflow.status, "review");
    assert.equal(result.items.every((item) => item.status === "done"), true);
    const returned = await returnCollaborationWorkflow(workflowId, "补充失败场景");
    const afterReturn = await loadCollaborationWorkflow(workflowId);
    assert.equal(afterReturn.workflow.status, "collaborating");
    assert.equal(afterReturn.items.find((item) => item.id === returned.correctionWorkItemId)?.status, "ready");
  } finally {
    if (workflowId) {
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
    await connection.query("DELETE FROM project_members WHERE project_id = ?", [projectId]);
    await connection.query("DELETE FROM project_event_backfill_state WHERE project_id = ?", [projectId]);
    await connection.query("DELETE FROM projects WHERE id = ?", [projectId]);
    await connection.query("DELETE FROM companies WHERE id = ?", [companyId]);
    await connection.end();
  }
});

test("workflow driver waits for an explicit retry after an execution failure", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const { companyId, projectId } = await unusedProjectPair(connection);
  const createdAt = "2026-10-14 01:00:00.000";
  let workflowId = "";
  try {
    await connection.query("INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)", [
      companyId,
      "返工上限测试公司",
      createdAt,
    ]);
    await connection.query("INSERT INTO projects (id, company_id, name, created_at) VALUES (?, ?, ?, ?)", [
      projectId,
      companyId,
      "返工上限测试项目",
      createdAt,
    ]);
    for (const roleId of ["planner", "engineer"]) {
      await connection.query(
        "INSERT INTO project_members (project_id, role_id, created_at) VALUES (?, ?, ?)",
        [projectId, roleId, createdAt],
      );
    }
    const created = await createCollaborationWorkflow({
      projectId,
      title: "返工上限",
      requestText: "验证达到返工上限后明确失败",
      coordinatorRoleId: "planner",
      workItems: [
        {
          key: "implement",
          title: "实现",
          objective: "完成实现",
          acceptance: ["有实现证据"],
          ownerRoleId: "engineer",
          reviewerRoleId: "planner",
        },
      ],
    });
    workflowId = created.workflow.id;
    let executionCalls = 0;

    await driveCollaborationWorkflow(workflowId, {
      async execute() {
        executionCalls += 1;
        throw new Error("执行失败");
      },
    });

    const result = await loadCollaborationWorkflow(workflowId);
    assert.equal(executionCalls, 1);
    assert.equal(result.items[0]?.status, "failed");
    assert.equal(result.workflow.status, "failed");
    assert.match(result.items[0]?.errorText ?? "", /执行失败/);
    assert.equal(await retryFailedWorkflow(workflowId), true);
    const recovered = await loadCollaborationWorkflow(workflowId);
    assert.equal(recovered.items[0]?.status, "ready");
    assert.equal(recovered.workflow.status, "collaborating");
    assert.equal(recovered.workflow.errorText, "");
    await driveCollaborationWorkflow(workflowId, {
      async execute() {
        executionCalls += 1;
        return { summary: "已完成", evidence: ["结果"] };
      },
    });
    assert.equal(executionCalls, 2);
    assert.equal((await loadCollaborationWorkflow(workflowId)).workflow.status, "review");
  } finally {
    if (workflowId) {
      await connection.query("DELETE FROM project_events WHERE workflow_id = ?", [workflowId]);
      await connection.query("DELETE FROM project_work_items WHERE workflow_id = ?", [workflowId]);
      await connection.query("DELETE FROM project_workflows WHERE id = ?", [workflowId]);
    }
    await connection.query("DELETE FROM project_members WHERE project_id = ?", [projectId]);
    await connection.query("DELETE FROM project_event_backfill_state WHERE project_id = ?", [projectId]);
    await connection.query("DELETE FROM projects WHERE id = ?", [projectId]);
    await connection.query("DELETE FROM companies WHERE id = ?", [companyId]);
    await connection.end();
  }
});

test("workflow driver blocks on missing validation configuration instead of failing", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const { companyId, projectId } = await unusedProjectPair(connection);
  const createdAt = "2026-10-14 01:10:00.000";
  let workflowId = "";
  try {
    await connection.query("INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)", [
      companyId,
      "缺验证配置测试公司",
      createdAt,
    ]);
    await connection.query("INSERT INTO projects (id, company_id, name, created_at) VALUES (?, ?, ?, ?)", [
      projectId,
      companyId,
      "缺验证配置测试项目",
      createdAt,
    ]);
    for (const roleId of ["planner", "engineer"]) {
      await connection.query(
        "INSERT INTO project_members (project_id, role_id, created_at) VALUES (?, ?, ?)",
        [projectId, roleId, createdAt],
      );
    }
    const created = await createCollaborationWorkflow({
      projectId,
      title: "缺验证配置",
      requestText: "实现页面并验证",
      coordinatorRoleId: "planner",
      workItems: [
        {
          key: "implement",
          title: "实现",
          objective: "完成实现并验证",
          acceptance: ["验证通过"],
          ownerRoleId: "engineer",
          reviewerRoleId: "planner",
        },
      ],
    });
    workflowId = created.workflow.id;

    await driveCollaborationWorkflow(workflowId, {
      async execute() {
        throw new ToolExecutionError({
          code: "missing_configuration",
          message: "找不到验证配置：node-check。可用 profile：default、docs、spec、frontend、static-site",
          retryable: false,
        });
      },
    });

    const result = await loadCollaborationWorkflow(workflowId);
    assert.equal(result.items[0]?.status, "blocked");
    assert.match(result.items[0]?.blockedReason ?? "", /missing_configuration/);
    assert.equal(result.workflow.status, "waiting_user");
    assert.equal(await resumeRecoverableWorkflowBlocks(workflowId), true);
    const resumed = await loadCollaborationWorkflow(workflowId);
    assert.equal(resumed.items[0]?.status, "ready");
    assert.equal(resumed.workflow.status, "collaborating");
  } finally {
    if (workflowId) {
      await connection.query("DELETE FROM project_events WHERE workflow_id = ?", [workflowId]);
      await connection.query("DELETE FROM project_work_items WHERE workflow_id = ?", [workflowId]);
      await connection.query("DELETE FROM project_workflows WHERE id = ?", [workflowId]);
    }
    await connection.query("DELETE FROM project_members WHERE project_id = ?", [projectId]);
    await connection.query("DELETE FROM project_event_backfill_state WHERE project_id = ?", [projectId]);
    await connection.query("DELETE FROM projects WHERE id = ?", [projectId]);
    await connection.query("DELETE FROM companies WHERE id = ?", [companyId]);
    await connection.end();
  }
});

