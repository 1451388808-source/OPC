import assert from "node:assert/strict";
import test from "node:test";
import { shouldStartCollaborationRuntime } from "./runtime.ts";

test("collaboration runtime does not start while Next builds static output", () => {
  assert.equal(shouldStartCollaborationRuntime("phase-production-build"), false);
});

test("collaboration runtime starts for development and production requests", () => {
  assert.equal(shouldStartCollaborationRuntime("phase-development-server"), true);
  assert.equal(shouldStartCollaborationRuntime("phase-production-server"), true);
  assert.equal(shouldStartCollaborationRuntime(undefined), true);
});

