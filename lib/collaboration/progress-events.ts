import type { ProjectEventActorType, ProjectEventKind } from "../domain/collaboration.ts";
import type { ToolLoopEvent } from "../employees/tool-loop.ts";

export type CollaborationProgressState = {
  analysisAnnounced: boolean;
};

export type CollaborationProgressEvent = {
  actorType: ProjectEventActorType;
  kind: ProjectEventKind;
  body: Record<string, unknown>;
};

function eventBody(event: ToolLoopEvent): Record<string, unknown> {
  return event.body !== null && typeof event.body === "object"
    ? (event.body as Record<string, unknown>)
    : {};
}

export function collaborationProgressEvent(
  event: ToolLoopEvent,
  state: CollaborationProgressState,
): CollaborationProgressEvent | null {
  const body = eventBody(event);
  if (event.kind === "reasoning") {
    if (state.analysisAnnounced) return null;
    state.analysisAnnounced = true;
    return {
      actorType: "agent",
      kind: "work_item_status",
      body: { status: "running", detail: "正在分析任务" },
    };
  }
  if (event.kind === "tool_call") {
    return {
      actorType: "tool",
      kind: "tool_call",
      body: { id: String(body.id ?? ""), name: String(body.name ?? "工具") },
    };
  }
  if (event.kind === "tool_result") {
    return {
      actorType: "tool",
      kind: "tool_result",
      body: {
        id: String(body.id ?? ""),
        name: String(body.name ?? "工具"),
        ok: body.ok !== false,
      },
    };
  }
  if (event.kind === "error") {
    return {
      actorType: "agent",
      kind: "error",
      body: { message: String(body.message ?? "执行失败") },
    };
  }
  return null;
}
