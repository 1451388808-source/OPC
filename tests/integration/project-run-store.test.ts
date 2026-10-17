import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { type ProjectRun } from "../../lib/domain/project-run.ts";
import { closePool, databaseConfig, migrate } from "../../lib/infrastructure/db.ts";
import {
  approveProjectRun,
  approveTaskProjectRun,
  cleanupExpiredProjectRuns,
  dispatchTask,
  loadProjectRun,
  recoverInterruptedRuns,
  returnProjectRun,
  returnTaskProjectRun,
} from "../../lib/application/project-run.ts";
import { runWorkspace } from "../../lib/project-workspace/run-workspace.ts";
import { getTask, insertTask } from "../../lib/infrastructure/store.ts";
import {
  appendProjectRunEvent,
  findActiveTaskRun,
  getProjectRun,
  insertProjectRun,
  listProjectRunEvents,
  listProjectRunFiles,
  listExpiredProjectRunIds,
  updateProjectRun,
  upsertProjectRunFile,
} from "../../lib/infrastructure/project-run-store.ts";

test.after(async () => {
  await closePool();
});

async function unusedTaskIds(
  connection: Connection,
  start: number,
  end: number,
  count: number,
): Promise<string[]> {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT id FROM tasks WHERE id BETWEEN ? AND ?",
    [`t-${start}`, `t-${end}`],
  );
  const used = new Set(rows.map((row) => String(row.id)));
  const ids: string[] = [];
  for (let value = start; value <= end && ids.length < count; value += 1) {
    const id = `t-${String(value).padStart(3, "0")}`;
    if (!used.has(id)) ids.push(id);
  }
  if (ids.length < count) throw new Error("没有可用的测试任务编号");
  return ids;
}

test("project run store round-trips a run, events, and files", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const now = "2026-10-12T10:00:00+08:00";
  const run: ProjectRun = {
    id: `r-${randomUUID()}`,
    projectId: "p-001",
    taskId: "t-001",
    roleId: "engineer",
    requestText: "集成测试",
    status: "queued",
    summary: "",
    errorText: "",
    returnReason: "",
    createdAt: now,
    updatedAt: now,
    approvedAt: null,
  };

  await connection.beginTransaction();
  try {
    await insertProjectRun(connection, run);
    assert.deepEqual(await getProjectRun(connection, run.id, true), run);
    assert.equal((await findActiveTaskRun(connection, "t-001"))?.id, run.id);

    const eventId = await appendProjectRunEvent(connection, {
      runId: run.id,
      kind: "message",
      body: { text: "queued" },
      createdAt: now,
    });
    assert.equal(eventId > 0, true);
    assert.deepEqual(
      (await listProjectRunEvents(connection, run.id)).map((event) => ({ kind: event.kind, body: event.body })),
      [{ kind: "message", body: { text: "queued" } }],
    );

    await upsertProjectRunFile(connection, {
      runId: run.id,
      path: "notes.txt",
      operation: "create",
      beforeSha256: null,
      afterSha256: "a".repeat(64),
      beforeSize: 0,
      afterSize: 1,
    });
    assert.deepEqual(await listProjectRunFiles(connection, run.id), [
      {
        runId: run.id,
        path: "notes.txt",
        operation: "create",
        beforeSha256: null,
        afterSha256: "a".repeat(64),
        beforeSize: 0,
        afterSize: 1,
      },
    ]);

    await updateProjectRun(connection, { ...run, status: "running", updatedAt: "2026-10-12T10:01:00+08:00" });
    assert.equal((await getProjectRun(connection, run.id))?.status, "running");
  } finally {
    await connection.rollback();
    await connection.end();
  }
});

