import assert from "node:assert/strict";
import test from "node:test";
import {
  projectDecisionRequestSchema,
  projectWorkItemSchema,
  workflowArtifactSchema,
  closeDecisionRequest,
  decisionRecommendationId,
  handoffWorkItemOwner,
  readyWorkItemIds,
  transitionWorkflow,
  transitionWorkItem,
  validateWorkItemDependencies,
  type ProjectWorkflow,
  type ProjectWorkItem,
  type WorkflowStatus,
  type WorkItemStatus,
} from "./collaboration.ts";

const now = "2026-10-13T10:00:00+08:00";
const workflowId = "wf-11111111-1111-4111-8111-111111111111";
const itemAId = "wi-11111111-1111-4111-8111-111111111111";
const itemBId = "wi-22222222-2222-4222-8222-222222222222";
const itemCId = "wi-33333333-3333-4333-8333-333333333333";

function workflow(status: WorkflowStatus = "intake"): ProjectWorkflow {
  return {
    id: workflowId,
    projectId: "p-001",
    taskId: null,
    sourceEventId: 1,
    title: "完成登录页",
    requestText: "完成登录页并补测试",
    coordinatorRoleId: "planner",
    status,
    summary: "",
    errorText: "",
    returnReason: "",
    cancelReason: "",
    createdAt: now,
    updatedAt: now,
    approvedAt: null,
  };
}

