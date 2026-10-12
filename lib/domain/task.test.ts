import assert from "node:assert/strict";
import test from "node:test";
import {
  approveTask,
  deliverableIsDecision,
  doingCount,
  inboxPriority,
  nextTaskId,
  promoteTask,
  returnTask,
  titleFromBrief,
  type Task,
} from "./task.ts";

const stamp = "2026-10-11 22:00";
const iso = "2026-10-11T22:00:00+08:00";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-001",
    title: "建立手册",
    brief: "原话",
    goal: "仓库里有手册",
    acceptance: ["文件存在"],
    role: "engineer",
    status: "review",
    priority: "now",
    artifacts: ["roles/planner.md"],
    notes: "",
    needsApproval: true,
    blockReason: "",
    decision: null,
    createdAt: iso,
    updatedAt: iso,
    ...overrides,
  };
}

test("next id keeps three digits and does not reuse", () => {
  assert.equal(nextTaskId([]), "t-001");
  assert.equal(nextTaskId(["t-001", "t-009"]), "t-010");
});

test("inbox stays next while something is already in progress", () => {
  assert.equal(inboxPriority(0), "now");
  assert.equal(inboxPriority(1), "next");
});

test("title keeps a short brief and trims a long one", () => {
  assert.equal(titleFromBrief(" 短句 "), "短句");
  assert.equal(
    titleFromBrief("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三"),
    "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二…",
  );
});

test("doing count only includes now", () => {
  assert.equal(
    doingCount([
      task({ status: "doing", priority: "now" }),
      task({ id: "t-002", status: "doing", priority: "next" }),
    ]),
    1,
  );
});

test("approve requires a decision and a deliverable", () => {
  assert.throws(() => approveTask(task(), "  ", stamp, iso), /结论不能为空/);
  assert.throws(
    () => approveTask(task({ artifacts: [], goal: "写代码", acceptance: ["文件存在"] }), "可以", stamp, iso),
    /没有产出/,
  );
  const done = approveTask(task(), "公司记忆先用这四份文档。", stamp, iso);
  assert.equal(done.status, "done");
  assert.equal(done.decision, "公司记忆先用这四份文档。");
  assert.match(done.notes, /你 · 批准/);
});

test("a task whose output is a decision can be approved without files", () => {
  const item = task({ artifacts: [], goal: "记下这条决定", acceptance: ["写入 decisions"] });
  assert.equal(deliverableIsDecision(item), true);
  assert.equal(approveTask(item, "采用 MySQL", stamp, iso).status, "done");
});

test("return rejects an empty reason and a full doing list", () => {
  assert.throws(() => returnTask(task(), " ", 0, stamp, iso), /退回原因不能为空/);
  assert.throws(() => returnTask(task(), "再改验收", 2, stamp, iso), /进行中已满/);
  const doing = returnTask(task(), "再改验收", 1, stamp, iso);
  assert.equal(doing.status, "doing");
  assert.match(doing.notes, /退回。再改验收/);
});

test("promote blocks a third in-progress task and allows inbox", () => {
  assert.throws(
    () => promoteTask(task({ priority: "next", status: "doing" }), 2, iso),
    /进行中已满/,
  );
  const promoted = promoteTask(task({ priority: "next", status: "inbox" }), 2, iso);
  assert.equal(promoted.priority, "now");
  assert.equal(promoted.status, "inbox");
});
