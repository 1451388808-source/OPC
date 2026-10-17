import type { ProjectEvent } from "./collaboration.ts";

type EventBody = Record<string, unknown>;

export type ProjectTimelineItem =
  | { type: "event"; event: ProjectEvent }
  | { type: "tools"; id: number; events: ProjectEvent[] };

function bodyOf(event: ProjectEvent): EventBody {
  return event.body !== null && typeof event.body === "object" ? (event.body as EventBody) : {};
}

function hiddenFromTimeline(event: ProjectEvent, body: EventBody): boolean {
  return body.hidden === true || (event.actorType === "tool" && event.actorId === "opc-local");
}

function nestedValue(body: EventBody): EventBody {
  return body.value !== null && typeof body.value === "object" ? (body.value as EventBody) : {};
}

function legacyMessageBody(event: ProjectEvent): EventBody | null {
  if (event.kind !== "agent_message") return null;
  const body = bodyOf(event);
  if (body.legacyKind !== "message" || typeof body.legacyRunId !== "string") return null;
  const value = nestedValue(body);
  const text = typeof body.text === "string" ? body.text : typeof value.text === "string" ? value.text : "";
  return { ...body, text, delta: body.delta === true || value.delta === true };
}

function sameLegacyTurn(left: ProjectEvent, right: ProjectEvent): boolean {
  const leftBody = bodyOf(left);
  const rightBody = bodyOf(right);
  return (
    left.kind === "agent_message" &&
    right.kind === "agent_message" &&
    left.actorId === right.actorId &&
    leftBody.legacyKind === "message" &&
    rightBody.legacyKind === "message" &&
    leftBody.legacyRunId === rightBody.legacyRunId
  );
}

export function normalizeProjectTimeline(events: ProjectEvent[]): ProjectEvent[] {
  const normalized: ProjectEvent[] = [];
  for (const event of events) {
    const body = bodyOf(event);
    if (hiddenFromTimeline(event, body)) continue;

    const legacyBody = legacyMessageBody(event);
    const current = legacyBody ? { ...event, body: legacyBody } : event;
    const previous = normalized.at(-1);
    if (legacyBody && previous && sameLegacyTurn(previous, current)) {
      const previousBody = bodyOf(previous);
      normalized[normalized.length - 1] = {
        ...previous,
        id: current.id,
        createdAt: current.createdAt,
        body: {
          ...previousBody,
          text: `${String(previousBody.text ?? "")}${String(legacyBody.text ?? "")}`,
          delta: previousBody.delta === true || legacyBody.delta === true,
        },
      };
      continue;
    }
    normalized.push(current);
  }
  return normalized;
}

export function groupProjectTimeline(events: ProjectEvent[]): ProjectTimelineItem[] {
  const items: ProjectTimelineItem[] = [];
  for (const event of events) {
    if (hiddenFromTimeline(event, bodyOf(event))) continue;
    const isTool = event.kind === "tool_call" || event.kind === "tool_result";
    const previous = items.at(-1);
    const firstTool = previous?.type === "tools" ? previous.events[0] : null;
    if (
      isTool &&
      previous?.type === "tools" &&
      firstTool?.actorId === event.actorId &&
      firstTool?.workflowId === event.workflowId &&
      firstTool?.workItemId === event.workItemId
    ) {
      previous.id = event.id;
      previous.events.push(event);
      continue;
    }
    items.push(isTool ? { type: "tools", id: event.id, events: [event] } : { type: "event", event });
  }
  return items;
}
