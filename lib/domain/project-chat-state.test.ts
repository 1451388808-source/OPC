import assert from "node:assert/strict";
import test from "node:test";
import { projectEventCursor } from "./project-chat-state.ts";

test("project chat cursor follows the currently loaded project events", () => {
  assert.equal(projectEventCursor([{ id: 8 }, { id: 13 }]), 13);
  assert.equal(projectEventCursor([]), 0);
});
