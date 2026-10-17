import {
  CollaborationRuleError,
  readyWorkItemIds,
  transitionWorkItem,
  type ProjectWorkItem,
  type WorkItemDependency,
} from "../domain/collaboration.ts";

export function selectWorkItemsToReady(
  items: ProjectWorkItem[],
  dependencies: WorkItemDependency[],
  maxConcurrent = 2,
): string[] {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) {
    throw new CollaborationRuleError("协作并发数必须在 1 到 8 之间");
  }
  const inFlight = items.filter((item) => item.status === "ready" || item.status === "running").length;
  const available = Math.max(0, maxConcurrent - inFlight);
  return readyWorkItemIds(items, dependencies).slice(0, available);
}

export function releaseReadyWorkItems(
  items: ProjectWorkItem[],
  dependencies: WorkItemDependency[],
  updatedAt: string,
  maxConcurrent = 2,
): ProjectWorkItem[] {
  const selected = new Set(selectWorkItemsToReady(items, dependencies, maxConcurrent));
  return items.map((item) =>
    selected.has(item.id) ? transitionWorkItem(item, "ready", updatedAt) : item,
  );
}

export function workflowCanVerify(items: ProjectWorkItem[]): boolean {
  return items.length > 0 && items.every((item) => item.status === "done");
}

