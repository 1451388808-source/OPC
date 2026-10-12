import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import mysql from "mysql2/promise";
import { type ProjectRun } from "../../lib/domain/project-run.ts";
import { closePool, databaseConfig, migrate } from "../../lib/infrastructure/db.ts";
import {
  approveProjectRun,
  recoverInterruptedRuns,
  returnProjectRun,
} from "../../lib/application/project-run.ts";
import { runWorkspace } from "../../lib/project-workspace/run-workspace.ts";
import {
  appendProjectRunEvent,
  findActiveTaskRun,
  getProjectRun,
  insertProjectRun,
  listProjectRunEvents,
  listProjectRunFiles,
  updateProjectRun,
  upsertProjectRunFile,
} from "../../lib/infrastructure/project-run-store.ts";

test.after(async () => {
  await closePool();
});

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
