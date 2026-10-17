import assert from "node:assert/strict";
import test from "node:test";
import {
  collaborationProgressEvent,
  type CollaborationProgressState,
} from "./progress-events.ts";

test("collaboration progress exposes useful steps without raw reasoning or tool payloads", () => {
  const state: CollaborationProgressState = { analysisAnnounced: false };

  assert.deepEqual(
    collaborationProgressEvent({ kind: "reasoning", body: { text: "private reasoning", delta: true } }, state),
    {
      actorType: "agent",
      kind: "work_item_status",
      body: { status: "running", detail: "正在分析任务" },
    },
  );
  assert.equal(
    collaborationProgressEvent({ kind: "reasoning", body: { text: "more private reasoning" } }, state),
    null,
  );
  assert.equal(
    collaborationProgressEvent({ kind: "message", body: { text: "partial answer", delta: true } }, state),
    null,
  );
  assert.deepEqual(
    collaborationProgressEvent(
      { kind: "tool_call", body: { id: "call-1", name: "read_file", arguments: '{"path":"secret.txt"}' } },
      state,
    ),
    {
      actorType: "tool",
      kind: "tool_call",
      body: { id: "call-1", name: "read_file" },
    },
  );
  assert.deepEqual(
    collaborationProgressEvent(
      { kind: "tool_result", body: { id: "call-1", name: "read_file", ok: true, result: { content: "secret" } } },
      state,
    ),
    {
      actorType: "tool",
      kind: "tool_result",
      body: { id: "call-1", name: "read_file", ok: true },
    },
  );
});
