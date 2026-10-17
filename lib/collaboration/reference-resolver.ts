import type { ProjectWorkItem, WorkItemDependency } from "../domain/collaboration.ts";
import type { DecisionScope } from "./action-protocol.ts";

export class ReferenceResolutionError extends Error {
  readonly code = "invalid_reference";
  readonly allowedValues: string[];

  constructor(message: string, allowedValues: string[] = []) {
    super(message);
    this.name = "ReferenceResolutionError";
    this.allowedValues = allowedValues;
  }
}

const terminalStatuses = new Set<ProjectWorkItem["status"]>(["done", "failed", "cancelled"]);

export function resolveDecisionScope(input: {
  currentWorkItemId: string;
  scope: DecisionScope;
  items: Pick<ProjectWorkItem, "id" | "status">[];
  dependencies: WorkItemDependency[];
}): string[] {
  const itemById = new Map(input.items.map((item) => [item.id, item]));
  if (!itemById.has(input.currentWorkItemId)) {
    throw new ReferenceResolutionError("当前工作项不属于这个协作任务", ["current", "current_and_dependents"]);
  }

  const selected = new Set<string>([input.currentWorkItemId]);
  if (input.scope === "current_and_dependents") {
    const dependents = new Map<string, string[]>();
    for (const dependency of input.dependencies) {
      const current = dependents.get(dependency.dependsOnWorkItemId) ?? [];
      current.push(dependency.workItemId);
      dependents.set(dependency.dependsOnWorkItemId, current);
    }
    const queue = [input.currentWorkItemId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const dependentId of dependents.get(id) ?? []) {
        if (selected.has(dependentId)) continue;
        selected.add(dependentId);
        queue.push(dependentId);
      }
    }
  }

  return input.items
    .filter((item) => selected.has(item.id) && !terminalStatuses.has(item.status))
    .map((item) => item.id);
}

