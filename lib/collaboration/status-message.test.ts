import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectWorkflow, ProjectWorkItem } from "../domain/collaboration.ts";
import { isWorkflowStatusQuestion, workflowStatusMessage } from "./status-message.ts";

const workflow = {
  id: "wf-11111111-1111-4111-8111-111111111111",
  projectId: "p-001",
  taskId: null,
  sourceEventId: null,
  title: "做网页",
  requestText: "做一个网页",
  coordinatorRoleId: "engineer",
  status: "waiting_user",
  summary: "",
  errorText: "",
  returnReason: "",
  cancelReason: "",
  createdAt: "2026-10-14T01:00:00+08:00",
  updatedAt: "2026-10-14T01:00:00+08:00",
  approvedAt: null,
} satisfies ProjectWorkflow;

const item = {
  id: "wi-11111111-1111-4111-8111-111111111111",
  workflowId: workflow.id,
  position: 0,
  title: "实现网页",
  objective: "完成网页",
  acceptance: ["页面存在"],
  ownerRoleId: "engineer",
  reviewerRoleId: null,
  status: "blocked",
  blockedReason: "missing_configuration: 找不到验证配置：node-check",
  summary: "",
  evidence: [],
  errorText: "",
  retryCount: 0,
  createdAt: workflow.createdAt,
  updatedAt: workflow.updatedAt,
} satisfies ProjectWorkItem;

test("workflow status questions are recognized", () => {
  assert.equal(isWorkflowStatusQuestion("做完了吗"), true);
  assert.equal(isWorkflowStatusQuestion("现在进度到哪了"), true);
  assert.equal(isWorkflowStatusQuestion("解释一下接口"), false);
});

test("workflow status answers use workflow facts and never ask the boss to choose an employee", () => {
  const message = workflowStatusMessage({ workflow, items: [item] });
  assert.match(message, /还没完成/);
  assert.match(message, /node-check/);
  assert.doesNotMatch(message, /选择.*员工|执行任务/);

  const resumed = workflowStatusMessage({ workflow: { ...workflow, status: "collaborating" }, items: [item], resumed: true });
  assert.match(resumed, /已经恢复任务/);
  assert.match(resumed, /不需要选择员工/);
});
