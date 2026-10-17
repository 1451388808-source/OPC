import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import type { ProjectEvent } from "../../lib/domain/collaboration.ts";
import {
  closeDecisionRequest,
  transitionWorkflow,
  transitionWorkItem,
  type ProjectWorkflow,
  type ProjectWorkItem,
  type ProjectDecisionRequest,
  type WorkflowArtifact,
} from "../../lib/domain/collaboration.ts";
import { closePool, databaseConfig, migrate } from "../../lib/infrastructure/db.ts";
import {
  appendProjectEvent,
  backfillLegacyProjectEvents,
  findActiveTaskWorkflow,
  getProjectWorkflow,
  getProjectWorkItem,
  getProjectDecisionRequest,
  insertProjectDecisionRequest,
  insertProjectWorkflow,
  insertProjectWorkItem,
  insertWorkflowArtifact,
  insertWorkItemDependencies,
  listProjectEvents,
  listRecentProjectEvents,
  listProjectWorkflows,
  listProjectWorkItems,
  listOpenWorkflowDecisionRequests,
  listWorkflowArtifacts,
  listWorkflowDependencies,
  listWorkflowEvents,
  updateProjectWorkflow,
  updateProjectWorkItem,
  updateProjectDecisionRequest,
} from "../../lib/infrastructure/collaboration-store.ts";

test.after(async () => {
  await closePool();
});

test("collaboration event store appends and incrementally reads an ordered project timeline", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const workflowId = `wf-${randomUUID()}`;
  const workItemId = `wi-${randomUUID()}`;
  const now = "2026-10-13T10:00:00+08:00";
  const base: Omit<ProjectEvent, "id" | "kind" | "body" | "actorType" | "actorId"> = {
    projectId: "p-001",
    workflowId,
    workItemId: null,
    createdAt: now,
  };

  await connection.beginTransaction();
  try {
    const first = await appendProjectEvent(connection, {
      ...base,
      workflowId: null,
      actorType: "boss",
      actorId: null,
      kind: "user_message",
      body: { text: "完成登录页并补测试" },
    });
    const second = await appendProjectEvent(connection, {
      ...base,
      actorType: "system",
      actorId: "collaboration-scheduler",
      kind: "workflow_created",
      body: { title: "完成登录页" },
    });
    const third = await appendProjectEvent(connection, {
      ...base,
      workItemId,
      actorType: "agent",
      actorId: "engineer",
      kind: "work_item_status",
      body: { status: "running" },
    });

    assert.equal(first < second && second < third, true);
    assert.deepEqual(
      (await listProjectEvents(connection, "p-001", first, 10)).map((event) => ({
        id: event.id,
        kind: event.kind,
        body: event.body,
      })),
      [
        { id: second, kind: "workflow_created", body: { title: "完成登录页" } },
        { id: third, kind: "work_item_status", body: { status: "running" } },
      ],
    );
    assert.deepEqual(
      (await listWorkflowEvents(connection, workflowId)).map((event) => event.id),
      [second, third],
    );
    assert.deepEqual(
      (await listRecentProjectEvents(connection, "p-001", 2)).map((event) => event.id),
      [second, third],
    );
  } finally {
    await connection.rollback();
    await connection.end();
  }
});

test("collaboration event store rejects invalid persisted input and unsafe page sizes", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  try {
    await assert.rejects(
      () =>
        appendProjectEvent(connection, {
          projectId: "outside",
          workflowId: null,
          workItemId: null,
          actorType: "boss",
          actorId: null,
          kind: "user_message",
          body: {},
          createdAt: "2026-10-13T10:00:00+08:00",
        }),
      /Invalid/,
    );
    await assert.rejects(() => listProjectEvents(connection, "p-001", 0, 501), /1 到 500/);
  } finally {
    await connection.end();
  }
});

