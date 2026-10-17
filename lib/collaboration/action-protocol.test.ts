import assert from "node:assert/strict";
import test from "node:test";
import { agentActionSchema } from "./action-protocol.ts";

test("agent action accepts domain-level decision scope without internal ids", () => {
  const action = agentActionSchema.parse({
    type: "request_decision",
    scope: "current_and_dependents",
    question: "采用哪个接口名？",
    options: [
      { id: "a", label: "health", impact: "兼容现有约定" },
      { id: "b", label: "status", impact: "表达更直观" },
    ],
    recommendation: "a",
    reason: "两个方案都满足验收，需要老板决定产品偏好。",
  });

  assert.equal(action.type, "request_decision");
  assert.equal("workItemId" in action, false);
  assert.equal("blockingWorkItemIds" in action, false);
});

test("agent action rejects invalid plans and unknown action types", () => {
  assert.throws(
    () =>
      agentActionSchema.parse({
        type: "propose_plan",
        items: [{ key: "A", title: "x", objective: "x", acceptance: [], ownerRoleId: "engineer" }],
      }),
    /Invalid string|Too small/,
  );
  assert.throws(() => agentActionSchema.parse({ type: "change_database_status" }));
});

