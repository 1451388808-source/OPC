import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { toolFailureFromUnknown } from "./error.ts";

test("tool errors classify invalid input as retryable", () => {
  const parsed = z.object({ scope: z.enum(["current", "current_and_dependents"]) }).safeParse({ scope: "all" });
  assert.equal(parsed.success, false);
  const failure = toolFailureFromUnknown(parsed.error);
  assert.equal(failure.code, "invalid_input");
  assert.equal(failure.retryable, true);
});

test("tool errors classify permission failures as non-retryable", () => {
  const failure = toolFailureFromUnknown(new Error("员工无权访问这个工作项"));
  assert.deepEqual(failure, {
    ok: false,
    code: "permission_denied",
    message: "员工无权访问这个工作项",
    retryable: false,
  });
});

test("unknown validation profile is retryable input with allowed values", () => {
  const failure = toolFailureFromUnknown(
    new Error("找不到验证配置：node-check。可用 profile：default、docs、spec、frontend、static-site"),
  );
  assert.deepEqual(failure, {
    ok: false,
    code: "invalid_input",
    message: "找不到验证配置：node-check。可用 profile：default、docs、spec、frontend、static-site",
    retryable: true,
    correction: { allowedValues: ["default", "docs", "spec", "frontend", "static-site"] },
  });
});