test("runtime recovery fails interrupted runs and resumes queued runs", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const now = "2026-10-12T10:00:00+08:00";
  const runningId = `r-${randomUUID()}`;
  const queuedId = `r-${randomUUID()}`;
  const base: Omit<ProjectRun, "id" | "status"> = {
    projectId: "p-001",
    taskId: null,
    roleId: "engineer",
    requestText: "恢复测试",
    summary: "",
    errorText: "",
    returnReason: "",
    createdAt: now,
    updatedAt: now,
    approvedAt: null,
  };

  try {
    await insertProjectRun(connection, { ...base, id: runningId, status: "running" });
    await insertProjectRun(connection, { ...base, id: queuedId, status: "queued" });

    const enqueued: string[] = [];
    await recoverInterruptedRuns((runId) => enqueued.push(runId));

    assert.equal((await getProjectRun(connection, runningId))?.status, "failed");
    assert.equal((await getProjectRun(connection, runningId))?.errorText, "服务重启，执行中断");
    assert.equal((await getProjectRun(connection, queuedId))?.status, "queued");
    assert.deepEqual(enqueued, [queuedId]);
  } finally {
    await connection.query("DELETE FROM project_run_files WHERE run_id IN (?, ?)", [runningId, queuedId]);
    await connection.query("DELETE FROM project_run_events WHERE run_id IN (?, ?)", [runningId, queuedId]);
    await connection.query("DELETE FROM project_runs WHERE id IN (?, ?)", [runningId, queuedId]);
    await connection.end();
  }
});

test("project run approval applies files and return records a reason", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const now = "2026-10-12T10:00:00+08:00";
  const approvedId = `r-${randomUUID()}`;
  const returnedId = `r-${randomUUID()}`;
  const fileName = `w7-${randomUUID()}.txt`;
  const formalFile = path.resolve("workspaces", "c-001", "p-001", fileName);
  const approvedWorkspace = runWorkspace({
    companyId: "c-001",
    projectId: "p-001",
    runId: approvedId,
  });
  const change = await approvedWorkspace.write(fileName, "approved\n");
  const base: Omit<ProjectRun, "id" | "status" | "requestText"> = {
    projectId: "p-001",
    taskId: null,
    roleId: "engineer",
    summary: "集成审批",
    errorText: "",
    returnReason: "",
    createdAt: now,
    updatedAt: now,
    approvedAt: null,
  };

  try {
    await insertProjectRun(connection, {
      ...base,
      id: approvedId,
      requestText: "批准测试",
      status: "review",
    });
    await upsertProjectRunFile(connection, { runId: approvedId, ...change });
    await insertProjectRun(connection, {
      ...base,
      id: returnedId,
      requestText: "退回测试",
      status: "review",
    });

    await approveProjectRun(approvedId);
    await returnProjectRun(returnedId, "需要补验收");

    assert.equal(await fs.readFile(formalFile, "utf8"), "approved\n");
    assert.equal((await getProjectRun(connection, approvedId))?.status, "approved");
    assert.equal((await getProjectRun(connection, returnedId))?.status, "returned");
    assert.equal((await getProjectRun(connection, returnedId))?.returnReason, "需要补验收");
  } finally {
    await fs.rm(formalFile, { force: true });
    for (const id of [approvedId, returnedId]) {
      await connection.query("DELETE FROM project_run_files WHERE run_id = ?", [id]);
      await connection.query("DELETE FROM project_run_events WHERE run_id = ?", [id]);
      await connection.query("DELETE FROM project_runs WHERE id = ?", [id]);
      await fs.rm(path.resolve(".opc", "runs", id), { recursive: true, force: true });
    }
    await connection.end();
  }
});

test("project run approval preserves external changes and returns to review on conflict", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const now = "2026-10-12T10:00:00+08:00";
  const runId = `r-${randomUUID()}`;
  const fileName = `w7-conflict-${randomUUID()}.txt`;
  const formalFile = path.resolve("workspaces", "c-001", "p-001", fileName);
  await fs.mkdir(path.dirname(formalFile), { recursive: true });
  await fs.writeFile(formalFile, "before\n", "utf8");
  const workspace = runWorkspace({ companyId: "c-001", projectId: "p-001", runId });
  const change = await workspace.write(fileName, "after\n");

  try {
    await insertProjectRun(connection, {
      id: runId,
      projectId: "p-001",
      taskId: null,
      roleId: "engineer",
      requestText: "冲突测试",
      status: "review",
      summary: "修改文件",
      errorText: "",
      returnReason: "",
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
    });
    await upsertProjectRunFile(connection, { runId, ...change });
    await fs.writeFile(formalFile, "external\n", "utf8");

    await assert.rejects(() => approveProjectRun(runId), /文件已变化/);

    assert.equal(await fs.readFile(formalFile, "utf8"), "external\n");
    assert.equal((await getProjectRun(connection, runId))?.status, "review");
    assert.equal(
      (await listProjectRunEvents(connection, runId)).some((event) => event.kind === "error"),
      true,
    );
  } finally {
    await fs.rm(formalFile, { force: true });
    await connection.query("DELETE FROM project_run_files WHERE run_id = ?", [runId]);
    await connection.query("DELETE FROM project_run_events WHERE run_id = ?", [runId]);
    await connection.query("DELETE FROM project_runs WHERE id = ?", [runId]);
    await fs.rm(path.resolve(".opc", "runs", runId), { recursive: true, force: true });
    await connection.end();
  }
});

