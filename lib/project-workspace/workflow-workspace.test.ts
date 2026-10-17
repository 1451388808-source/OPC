import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeWorkflowWorkspace, workflowWorkspace } from "./workflow-workspace.ts";

const project = { companyId: "c-001", projectId: "p-001" };
const workflowId = "wf-11111111-1111-4111-8111-111111111111";
const firstItem = "wi-11111111-1111-4111-8111-111111111111";
const secondItem = "wi-22222222-2222-4222-8222-222222222222";

async function fixture(t: test.TestContext) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opc-workflow-"));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  const projectRoot = path.join(repoRoot, "workspaces", project.companyId, project.projectId);
  await fs.mkdir(projectRoot, { recursive: true });
  return { repoRoot, projectRoot };
}

test("workflow workspace stages a new file with a work-item lease", async (t) => {
  const { repoRoot, projectRoot } = await fixture(t);
  const workspace = workflowWorkspace({ ...project, workflowId }, { repoRoot });
  const change = await workspace.write({
    path: "notes.txt",
    content: "hello\n",
    baseSha256: null,
    workItemId: firstItem,
    roleId: "engineer",
    updatedAt: "2026-10-13T15:00:00+08:00",
  });

  assert.equal(change.operation, "create");
  assert.equal(await fs.stat(projectRoot).then((info) => info.isDirectory()), true);
  await assert.rejects(() => fs.readFile(path.join(projectRoot, "notes.txt")), /ENOENT/);
  assert.equal((await workspace.read("notes.txt")).content, "hello\n");
  assert.equal((await workspace.changes())[0]?.lease?.workItemId, firstItem);
  await workspace.releaseWorkItemLeases(firstItem);
  assert.equal((await workspace.changes())[0]?.lease, null);
});

test("workflow workspace rejects another work item and stale staged hashes", async (t) => {
  const { repoRoot } = await fixture(t);
  const workspace = workflowWorkspace({ ...project, workflowId }, { repoRoot });
  const first = await workspace.write({
    path: "notes.txt",
    content: "one\n",
    baseSha256: null,
    workItemId: firstItem,
    roleId: "engineer",
    updatedAt: "2026-10-13T15:00:00+08:00",
  });
  await assert.rejects(
    () =>
      workspace.write({
        path: "notes.txt",
        content: "two\n",
        baseSha256: first.afterSha256,
        workItemId: secondItem,
        roleId: "researcher",
        updatedAt: "2026-10-13T15:01:00+08:00",
      }),
    /正由工作项/,
  );
  await assert.rejects(
    () =>
      workspace.write({
        path: "notes.txt",
        content: "three\n",
        baseSha256: "a".repeat(64),
        workItemId: firstItem,
        roleId: "engineer",
        updatedAt: "2026-10-13T15:02:00+08:00",
      }),
    /暂存版本已变化/,
  );
});

test("workflow workspace updates from the formal hash and produces a diff", async (t) => {
  const { repoRoot, projectRoot } = await fixture(t);
  await fs.writeFile(path.join(projectRoot, "notes.txt"), "before\n", "utf8");
  const workspace = workflowWorkspace({ ...project, workflowId }, { repoRoot });
  const formal = await workspace.read("notes.txt");
  const change = await workspace.write({
    path: "notes.txt",
    content: "after\n",
    baseSha256: formal.sha256,
    workItemId: firstItem,
    roleId: "engineer",
    updatedAt: "2026-10-13T15:00:00+08:00",
  });

  assert.equal(change.operation, "update");
  assert.match(await workspace.diff("notes.txt"), /-before/);
  assert.match(await workspace.diff("notes.txt"), /\+after/);
  assert.equal(await fs.readFile(path.join(projectRoot, "notes.txt"), "utf8"), "before\n");
  await workspace.apply();
  assert.equal(await fs.readFile(path.join(projectRoot, "notes.txt"), "utf8"), "after\n");
});

test("workflow workspace refuses apply after the formal file changes", async (t) => {
  const { repoRoot, projectRoot } = await fixture(t);
  await fs.writeFile(path.join(projectRoot, "notes.txt"), "before\n", "utf8");
  const workspace = workflowWorkspace({ ...project, workflowId }, { repoRoot });
  const formal = await workspace.read("notes.txt");
  await workspace.write({
    path: "notes.txt",
    content: "after\n",
    baseSha256: formal.sha256,
    workItemId: firstItem,
    roleId: "engineer",
    updatedAt: "2026-10-13T15:00:00+08:00",
  });
  await fs.writeFile(path.join(projectRoot, "notes.txt"), "external\n", "utf8");

  await assert.rejects(() => workspace.apply(), /文件已变化/);
  assert.equal(await fs.readFile(path.join(projectRoot, "notes.txt"), "utf8"), "external\n");
});

test("workflow workspace allows up to 100 staged files and rejects the 101st", async (t) => {
  const { repoRoot } = await fixture(t);
  const workspace = workflowWorkspace({ ...project, workflowId }, { repoRoot });
  for (let index = 0; index < 100; index += 1) {
    await workspace.write({
      path: `file-${index}.txt`,
      content: "x",
      baseSha256: null,
      workItemId: firstItem,
      roleId: "engineer",
      updatedAt: "2026-10-13T15:00:00+08:00",
    });
  }
  await assert.rejects(
    () =>
      workspace.write({
        path: "file-100.txt",
        content: "x",
        baseSha256: null,
        workItemId: firstItem,
        roleId: "engineer",
        updatedAt: "2026-10-13T15:00:00+08:00",
      }),
    /最多修改 100 个文件/,
  );
});

test("workflow workspace cleanup removes only a validated workflow directory", async (t) => {
  const { repoRoot } = await fixture(t);
  const workspace = workflowWorkspace({ ...project, workflowId }, { repoRoot });
  await workspace.write({
    path: "notes.txt",
    content: "cleanup\n",
    baseSha256: null,
    workItemId: firstItem,
    roleId: "engineer",
    updatedAt: "2026-10-13T15:00:00+08:00",
  });
  await removeWorkflowWorkspace(workflowId, { repoRoot });
  await assert.rejects(() => fs.stat(path.join(repoRoot, ".opc", "workflows", workflowId)), /ENOENT/);
  await assert.rejects(() => removeWorkflowWorkspace("workflow-1", { repoRoot }), /编号不合法/);
});

