import assert from "node:assert/strict";
import test from "node:test";
import {
  projectRunFileSchema,
  projectRunSchema,
  transitionProjectRun,
  type ProjectRun,
  type ProjectRunStatus,
} from "./project-run.ts";

const createdAt = "2026-10-12T10:00:00+08:00";

function run(status: ProjectRunStatus = "queued"): ProjectRun {
  return {
    id: "r-11111111-1111-4111-8111-111111111111",
    projectId: "p-001",
    taskId: null,
    roleId: "engineer",
    requestText: "更新项目说明",
    status,
    summary: "",
    errorText: "",
    returnReason: "",
    createdAt,
    updatedAt: createdAt,
    approvedAt: null,
  };
}

test("project run follows queued through approved", () => {
  const running = transitionProjectRun(run(), "running", "2026-10-12T10:01:00+08:00");
  const review = transitionProjectRun(running, "review", "2026-10-12T10:02:00+08:00", {
    summary: "更新了 README。",
  });
  const applying = transitionProjectRun(review, "applying", "2026-10-12T10:03:00+08:00");
  const approved = transitionProjectRun(applying, "approved", "2026-10-12T10:04:00+08:00");

  assert.equal(approved.status, "approved");
  assert.equal(approved.summary, "更新了 README。");
  assert.equal(approved.approvedAt, "2026-10-12T10:04:00+08:00");
});

test("project run rejects illegal transitions", () => {
  assert.throws(() => transitionProjectRun(run(), "review", createdAt, { summary: "跳过执行" }), /不能从 queued/);
  assert.throws(() => transitionProjectRun(run("approved"), "running", createdAt), /不能从 approved/);
  assert.throws(() => transitionProjectRun(run("returned"), "review", createdAt, { summary: "重开" }), /不能从 returned/);
});

test("review, returned, and failed require their explanatory text", () => {
  assert.throws(() => transitionProjectRun(run("running"), "review", createdAt), /完成摘要不能为空/);
  assert.throws(() => transitionProjectRun(run("review"), "returned", createdAt), /退回原因不能为空/);
  assert.throws(() => transitionProjectRun(run("running"), "failed", createdAt), /失败原因不能为空/);

  assert.equal(
    transitionProjectRun(run("review"), "returned", createdAt, { returnReason: "验收未满足" }).returnReason,
    "验收未满足",
  );
  assert.equal(
    transitionProjectRun(run("running"), "failed", createdAt, { errorText: "模型超时" }).errorText,
    "模型超时",
  );
});

test("applying can return to review after a recoverable apply failure", () => {
  const next = transitionProjectRun(run("applying"), "review", createdAt, { summary: "文件发生冲突" });
  assert.equal(next.status, "review");
  assert.equal(next.approvedAt, null);
});

test("project run schemas reject malformed persisted data", () => {
  assert.throws(() => projectRunSchema.parse({ ...run(), id: "run-1" }), /Invalid/);
  assert.throws(
    () =>
      projectRunFileSchema.parse({
        runId: run().id,
        path: "../outside.txt",
        operation: "update",
        beforeSha256: "a".repeat(64),
        afterSha256: "b".repeat(64),
        beforeSize: 1,
        afterSize: 1,
      }),
    /Invalid/,
  );
});
