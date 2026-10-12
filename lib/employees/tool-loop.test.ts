import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectFileTools } from "./tools.ts";
import {
  executeToolLoop,
  type ToolCallingModel,
  type ToolModelTurn,
} from "./tool-loop.ts";
import { projectWorkspace } from "../project-workspace/index.ts";
import { runWorkspace } from "../project-workspace/run-workspace.ts";

const runId = "r-11111111-1111-4111-8111-111111111111";

async function temporaryRepo(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opc-tool-loop-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("tool loop lists, reads, and stages a file before returning a summary", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const ref = { companyId: "c-001", projectId: "p-001" };
  const project = projectWorkspace(ref, { repoRoot });
  await project.ensure();
  await fs.writeFile(path.join(repoRoot, "workspaces", "c-001", "p-001", "README.md"), "# Demo\n", "utf8");
  const run = runWorkspace({ ...ref, runId }, { repoRoot });
  const tools = createProjectFileTools({ project, run });
  const turns: ToolModelTurn[] = [
    {
      text: "",
      reasoning: "先看文件。",
      toolCalls: [{ id: "call-1", name: "list_files", arguments: '{"path":".","depth":2}' }],
    },
    {
      text: "",
      reasoning: "读取说明。",
      toolCalls: [{ id: "call-2", name: "read_file", arguments: '{"path":"README.md"}' }],
    },
    {
      text: "",
      reasoning: "写入工作结果。",
      toolCalls: [
        { id: "call-3", name: "write_file", arguments: '{"path":"notes.txt","content":"done\\n"}' },
      ],
    },
    { text: "已生成 notes.txt。", reasoning: "", toolCalls: [] },
  ];
  const model: ToolCallingModel = {
    async complete(request) {
      const next = turns.shift();
      assert.ok(next);
      if (request.messages.some((message) => message.role === "tool")) {
        const latest = [...request.messages].reverse().find((message) => message.role === "tool");
        assert.match(latest?.content ?? "", /"ok":true/);
      }
      return next;
    },
  };
  const events: { kind: string; body: unknown }[] = [];

  const result = await executeToolLoop({
    model,
    modelName: "fake",
    system: "你是工程。",
    user: "查看项目并生成 notes.txt。",
    tools,
    emit: async (event) => events.push(event),
  });

  assert.deepEqual(result, { summary: "已生成 notes.txt。", changedPaths: ["notes.txt"] });
  assert.equal((await run.read("notes.txt")).content, "done\n");
  await assert.rejects(
    () => fs.stat(path.join(repoRoot, "workspaces", "c-001", "p-001", "notes.txt")),
    /ENOENT/,
  );
  assert.equal(events.filter((event) => event.kind === "tool_call").length, 3);
  assert.equal(events.filter((event) => event.kind === "tool_result").length, 3);
});

test("tool errors return to the model without creating fake changes", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const ref = { companyId: "c-001", projectId: "p-001" };
  const project = projectWorkspace(ref, { repoRoot });
  await project.ensure();
  const run = runWorkspace({ ...ref, runId }, { repoRoot });
  const tools = createProjectFileTools({ project, run });
  let turn = 0;
  const model: ToolCallingModel = {
    async complete(request) {
      turn += 1;
      if (turn === 1) {
        return {
          text: "",
          reasoning: "",
          toolCalls: [{ id: "bad", name: "read_file", arguments: '{"path":"../outside.txt"}' }],
        };
      }
      const result = [...request.messages].reverse().find((message) => message.role === "tool");
      assert.match(result?.content ?? "", /"ok":false/);
      return { text: "没有修改文件。", reasoning: "", toolCalls: [] };
    },
  };

  const result = await executeToolLoop({
    model,
    modelName: "fake",
    system: "system",
    user: "user",
    tools,
    emit: async () => {},
  });

  assert.deepEqual(result, { summary: "没有修改文件。", changedPaths: [] });
});

test("tool loop stops repeated calls and enforces call limits", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const ref = { companyId: "c-001", projectId: "p-001" };
  const project = projectWorkspace(ref, { repoRoot });
  await project.ensure();
  const run = runWorkspace({ ...ref, runId }, { repoRoot });
  const tools = createProjectFileTools({ project, run });
  const repeated: ToolCallingModel = {
    async complete() {
      return {
        text: "",
        reasoning: "",
        toolCalls: [{ id: randomId(), name: "list_files", arguments: '{"path":".","depth":1}' }],
      };
    },
  };

  await assert.rejects(
    () =>
      executeToolLoop({
        model: repeated,
        modelName: "fake",
        system: "system",
        user: "user",
        tools,
        emit: async () => {},
      }),
    /连续重复/,
  );

  await assert.rejects(
    () =>
      executeToolLoop({
        model: repeated,
        modelName: "fake",
        system: "system",
        user: "user",
        tools,
        emit: async () => {},
        limits: { maxToolCalls: 1, maxRepeatedCalls: 10 },
      }),
    /工具调用超过 1 次/,
  );
});

test("tool loop aborts a model call after the configured duration", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const ref = { companyId: "c-001", projectId: "p-001" };
  const project = projectWorkspace(ref, { repoRoot });
  await project.ensure();
  const run = runWorkspace({ ...ref, runId }, { repoRoot });
  const tools = createProjectFileTools({ project, run });
  const blocked: ToolCallingModel = {
    async complete() {
      return new Promise(() => {});
    },
  };

  await assert.rejects(
    () =>
      executeToolLoop({
        model: blocked,
        modelName: "fake",
        system: "system",
        user: "user",
        tools,
        emit: async () => {},
        limits: { maxDurationMs: 20 },
      }),
    /执行超时/,
  );
});

test("tool loop stops after three equivalent tool errors", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const ref = { companyId: "c-001", projectId: "p-001" };
  const project = projectWorkspace(ref, { repoRoot });
  await project.ensure();
  const run = runWorkspace({ ...ref, runId }, { repoRoot });
  const tools = createProjectFileTools({ project, run });
  let attempt = 0;
  const invalidReads: ToolCallingModel = {
    async complete() {
      attempt += 1;
      return {
        text: "",
        reasoning: "",
        toolCalls: [
          {
            id: `bad-${attempt}`,
            name: "read_file",
            arguments: JSON.stringify({ path: `../outside-${attempt}.txt` }),
          },
        ],
      };
    },
  };

  await assert.rejects(
    () =>
      executeToolLoop({
        model: invalidReads,
        modelName: "fake",
        system: "system",
        user: "user",
        tools,
        emit: async () => {},
      }),
    /同类工具错误达到 3 次/,
  );
});

let sequence = 0;
function randomId(): string {
  sequence += 1;
  return `call-${sequence}`;
}