test("legacy project messages and runs backfill once into the unified timeline", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const runId = `r-${randomUUID()}`;
  const projectId = "p-998";
  const now = "2026-10-13T11:00:00+08:00";

  await connection.beginTransaction();
  try {
    const [messageResult] = await connection.query(
      `INSERT INTO project_messages (project_id, speaker, role_id, body, created_at)
       VALUES (?, 'boss', NULL, ?, '2026-10-13 11:00:00.000')`,
      [projectId, "完成健康检查"],
    );
    const messageId = Number((messageResult as { insertId?: number }).insertId ?? 0);
    await connection.query(
      `INSERT INTO project_runs
        (id, project_id, task_id, role_id, request_text, status, summary, error_text, return_reason,
         created_at, updated_at, approved_at)
       VALUES (?, ?, NULL, 'engineer', '实现健康检查', 'running', '', '', '',
               '2026-10-13 11:01:00.000', '2026-10-13 11:01:00.000', NULL)`,
      [runId, projectId],
    );
    const [runEventResult] = await connection.query(
      `INSERT INTO project_run_events (run_id, kind, body, created_at)
       VALUES (?, 'tool_call', ?, '2026-10-13 11:02:00.000')`,
      [runId, JSON.stringify({ name: "read_file" })],
    );
    const runEventId = Number((runEventResult as { insertId?: number }).insertId ?? 0);
    await connection.query(
      `INSERT INTO project_run_events (run_id, kind, body, created_at)
       VALUES (?, 'reasoning', ?, '2026-10-13 11:02:10.000'),
              (?, 'message', ?, '2026-10-13 11:02:20.000')`,
      [
        runId,
        JSON.stringify({ text: "先检查文件", delta: true }),
        runId,
        JSON.stringify({ text: "已经完成。", delta: true }),
      ],
    );

    assert.equal(await backfillLegacyProjectEvents(connection, projectId), 5);
    assert.equal(await backfillLegacyProjectEvents(connection, projectId), 0);

    await connection.query(
      `INSERT INTO project_messages (project_id, speaker, role_id, body, created_at)
       VALUES (?, 'boss', NULL, '增量消息', '2026-10-13 11:03:00.000')`,
      [projectId],
    );
    assert.equal(await backfillLegacyProjectEvents(connection, projectId), 1);

    const timeline = await listProjectEvents(connection, projectId);
    assert.deepEqual(
      timeline.map((event) => event.kind),
      ["user_message", "workflow_created", "tool_call", "agent_message", "agent_message", "user_message"],
    );
    assert.deepEqual(timeline[0]?.body, {
      text: "完成健康检查",
      legacy: { source: "project_messages", id: messageId },
    });
    assert.deepEqual(timeline[2]?.body, {
      legacyRunId: runId,
      legacyKind: "tool_call",
      hidden: false,
      value: { name: "read_file" },
    });
    assert.deepEqual(timeline[4]?.body, {
      legacyRunId: runId,
      legacyKind: "message",
      hidden: false,
      text: "已经完成。",
      delta: true,
    });
    assert.deepEqual(
      (await listRecentProjectEvents(connection, projectId, 10, false)).map((event) => event.id),
      timeline.filter((event) => (event.body as { hidden?: boolean }).hidden !== true).map((event) => event.id),
    );
    const [sourceRows] = await connection.query(
      `SELECT source_type, source_id FROM project_event_sources
       WHERE (source_type = 'project_message' AND source_id = ?)
          OR (source_type = 'project_run' AND source_id = ?)
          OR (source_type = 'project_run_event' AND source_id = ?)`,
      [String(messageId), runId, String(runEventId)],
    );
    assert.equal((sourceRows as unknown[]).length, 3);
    assert.equal(timeline.every((event) => event.createdAt.startsWith("2026-10-13T11:")), true);
    assert.equal(now.startsWith("2026-10-13"), true);
  } finally {
    await connection.rollback();
    await connection.end();
  }
});

