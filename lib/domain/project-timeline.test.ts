import assert from "node:assert/strict";
import test from "node:test";
import { groupProjectTimeline, normalizeProjectTimeline } from "./project-timeline.ts";
import type { ProjectEvent } from "./collaboration.ts";

function event(id: number, kind: ProjectEvent["kind"], body: unknown): ProjectEvent {
  return {
    id,
    projectId: "p-002",
    workflowId: null,
    workItemId: null,
    actorType: kind === "tool_call" || kind === "tool_result" ? "tool" : "agent",
    actorId: kind === "tool_call" || kind === "tool_result" ? "legacy-project-run" : "engineer",
    kind,
    body,
    createdAt: `2026-10-13T10:00:${String(id).padStart(2, "0")}+08:00`,
  };
}

test("legacy streamed events become readable timeline turns", () => {
  const timeline = normalizeProjectTimeline([
    event(1, "agent_message", {
      legacyRunId: "r-001",
      legacyKind: "reasoning",
      hidden: true,
      value: { text: "先读取文件", delta: true },
    }),
    event(2, "agent_message", {
      legacyRunId: "r-001",
      legacyKind: "message",
      hidden: false,
      value: { text: "已经", delta: true },
    }),
    event(3, "agent_message", {
      legacyRunId: "r-001",
      legacyKind: "message",
      hidden: false,
      value: { text: "完成第一步。", delta: true },
    }),
    event(4, "tool_call", {
      legacyRunId: "r-001",
      legacyKind: "tool_call",
      value: { name: "write_file" },
    }),
    event(5, "tool_result", {
      legacyRunId: "r-001",
      legacyKind: "tool_result",
      value: { name: "write_file", ok: true },
    }),
    event(6, "agent_message", {
      legacyRunId: "r-001",
      legacyKind: "message",
      hidden: false,
      value: { text: "文件", delta: true },
    }),
    event(7, "agent_message", {
      legacyRunId: "r-001",
      legacyKind: "message",
      hidden: false,
      value: { text: "已写入。", delta: true },
    }),
  ]);

  assert.equal(timeline.length, 4);
  assert.deepEqual(
    timeline.map((item) => ({ id: item.id, kind: item.kind, text: (item.body as { text?: string }).text })),
    [
      { id: 3, kind: "agent_message", text: "已经完成第一步。" },
      { id: 4, kind: "tool_call", text: undefined },
      { id: 5, kind: "tool_result", text: undefined },
      { id: 7, kind: "agent_message", text: "文件已写入。" },
    ],
  );
});

test("canonical project messages remain unchanged", () => {
  const canonical = event(8, "agent_message", { text: "新的协作消息" });
  assert.deepEqual(normalizeProjectTimeline([canonical]), [canonical]);
});

test("consecutive tool events collapse into one activity group", () => {
  const first = event(1, "agent_message", { text: "开始" });
  const call = event(2, "tool_call", { value: { name: "read_file" } });
  const result = event(3, "tool_result", { value: { name: "read_file", ok: true } });
  const secondCall = event(4, "tool_call", { value: { name: "write_file" } });
  const last = event(5, "agent_message", { text: "完成" });

  const items = groupProjectTimeline([first, call, result, secondCall, last]);

  assert.equal(items.length, 3);
  assert.equal(items[0]?.type, "event");
  assert.deepEqual(items[1], {
    type: "tools",
    id: 4,
    events: [call, result, secondCall],
  });
  assert.equal(items[2]?.type, "event");
});

test("tool activity from different employees stays in separate groups", () => {
  const engineerCall = {
    ...event(1, "tool_call", { id: "call-1", name: "read_file" }),
    actorId: "engineer",
    workItemId: "wi-engineer",
  };
  const operatorCall = {
    ...event(2, "tool_call", { id: "call-2", name: "read_file" }),
    actorId: "operator",
    workItemId: "wi-operator",
  };

  const items = groupProjectTimeline([engineerCall, operatorCall]);

  assert.equal(items.length, 2);
  assert.deepEqual(items, [
    { type: "tools", id: 1, events: [engineerCall] },
    { type: "tools", id: 2, events: [operatorCall] },
  ]);
});

test("infrastructure MCP audit events stay out of the employee timeline", () => {
  const auditCall = {
    ...event(1, "tool_call", { callId: 1, name: "opc.project.read_file" }),
    actorId: "opc-local",
  };
  const employeeCall = {
    ...event(2, "tool_call", { id: "call-1", name: "read_file" }),
    actorId: "engineer",
  };

  assert.deepEqual(groupProjectTimeline([auditCall, employeeCall]), [
    { type: "tools", id: 2, events: [employeeCall] },
  ]);
});