test("task dispatch creates one queued run and moves the task to doing", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const [taskId] = await unusedTaskIds(connection, 990, 999, 1);
  const now = "2026-10-13T00:00:00+08:00";
  let runId = "";
  await insertTask(connection, {
    id: taskId,
    title: "派工集成测试",
    brief: "创建文件",
    goal: "项目里有文件",
    acceptance: ["创建 dispatch-test.txt"],
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

  try {
    const enqueued: string[] = [];
    const result = await dispatchTask(
      { taskId, projectId: "p-001", roleId: "engineer" },
      (id) => enqueued.push(id),
    );
    runId = result.runId;
    const task = await getTask(connection, taskId);
    const run = await getProjectRun(connection, runId);
    assert.equal(task?.status, "doing");
    assert.equal(task?.role, "engineer");
    assert.equal(run?.taskId, taskId);
    assert.equal(run?.status, "queued");
    assert.deepEqual(enqueued, [runId]);
    await assert.rejects(
      () => dispatchTask({ taskId, projectId: "p-001", roleId: "engineer" }, () => {}),
      /已经有正在进行的执行/,
    );
  } finally {
    if (runId) {
      await connection.query("DELETE FROM project_run_files WHERE run_id = ?", [runId]);
      await connection.query("DELETE FROM project_run_events WHERE run_id = ?", [runId]);
      await connection.query("DELETE FROM project_runs WHERE id = ?", [runId]);
    }
    await connection.query("DELETE FROM tasks WHERE id = ?", [taskId]);
    await fs.rm(path.resolve("tasks", `${taskId}.json`), { force: true });
    await connection.end();
  }
});

test("task run approval and return update task and run together", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const [approvedTaskId, returnedTaskId] = await unusedTaskIds(connection, 970, 989, 2);
  const approvedRunId = `r-${randomUUID()}`;
  const returnedRunId = `r-${randomUUID()}`;
  const fileName = `w8-joint-${randomUUID()}.txt`;
  const formalFile = path.resolve("workspaces", "c-001", "p-001", fileName);
  const now = "2026-10-13T00:00:00+08:00";
  const workspace = runWorkspace({
    companyId: "c-001",
    projectId: "p-001",
    runId: approvedRunId,
  });
  const change = await workspace.write(fileName, "joint\n");
  try {
    for (const [taskId, runId] of [
      [approvedTaskId, approvedRunId],
      [returnedTaskId, returnedRunId],
    ] as const) {
      await insertTask(connection, {
        id: taskId,
        title: "联合审批测试",
        brief: "测试",
        goal: "文件生效",
        acceptance: ["文件存在"],
        role: "engineer",
        status: "review",
        priority: "now",
        artifacts: [`workspaces/c-001/p-001/${fileName}`],
        notes: "",
        needsApproval: true,
        blockReason: "",
        decision: null,
        createdAt: now,
        updatedAt: now,
      });
      await insertProjectRun(connection, {
        id: runId,
        projectId: "p-001",
        taskId,
        roleId: "engineer",
        requestText: "联合审批",
        status: "review",
        summary: "已完成",
        errorText: "",
        returnReason: "",
        createdAt: now,
        updatedAt: now,
        approvedAt: null,
      });
    }
    await upsertProjectRunFile(connection, { runId: approvedRunId, ...change });

    const approved = await approveTaskProjectRun(approvedTaskId, "联合审批通过", false);
    const returned = await returnTaskProjectRun(returnedTaskId, "继续修改");

    assert.equal(approved.handled, true);
    assert.equal(returned.handled, true);
    assert.equal((await getTask(connection, approvedTaskId))?.status, "done");
    assert.equal((await getProjectRun(connection, approvedRunId))?.status, "approved");
    assert.equal(await fs.readFile(formalFile, "utf8"), "joint\n");
    assert.equal((await getTask(connection, returnedTaskId))?.status, "doing");
    assert.equal((await getProjectRun(connection, returnedRunId))?.status, "returned");
  } finally {
    await fs.rm(formalFile, { force: true });
    for (const [taskId, runId] of [
      [approvedTaskId, approvedRunId],
      [returnedTaskId, returnedRunId],
    ] as const) {
      await connection.query("DELETE FROM project_run_files WHERE run_id = ?", [runId]);
      await connection.query("DELETE FROM project_run_events WHERE run_id = ?", [runId]);
      await connection.query("DELETE FROM project_runs WHERE id = ?", [runId]);
      await connection.query("DELETE FROM tasks WHERE id = ?", [taskId]);
      await fs.rm(path.resolve(".opc", "runs", runId), { recursive: true, force: true });
      await fs.rm(path.resolve("tasks", `${taskId}.json`), { force: true });
    }
    await connection.end();
  }
});

