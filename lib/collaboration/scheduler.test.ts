import assert from "node:assert/strict";
import test from "node:test";
import {
  releaseReadyWorkItems,
  selectWorkItemsToReady,
  workflowCanVerify,
} from "./scheduler.ts";
import type {
  ProjectWorkItem,
  WorkItemDependency,
  WorkItemStatus,
} from "../domain/collaboration.ts";

const now = "2026-10-13T12:00:00+08:00";
const workflowId = "wf-11111111-1111-4111-8111-111111111111";
const ids = [
  "wi-11111111-1111-4111-8111-111111111111",
  "wi-22222222-2222-4222-8222-222222222222",
  "wi-33333333-3333-4333-8333-333333333333",
];

function item(index: number, status: WorkItemStatus): ProjectWorkItem {
  return {
    id: ids[index]!,
    workflowId,
    position: index,
    title: `工作项 ${index + 1}`,
    objective: "完成产出",
    acceptance: ["产出存在"],
    ownerRoleId: index === 0 ? "researcher" : "engineer",
    reviewerRoleId: "planner",
    status,
    blockedReason: "",
    summary: status === "done" ? "已完成" : "",
    evidence: status === "done" ? ["验收通过"] : [],
    errorText: "",
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

const dependencies: WorkItemDependency[] = [
  { workItemId: ids[1]!, dependsOnWorkItemId: ids[0]! },
  { workItemId: ids[2]!, dependsOnWorkItemId: ids[1]! },
];

test("scheduler releases only dependency-complete work items", () => {
  const items = [item(0, "done"), item(1, "queued"), item(2, "queued")];

  assert.deepEqual(selectWorkItemsToReady(items, dependencies), [ids[1]]);
  assert.deepEqual(
    releaseReadyWorkItems(items, dependencies, now).map((entry) => entry.status),
    ["done", "ready", "queued"],
  );
});

test("scheduler respects existing work and the configured concurrency limit", () => {
  const independent: WorkItemDependency[] = [];
  assert.deepEqual(
    selectWorkItemsToReady([item(0, "running"), item(1, "queued"), item(2, "queued")], independent, 2),
    [ids[1]],
  );
  assert.deepEqual(
    selectWorkItemsToReady([item(0, "ready"), item(1, "running"), item(2, "queued")], independent, 2),
    [],
  );
  assert.throws(
    () => selectWorkItemsToReady([item(0, "queued")], independent, 0),
    /协作并发数/,
  );
});

test("workflow verifies only after every work item is done", () => {
  assert.equal(workflowCanVerify([]), false);
  assert.equal(workflowCanVerify([item(0, "done"), item(1, "review")]), false);
  assert.equal(workflowCanVerify([item(0, "done"), item(1, "done")]), true);
});

