import assert from "node:assert/strict";
import test from "node:test";
import { createMcpReviewTools, createMcpWorkflowTools } from "./mcp-tools.ts";
import { ToolExecutionError } from "../mcp/error.ts";

test("MCP workflow tools carry read hashes into staged writes", async () => {
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  const tools = createMcpWorkflowTools({
    context: {
      workflowId: "wf-11111111-1111-4111-8111-111111111111",
      workItemId: "wi-11111111-1111-4111-8111-111111111111",
      roleId: "engineer",
    },
    call: async (input) => {
      calls.push({ name: input.name, arguments: input.arguments });
      if (input.name === "opc.project.read_file") {
        return { content: [], structuredContent: { path: "a.txt", content: "old", sha256: "a".repeat(64), size: 3 } };
      }
      if (input.name === "opc.project.stage_write") {
        return { content: [], structuredContent: { path: "a.txt", afterSha256: "b".repeat(64) } };
      }
      if (input.name === "opc.project.list_changes") {
        return {
          content: [],
          structuredContent: {
            changes: [
              { path: "a.txt", lease: { workItemId: input.context.workItemId } },
              { path: "other.txt", lease: { workItemId: "wi-22222222-2222-4222-8222-222222222222" } },
            ],
          },
        };
      }
      return { content: [], structuredContent: {} };
    },
  });

  await tools.execute("read_file", { path: "a.txt" });
  await tools.execute("write_file", { path: "a.txt", content: "new" });

  assert.equal(calls[1]?.name, "opc.project.stage_write");
  assert.equal(calls[1]?.arguments?.baseSha256, "a".repeat(64));
  assert.deepEqual(await tools.changedPaths(), ["a.txt"]);
});

test("MCP workflow tools use a null base for a new file and expose validation", async () => {
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  const tools = createMcpWorkflowTools({
    context: {
      workflowId: "wf-11111111-1111-4111-8111-111111111111",
      workItemId: "wi-11111111-1111-4111-8111-111111111111",
      roleId: "engineer",
    },
    call: async (input) => {
      calls.push({ name: input.name, arguments: input.arguments });
      return {
        content: [],
        structuredContent:
          input.name === "opc.project.stage_write"
            ? { path: "new.txt", afterSha256: "c".repeat(64) }
            : { exitCode: 0 },
      };
    },
  });

  await tools.execute("write_file", { path: "new.txt", content: "new" });
  await tools.execute("run_validation", { profile: "unit-test" });

  assert.equal(calls[0]?.arguments?.baseSha256, null);
  assert.equal(calls[1]?.name, "opc.validation.run");
});

test("decision tool uses a domain scope instead of work item ids", async () => {
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  const tools = createMcpWorkflowTools({
    context: {
      workflowId: "wf-11111111-1111-4111-8111-111111111111",
      workItemId: "wi-11111111-1111-4111-8111-111111111111",
      roleId: "engineer",
    },
    call: async (input) => {
      calls.push({ name: input.name, arguments: input.arguments });
      return { content: [], structuredContent: { decisionId: "dr-1", workflowStatus: "waiting_user" } };
    },
  });

  await tools.execute("request_decision", {
    scope: "current_and_dependents",
    question: "采用哪个接口名？",
    options: [
      { id: "a", label: "health", impact: "兼容现有约定" },
      { id: "b", label: "status", impact: "表达更直观" },
    ],
    recommendation: "a",
    reason: "需要老板选择产品偏好。",
  });

  assert.equal(calls[0]?.name, "opc.workflow.request_decision");
  assert.equal(calls[0]?.arguments?.scope, "current_and_dependents");
  assert.equal("blockingWorkItemIds" in (calls[0]?.arguments ?? {}), false);
});

test("validation preserves a missing configuration failure instead of calling it provider rejection", async () => {
  const tools = createMcpWorkflowTools({
    context: {
      workflowId: "wf-11111111-1111-4111-8111-111111111111",
      workItemId: "wi-11111111-1111-4111-8111-111111111111",
      roleId: "engineer",
    },
    call: async () => ({
      isError: true,
      content: [{ type: "text", text: "项目没有配置 opc-validation.json" }],
    }),
  });

  await assert.rejects(
    () => tools.execute("run_validation", { profile: "frontend" }),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.failure.code === "missing_configuration" &&
      error.failure.retryable === false,
  );
});

test("review tools do not expose write_file or request_decision", () => {
  const tools = createMcpReviewTools({
    context: {
      workflowId: "wf-11111111-1111-4111-8111-111111111111",
      workItemId: "wi-11111111-1111-4111-8111-111111111111",
      roleId: "planner",
    },
    call: async () => ({ content: [], structuredContent: {} }),
  });

  const names = tools.definitions.map((definition) => definition.name);
  assert.deepEqual(names, ["list_files", "read_file", "get_diff", "list_changes", "run_validation"]);
});

test("review tools filter list_changes to the reviewed work item and never report changed paths", async () => {
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  const tools = createMcpReviewTools({
    context: {
      workflowId: "wf-11111111-1111-4111-8111-111111111111",
      workItemId: "wi-11111111-1111-4111-8111-111111111111",
      roleId: "planner",
    },
    call: async (input) => {
      calls.push({ name: input.name, arguments: input.arguments });
      if (input.name === "opc.project.get_diff") {
        return { content: [], structuredContent: { path: "a.txt", diff: "- old\n+ new" } };
      }
      if (input.name === "opc.project.list_changes") {
        return {
          content: [],
          structuredContent: {
            changes: [
              { path: "a.txt", lease: { workItemId: input.context.workItemId } },
              { path: "other.txt", lease: { workItemId: "wi-22222222-2222-4222-8222-222222222222" } },
            ],
          },
        };
      }
      return { content: [], structuredContent: {} };
    },
  });

  const diff = (await tools.execute("get_diff", { path: "a.txt" })) as { diff: string };
  assert.equal(diff.diff, "- old\n+ new");
  assert.equal(calls[0]?.name, "opc.project.get_diff");

  const changes = (await tools.execute("list_changes", {})) as { changes: { path: string }[] };
  assert.deepEqual(changes.changes.map((change) => change.path), ["a.txt"]);
  assert.deepEqual(await tools.changedPaths(), []);
});