test("cleanup selection includes only expired terminal runs", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const approvedId = `r-${randomUUID()}`;
  const reviewId = `r-${randomUUID()}`;
  const old = "2020-01-01T00:00:00+08:00";

  await connection.beginTransaction();
  try {
    for (const [id, status] of [
      [approvedId, "approved"],
      [reviewId, "review"],
    ] as const) {
      await insertProjectRun(connection, {
        id,
        projectId: "p-001",
        taskId: null,
        roleId: "engineer",
        requestText: "清理筛选测试",
        status,
        summary: "完成",
        errorText: "",
        returnReason: "",
        createdAt: old,
        updatedAt: old,
        approvedAt: status === "approved" ? old : null,
      });
    }

    const ids = await listExpiredProjectRunIds(connection, "2021-01-01T00:00:00+08:00");

    assert.equal(ids.includes(approvedId), true);
    assert.equal(ids.includes(reviewId), false);
  } finally {
    await connection.rollback();
    await connection.end();
  }
});

test("expired cleanup removes terminal workspaces and historical views survive", async () => {
  await migrate();
  const connection = await mysql.createConnection({
    ...databaseConfig(),
    dateStrings: true,
    charset: "utf8mb4",
  });
  const approvedId = `r-${randomUUID()}`;
  const reviewId = `r-${randomUUID()}`;
  const old = "1960-01-01T00:00:00+08:00";
  const approvedWorkspace = runWorkspace({
    companyId: "c-001",
    projectId: "p-001",
    runId: approvedId,
  });
  const reviewWorkspace = runWorkspace({
    companyId: "c-001",
    projectId: "p-001",
    runId: reviewId,
  });
  const approvedChange = await approvedWorkspace.write("old-approved.txt", "approved\n");
  await reviewWorkspace.write("old-review.txt", "review\n");

  try {
    for (const [id, status] of [
      [approvedId, "approved"],
      [reviewId, "review"],
    ] as const) {
      await insertProjectRun(connection, {
        id,
        projectId: "p-001",
        taskId: null,
        roleId: "engineer",
        requestText: "过期清理集成测试",
        status,
        summary: "完成",
        errorText: "",
        returnReason: "",
        createdAt: old,
        updatedAt: old,
        approvedAt: status === "approved" ? old : null,
      });
    }
    await upsertProjectRunFile(connection, { runId: approvedId, ...approvedChange });

    const removed = await cleanupExpiredProjectRuns(20_000);

    assert.equal(removed.includes(approvedId), true);
    assert.equal(removed.includes(reviewId), false);
    await assert.rejects(() => fs.stat(path.resolve(".opc", "runs", approvedId)), /ENOENT/);
    assert.equal((await fs.stat(path.resolve(".opc", "runs", reviewId))).isDirectory(), true);
    assert.equal((await loadProjectRun(approvedId)).files[0]?.diff, "");
  } finally {
    for (const id of [approvedId, reviewId]) {
      await connection.query("DELETE FROM project_run_files WHERE run_id = ?", [id]);
      await connection.query("DELETE FROM project_run_events WHERE run_id = ?", [id]);
      await connection.query("DELETE FROM project_runs WHERE id = ?", [id]);
      await fs.rm(path.resolve(".opc", "runs", id), { recursive: true, force: true });
    }
    await connection.end();
  }
});