test("collaboration store round-trips workflows, work items, and dependencies", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const workflowId = `wf-${randomUUID()}`;
  const firstItemId = `wi-${randomUUID()}`;
  const secondItemId = `wi-${randomUUID()}`;
  const now = "2026-10-13T12:00:00+08:00";
  const workflow: ProjectWorkflow = {
    id: workflowId,
    projectId: "p-001",
    taskId: "t-001",
    sourceEventId: null,
    title: "协作 Store 测试",
    requestText: "研究后实现",
    coordinatorRoleId: "planner",
    status: "planning",
    summary: "",
    errorText: "",
    returnReason: "",
    cancelReason: "",
    createdAt: now,
    updatedAt: now,
    approvedAt: null,
  };
  const first: ProjectWorkItem = {
    id: firstItemId,
    workflowId,
    position: 0,
    title: "研究",
    objective: "确认方案",
    acceptance: ["形成结论"],
    ownerRoleId: "researcher",
    reviewerRoleId: "planner",
    status: "queued",
    blockedReason: "",
    summary: "",
    evidence: [],
    errorText: "",
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const second: ProjectWorkItem = {
    ...first,
    id: secondItemId,
    position: 1,
    title: "实现",
    objective: "根据研究实现",
    ownerRoleId: "engineer",
  };
  const decision: ProjectDecisionRequest = {
    id: `dr-${randomUUID()}`,
    workflowId,
    workItemId: firstItemId,
    askedByRoleId: "planner",
    question: "采用哪个接口？",
    options: [
      { id: "a", label: "/health", impact: "兼容现有约定" },
      { id: "b", label: "/status", impact: "命名更直观" },
    ],
    recommendation: "a",
    reason: "需要产品确认",
    blockingWorkItemIds: [secondItemId],
    status: "open",
    answer: "",
    createdAt: now,
    resolvedAt: null,
  };
  const artifact: WorkflowArtifact = {
    id: `a-${randomUUID()}`,
    workflowId,
    workItemId: firstItemId,
    createdByRoleId: "researcher",
    kind: "report",
    relativeRef: `workflows/${workflowId}/research.json`,
    sha256: "a".repeat(64),
    sizeBytes: 128,
    metadata: { title: "接口研究" },
    createdAt: now,
  };

  await connection.beginTransaction();
  try {
    await insertProjectWorkflow(connection, workflow);
    await insertProjectWorkItem(connection, first);
    await insertProjectWorkItem(connection, second);
    await insertWorkItemDependencies(connection, [
      { workItemId: secondItemId, dependsOnWorkItemId: firstItemId },
    ]);
    await insertProjectDecisionRequest(connection, decision);
    await insertWorkflowArtifact(connection, artifact);

    assert.deepEqual(await getProjectWorkflow(connection, workflowId, true), workflow);
    assert.equal((await findActiveTaskWorkflow(connection, "t-001"))?.id, workflowId);
    assert.equal((await listProjectWorkflows(connection, "p-001")).some((entry) => entry.id === workflowId), true);
    assert.deepEqual(await listProjectWorkItems(connection, workflowId), [first, second]);
    assert.deepEqual(await listWorkflowDependencies(connection, workflowId), [
      { workItemId: secondItemId, dependsOnWorkItemId: firstItemId },
    ]);
    assert.deepEqual(await listOpenWorkflowDecisionRequests(connection, workflowId), [decision]);
    assert.deepEqual(await listWorkflowArtifacts(connection, workflowId), [artifact]);

    const resolved = closeDecisionRequest(decision, "resolved", "选择 /health", now);
    await updateProjectDecisionRequest(connection, resolved);
    assert.deepEqual(await getProjectDecisionRequest(connection, decision.id), resolved);
    assert.deepEqual(await listOpenWorkflowDecisionRequests(connection, workflowId), []);

    const ready = transitionWorkItem(first, "ready", now);
    await updateProjectWorkItem(connection, ready);
    assert.equal((await getProjectWorkItem(connection, firstItemId))?.status, "ready");

    const collaborating = transitionWorkflow(workflow, "collaborating", now);
    await updateProjectWorkflow(connection, collaborating);
    assert.equal((await getProjectWorkflow(connection, workflowId))?.status, "collaborating");
  } finally {
    await connection.rollback();
    await connection.end();
  }
});


