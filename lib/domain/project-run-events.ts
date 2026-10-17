import type { ProjectRunEvent } from "./project-run";

export type ProjectRunEventGroup =
  | { id: number; kind: "reasoning" | "message"; text: string; streamed: boolean }
  | { id: number; kind: "error"; text: string }
  | { id: number; kind: "tool_call"; name: string; ok: undefined; error: string }
  | { id: number; kind: "tool_result"; name: string; ok: boolean | undefined; error: string };

function bodyOf(event: ProjectRunEvent): Record<string, unknown> {
  return event.body && typeof event.body === "object"
    ? (event.body as Record<string, unknown>)
    : { text: String(event.body ?? "") };
}

export function groupProjectRunEvents(events: ProjectRunEvent[]): ProjectRunEventGroup[] {
  const groups: ProjectRunEventGroup[] = [];
  for (const event of events) {
    const body = bodyOf(event);
    if (event.kind === "reasoning" || event.kind === "message") {
      const text = String(body.text ?? "");
      const previous = groups.at(-1);
      if (body.delta === true && previous?.kind === event.kind) {
        previous.text += text;
      } else {
        groups.push({ id: event.id, kind: event.kind, text, streamed: body.delta === true });
      }
      continue;
    }
    if (event.kind === "error") {
      groups.push({ id: event.id, kind: "error", text: String(body.message ?? body.text ?? "") });
      continue;
    }
    if (event.kind === "tool_call") {
      groups.push({
        id: event.id,
        kind: "tool_call",
        name: String(body.name ?? ""),
        ok: undefined,
        error: "",
      });
    } else {
      groups.push({
        id: event.id,
        kind: "tool_result",
        name: String(body.name ?? ""),
        ok: typeof body.ok === "boolean" ? body.ok : undefined,
        error: String(body.error ?? ""),
      });
    }
  }
  return groups;
}