function item(id: string, status: WorkItemStatus = "queued"): ProjectWorkItem {
  return {
    id,
    workflowId,
    position: id === itemAId ? 0 : 1,
    title: `工作项 ${id}`,
    objective: "完成一个可检查的产出",
    acceptance: ["产出存在"],
    ownerRoleId: "engineer",
    reviewerRoleId: "planner",
    status,
    blockedReason: "",
    summary: "",
    evidence: [],
    errorText: "",
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

test("workflow follows collaboration through approval", () => {
  const planning = transitionWorkflow(workflow(), "planning", now);
  const collaborating = transitionWorkflow(planning, "collaborating", now);
  const verifying = transitionWorkflow(collaborating, "verifying", now);
  const review = transitionWorkflow(verifying, "review", now, { summary: "全部验收通过" });
  const applying = transitionWorkflow(review, "applying", now);
  const approved = transitionWorkflow(applying, "approved", now);

  assert.equal(approved.status, "approved");
  assert.equal(approved.summary, "全部验收通过");
  assert.equal(approved.approvedAt, now);
});

test("workflow supports waiting for the user and returned rework", () => {
  const waiting = transitionWorkflow(workflow("planning"), "waiting_user", now);
  const collaborating = transitionWorkflow(waiting, "collaborating", now);
  const returned = transitionWorkflow(workflow("review"), "returned", now, { returnReason: "补充失败用例" });
  const failed = transitionWorkflow(workflow("planning"), "failed", now, { errorText: "系统错误" });
  const recovered = transitionWorkflow(failed, "collaborating", now);

  assert.equal(collaborating.status, "collaborating");
  assert.equal(transitionWorkflow(returned, "collaborating", now).returnReason, "补充失败用例");
  assert.equal(recovered.status, "collaborating");
});

test("workflow rejects illegal or unexplained terminal transitions", () => {
  assert.throws(() => transitionWorkflow(workflow(), "review", now, { summary: "跳过" }), /不能从 intake/);
  assert.throws(() => transitionWorkflow(workflow("verifying"), "review", now), /验收摘要不能为空/);
  assert.throws(() => transitionWorkflow(workflow("review"), "returned", now), /退回原因不能为空/);
  assert.throws(() => transitionWorkflow(workflow("planning"), "failed", now), /失败原因不能为空/);
  assert.throws(() => transitionWorkflow(workflow("planning"), "cancelled", now), /取消原因不能为空/);
});

test("work item requires evidence before review and counts rework", () => {
  const ready = transitionWorkItem(item(itemAId), "ready", now);
  const running = transitionWorkItem(ready, "running", now);
  assert.throws(() => transitionWorkItem(running, "review", now, { summary: "完成" }), /验收证据不能为空/);
  const review = transitionWorkItem(running, "review", now, {
    summary: "完成实现",
    evidence: ["npm test: 18 passed", "npm test: 18 passed"],
  });
  const rework = transitionWorkItem(review, "ready", now);

  assert.deepEqual(review.evidence, ["npm test: 18 passed"]);
  assert.equal(rework.retryCount, 1);
  assert.equal(transitionWorkItem(review, "done", now).status, "done");
  const failed = transitionWorkItem(running, "failed", now, { errorText: "系统错误" });
  assert.equal(transitionWorkItem(failed, "ready", now).errorText, "");
});

test("work item validates blockers, failures, and reviewer separation", () => {
  assert.throws(() => transitionWorkItem(item(itemAId, "ready"), "blocked", now), /阻塞原因不能为空/);
  assert.throws(() => transitionWorkItem(item(itemAId, "running"), "failed", now), /失败原因不能为空/);
  assert.throws(
    () => projectWorkItemSchema.parse({ ...item(itemAId), reviewerRoleId: "engineer" }),
    /复核员工不能与主责员工相同/,
  );
});

test("work item handoff changes the owner and returns running work to ready", () => {
  const running = item(itemAId, "running");
  const handedOff = handoffWorkItemOwner(running, "engineer", "researcher", now);

  assert.equal(handedOff.ownerRoleId, "researcher");
  assert.equal(handedOff.status, "ready");
  assert.throws(() => handoffWorkItemOwner(running, "planner", "researcher", now), /当前主责/);
  assert.throws(() => handoffWorkItemOwner(running, "engineer", "planner", now), /复核员工/);
  assert.throws(() => handoffWorkItemOwner(item(itemAId, "review"), "engineer", "researcher", now), /可以交接/);
});

test("dependency graph rejects unknown, duplicate, self, and cyclic edges", () => {
  assert.throws(
    () => validateWorkItemDependencies([itemAId], [{ workItemId: itemAId, dependsOnWorkItemId: itemBId }]),
    /未知工作项/,
  );
  assert.throws(
    () => validateWorkItemDependencies([itemAId], [{ workItemId: itemAId, dependsOnWorkItemId: itemAId }]),
    /不能依赖自己/,
  );
  assert.throws(
    () =>
      validateWorkItemDependencies(
        [itemAId, itemBId],
        [
          { workItemId: itemBId, dependsOnWorkItemId: itemAId },
          { workItemId: itemBId, dependsOnWorkItemId: itemAId },
        ],
      ),
    /依赖不能重复/,
  );
  assert.throws(
    () =>
      validateWorkItemDependencies(
        [itemAId, itemBId],
        [
          { workItemId: itemAId, dependsOnWorkItemId: itemBId },
          { workItemId: itemBId, dependsOnWorkItemId: itemAId },
        ],
      ),
    /不能形成环/,
  );
});

test("ready work items include only queued items whose dependencies are done", () => {
  const items = [item(itemAId, "done"), item(itemBId), item(itemCId)];
  const dependencies = [
    { workItemId: itemBId, dependsOnWorkItemId: itemAId },
    { workItemId: itemCId, dependsOnWorkItemId: itemBId },
  ];

  assert.deepEqual(readyWorkItemIds(items, dependencies), [itemBId]);
});

test("decision request requires choices with impact", () => {
  assert.throws(
    () =>
      projectDecisionRequestSchema.parse({
        id: "dr-11111111-1111-4111-8111-111111111111",
        workflowId,
        workItemId: itemAId,
        askedByRoleId: "planner",
        question: "采用哪个方案？",
        options: [{ id: "a", label: "方案 A", impact: "改动较小" }],
        recommendation: "a",
        reason: "需要产品取舍",
        blockingWorkItemIds: [itemAId],
        status: "open",
        answer: "",
        createdAt: now,
        resolvedAt: null,
      }),
    /too_small/,
  );
});

test("decision recommendation accepts either an option id or its exact label", () => {
  const options = [
    { id: "a", label: "保持现状", impact: "改动较小" },
    { id: "b", label: "重新设计", impact: "长期更清晰" },
  ];

  assert.equal(decisionRecommendationId(options, "a"), "a");
  assert.equal(decisionRecommendationId(options, "重新设计"), "b");
  assert.equal(decisionRecommendationId(options, "推荐 b（长期更清晰）"), "b");
  assert.equal(decisionRecommendationId(options, "建议选 b（长期更清晰）"), "b");
  assert.equal(decisionRecommendationId(options, "A：先保持现状"), "a");
  assert.equal(decisionRecommendationId(options, "不存在"), null);
});

test("decision request closes once with an explicit answer", () => {
  const request = projectDecisionRequestSchema.parse({
    id: "dr-11111111-1111-4111-8111-111111111111",
    workflowId,
    workItemId: itemAId,
    askedByRoleId: "planner",
    question: "采用哪个方案？",
    options: [
      { id: "a", label: "方案 A", impact: "改动较小" },
      { id: "b", label: "方案 B", impact: "扩展性更好" },
    ],
    recommendation: "a",
    reason: "需要产品取舍",
    blockingWorkItemIds: [itemAId],
    status: "open",
    answer: "",
    createdAt: now,
    resolvedAt: null,
  });
  const resolved = closeDecisionRequest(request, "resolved", "选择 A", now);

  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.answer, "选择 A");
  assert.throws(() => closeDecisionRequest(resolved, "cancelled", "不再需要", now), /待决定/);
});

test("workflow artifact requires a safe relative reference", () => {
  const base = {
    id: "a-11111111-1111-4111-8111-111111111111",
    workflowId,
    workItemId: itemAId,
    createdByRoleId: "engineer",
    kind: "file",
    relativeRef: "workspaces/c-001/p-001/README.md",
    sha256: "a".repeat(64),
    sizeBytes: 10,
    metadata: {},
    createdAt: now,
  };
  assert.equal(workflowArtifactSchema.parse(base).relativeRef, base.relativeRef);
  assert.throws(() => workflowArtifactSchema.parse({ ...base, relativeRef: "../outside.txt" }), /安全的相对路径/);
});

