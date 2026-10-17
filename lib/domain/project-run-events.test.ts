import assert from "node:assert/strict";
import test from "node:test";
import { groupProjectRunEvents } from "./project-run-events.ts";
import type { ProjectRunEvent } from "./project-run.ts";

function event(
  id: number,
  kind: ProjectRunEvent["kind"],
  body: unknown,
): ProjectRunEvent {
  return {
    id,
    runId: "r-11111111-1111-4111-8111-111111111111",
    kind,
    body,
    createdAt: "2026-10-13T00:00:00+08:00",
  };
}

test("project run event groups merge streamed deltas around tool boundaries", () => {
  const groups = groupProjectRunEvents([
    event(1, "reasoning", { text: "先看", delta: true }),
    event(2, "reasoning", { text: "文件。", delta: true }),
    event(3, "tool_call", { name: "list_files" }),
    event(4, "tool_result", { name: "list_files", ok: true }),
    event(5, "reasoning", { text: "开始写。", delta: true }),
    event(6, "message", { text: "已经", delta: true }),
    event(7, "message", { text: "完成。", delta: true }),
  ]);

  assert.deepEqual(groups, [
    { id: 1, kind: "reasoning", text: "先看文件。", streamed: true },
    { id: 3, kind: "tool_call", name: "list_files", ok: undefined, error: "" },
    { id: 4, kind: "tool_result", name: "list_files", ok: true, error: "" },
    { id: 5, kind: "reasoning", text: "开始写。", streamed: true },
    { id: 6, kind: "message", text: "已经完成。", streamed: true },
  ]);
});
