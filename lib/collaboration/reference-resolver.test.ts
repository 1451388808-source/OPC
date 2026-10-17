import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectWorkItem } from "../domain/collaboration.ts";
import { resolveDecisionScope } from "./reference-resolver.ts";

function item(id: string, status: ProjectWorkItem["status"]): Pick<ProjectWorkItem, "id" | "status"> {
  return { id, status };
}

test("decision scope resolves the current item only", () => {
  assert.deepEqual(
    resolveDecisionScope({
      currentWorkItemId: "wi-a",
      scope: "current",
      items: [item("wi-a", "running"), item("wi-b", "queued")],
      dependencies: [{ workItemId: "wi-b", dependsOnWorkItemId: "wi-a" }],
    }),
    ["wi-a"],
  );
});

test("decision scope resolves transitive active dependents and skips terminal items", () => {
  assert.deepEqual(
    resolveDecisionScope({
      currentWorkItemId: "wi-a",
      scope: "current_and_dependents",
      items: [
        item("wi-a", "running"),
        item("wi-b", "queued"),
        item("wi-c", "done"),
        item("wi-d", "ready"),
        item("wi-x", "ready"),
      ],
      dependencies: [
        { workItemId: "wi-b", dependsOnWorkItemId: "wi-a" },
        { workItemId: "wi-c", dependsOnWorkItemId: "wi-b" },
        { workItemId: "wi-d", dependsOnWorkItemId: "wi-c" },
      ],
    }),
    ["wi-a", "wi-b", "wi-d"],
  );
});

test("decision scope rejects a current item outside the workflow", () => {
  assert.throws(
    () =>
      resolveDecisionScope({
        currentWorkItemId: "wi-missing",
        scope: "current",
        items: [item("wi-a", "running")],
        dependencies: [],
      }),
    /不属于这个协作任务/,
  );
});

