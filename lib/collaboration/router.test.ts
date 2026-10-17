import assert from "node:assert/strict";
import test from "node:test";
import { isWorkflowFollowUp, routeProjectMessage } from "./router.ts";

test("router keeps information questions as conversation", () => {
  const route = routeProjectMessage("这个项目现在是什么状态？");
  assert.deepEqual(route.intent, { type: "conversation" });
  assert.equal(route.confidence, "high");
});

test("router recognizes an actionable deliverable as a new workflow", () => {
  const route = routeProjectMessage("实现登录页面并补充测试");
  assert.deepEqual(route.intent, { type: "new_workflow", title: "实现登录页面并补充测试" });
  assert.equal(route.confidence, "high");
});

test("router recognizes colloquial requests to make a web page as workflow tasks", () => {
  for (const message of ["做一个web网页", "我想做一个web网页"]) {
    const route = routeProjectMessage(message);
    assert.deepEqual(route.intent, { type: "new_workflow", title: message });
    assert.equal(route.confidence, "high");
  }
});

test("router recognizes contextual fixes and defect reports as workflow tasks", () => {
  for (const message of [
    "工程可以改代码呀",
    "这里还需要改进啊",
    "这个页面有问题",
    "识别任务和交流这里还是有问题",
  ]) {
    assert.equal(routeProjectMessage(message).intent.type, "new_workflow", message);
  }
  assert.equal(routeProjectMessage("工程可以改代码吗？").intent.type, "conversation");
  assert.equal(routeProjectMessage("为什么这个页面有问题？").intent.type, "conversation");
});

test("router recognizes read-and-replace page requests as workflow tasks", () => {
  for (const message of [
    "读取页面中cool.html，我需要把网页中的文字换成是自己简历的那种",
    "把 cool.html 里的文字替换成我的简历",
    "读取 cool.html，把内容换成个人简历",
    "将首页文案调整为个人介绍",
    "按你的来，不用给截图，代码写好就运行",
  ]) {
    assert.equal(routeProjectMessage(message).intent.type, "new_workflow", message);
  }
});

test("router respects explicit task markers and manual correction", () => {
  assert.deepEqual(routeProjectMessage("任务：整理发布文档").intent, {
    type: "new_workflow",
    title: "整理发布文档",
  });
  assert.deepEqual(routeProjectMessage("实现登录页面", { override: "conversation" }).intent, {
    type: "conversation",
  });
  assert.deepEqual(routeProjectMessage("解释一下这个接口", { override: "task" }).intent, {
    type: "new_workflow",
    title: "解释一下这个接口",
  });
});

test("router binds explicit workflow, decision, and review contexts", () => {
  assert.deepEqual(routeProjectMessage("失败响应改成 422", { workflowId: "wf-1" }).intent, {
    type: "workflow_input",
    workflowId: "wf-1",
  });
  assert.deepEqual(routeProjectMessage("选择 A", { decisionId: "dr-1" }).intent, {
    type: "decision_answer",
    decisionId: "dr-1",
  });
  assert.deepEqual(
    routeProjectMessage("批准", { workflowId: "wf-1", reviewAction: "approve" }).intent,
    { type: "review_action", workflowId: "wf-1", action: "approve" },
  );
});

test("router treats ambiguous action language conservatively and validates input", () => {
  const route = routeProjectMessage("整理一下");
  assert.equal(route.intent.type, "conversation");
  assert.equal(route.confidence, "medium");
  assert.throws(() => routeProjectMessage("   "), /先写一句话/);
  assert.throws(() => routeProjectMessage("批准", { reviewAction: "approve" }), /缺少协作任务/);
});

test("router recognizes instructions that continue the active workflow", () => {
  assert.equal(isWorkflowFollowUp("按你的来，不用给截图，代码写好就运行"), true);
  assert.equal(isWorkflowFollowUp("继续，页面结构不要动"), true);
  assert.equal(isWorkflowFollowUp("另外做一个全新的官网"), false);
});

