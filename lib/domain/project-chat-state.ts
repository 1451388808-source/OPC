import type { ProjectEvent } from "./collaboration.ts";

export function projectEventCursor(events: Pick<ProjectEvent, "id">[]): number {
  return events.at(-1)?.id ?? 0;
}
