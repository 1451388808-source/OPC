import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeRunWorkspace, runWorkspace } from "./run-workspace.ts";

const project = { companyId: "c-001", projectId: "p-001" };
const runId = "r-11111111-1111-4111-8111-111111111111";

async function temporaryRepo(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opc-run-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("write stages a new file without changing the project workspace", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const workspace = runWorkspace({ ...project, runId }, { repoRoot });

  const change = await workspace.write("notes.txt", "hello\n");

  assert.deepEqual(change, {
    path: "notes.txt",
    operation: "create",
    beforeSha256: null,
    afterSha256: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    beforeSize: 0,
    afterSize: 6,
  });
  assert.deepEqual(await workspace.changes(), [change]);
  await assert.rejects(
    () => fs.stat(path.join(repoRoot, "workspaces", "c-001", "p-001", "notes.txt")),
    /ENOENT/,
  );
});

test("updates preserve the first snapshot and read the staged version", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const projectFile = path.join(repoRoot, "workspaces", "c-001", "p-001", "notes.txt");
  await fs.mkdir(path.dirname(projectFile), { recursive: true });
  await fs.writeFile(projectFile, "before\n", "utf8");
  const workspace = runWorkspace({ ...project, runId }, { repoRoot });

  await workspace.write("notes.txt", "middle\n");
  const change = await workspace.write("notes.txt", "after\n");

  assert.deepEqual(change, {
    path: "notes.txt",
    operation: "update",
    beforeSha256: "9160d4be34c8695bd172a76c7c7966587ea5a4d991ad22c87b2b91af54aa9ebb",
    afterSha256: "7b9a72466d3960eb2aacccfc848939453490db0678bd4725def3f789b891c919",
    beforeSize: 7,
    afterSize: 6,
  });
  assert.equal((await workspace.read("notes.txt")).content, "after\n");
  assert.equal(await fs.readFile(projectFile, "utf8"), "before\n");
  assert.equal(
    await fs.readFile(path.join(repoRoot, ".opc", "runs", runId, "before", "notes.txt"), "utf8"),
    "before\n",
  );
});

test("diff shows the staged change without applying it", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const projectFile = path.join(repoRoot, "workspaces", "c-001", "p-001", "notes.txt");
  await fs.mkdir(path.dirname(projectFile), { recursive: true });
  await fs.writeFile(projectFile, "before\n", "utf8");
  const workspace = runWorkspace({ ...project, runId }, { repoRoot });
  await workspace.write("notes.txt", "after\n");

  const patch = await workspace.diff("notes.txt");

  assert.match(patch, /--- notes\.txt/);
  assert.match(patch, /\+\+\+ notes\.txt/);
  assert.match(patch, /-before/);
  assert.match(patch, /\+after/);
  assert.equal(await fs.readFile(projectFile, "utf8"), "before\n");
});

test("apply creates and updates all staged files", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const root = path.join(repoRoot, "workspaces", "c-001", "p-001");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "existing.txt"), "before\n", "utf8");
  const workspace = runWorkspace({ ...project, runId }, { repoRoot });
  await workspace.write("existing.txt", "after\n");
  await workspace.write("nested/new.txt", "new\n");

  const result = await workspace.apply();

  assert.deepEqual(result, { paths: ["existing.txt", "nested/new.txt"] });
  assert.equal(await fs.readFile(path.join(root, "existing.txt"), "utf8"), "after\n");
  assert.equal(await fs.readFile(path.join(root, "nested", "new.txt"), "utf8"), "new\n");
});

test("apply stops before writing when a project file has changed", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const root = path.join(repoRoot, "workspaces", "c-001", "p-001");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "existing.txt"), "before\n", "utf8");
  const workspace = runWorkspace({ ...project, runId }, { repoRoot });
  await workspace.write("existing.txt", "after\n");
  await workspace.write("new.txt", "new\n");
  await fs.writeFile(path.join(root, "existing.txt"), "external\n", "utf8");

  await assert.rejects(() => workspace.apply(), /文件已变化：existing\.txt/);

  assert.equal(await fs.readFile(path.join(root, "existing.txt"), "utf8"), "external\n");
  await assert.rejects(() => fs.stat(path.join(root, "new.txt")), /ENOENT/);
});

test("apply restores earlier files when a later write fails", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const root = path.join(repoRoot, "workspaces", "c-001", "p-001");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "a.txt"), "before\n", "utf8");
  let replacements = 0;
  const workspace = runWorkspace(
    { ...project, runId },
    {
      repoRoot,
      writer: {
        async replace(file, content) {
          replacements += 1;
          if (replacements === 2) throw new Error("injected write failure");
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, content);
        },
        async remove(file) {
          await fs.rm(file, { force: true });
        },
      },
    },
  );
  await workspace.write("a.txt", "after\n");
  await workspace.write("b.txt", "new\n");

  await assert.rejects(() => workspace.apply(), /injected write failure/);

  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "before\n");
  await assert.rejects(() => fs.stat(path.join(root, "b.txt")), /ENOENT/);
});

test("apply restores files when the finalize callback fails", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const root = path.join(repoRoot, "workspaces", "c-001", "p-001");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "existing.txt"), "before\n", "utf8");
  const workspace = runWorkspace({ ...project, runId }, { repoRoot });
  await workspace.write("existing.txt", "after\n");
  await workspace.write("new.txt", "new\n");

  await assert.rejects(
    () =>
      workspace.apply(async () => {
        throw new Error("database finalize failed");
      }),
    /database finalize failed/,
  );

  assert.equal(await fs.readFile(path.join(root, "existing.txt"), "utf8"), "before\n");
  await assert.rejects(() => fs.stat(path.join(root, "new.txt")), /ENOENT/);
});

test("run workspace enforces execution id, file count, and total size limits", async (t) => {
  const repoRoot = await temporaryRepo(t);
  assert.throws(
    () => runWorkspace({ ...project, runId: "run-1" }, { repoRoot }),
    /执行编号不合法/,
  );

  const countWorkspace = runWorkspace({ ...project, runId }, { repoRoot });
  for (let index = 0; index < 20; index += 1) {
    await countWorkspace.write(`file-${index}.txt`, "x");
  }
  await assert.rejects(() => countWorkspace.write("file-20.txt", "x"), /最多修改 20 个文件/);

  const sizeWorkspace = runWorkspace(
    { ...project, runId: "r-22222222-2222-4222-8222-222222222222" },
    { repoRoot },
  );
  const chunk = "a".repeat(900 * 1024);
  for (let index = 0; index < 5; index += 1) {
    await sizeWorkspace.write(`large-${index}.txt`, chunk);
  }
  await assert.rejects(() => sizeWorkspace.write("large-5.txt", chunk), /暂存内容超过 5 MiB/);
});

test("write rejects a symlink in the run storage root", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const outside = path.join(repoRoot, "outside");
  await fs.mkdir(path.join(repoRoot, ".opc"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.symlink(outside, path.join(repoRoot, ".opc", "runs"), "junction");
  const workspace = runWorkspace({ ...project, runId }, { repoRoot });

  await assert.rejects(() => workspace.write("notes.txt", "hello\n"), /符号链接/);
  await assert.rejects(() => fs.stat(path.join(outside, runId, "manifest.json")), /ENOENT/);
});

test("write rejects file formats that require binary encoders", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const workspace = runWorkspace({ ...project, runId }, { repoRoot });

  await assert.rejects(() => workspace.write("文档/作文.docx", "plain text"), /只支持文本文件/);
  await assert.rejects(() => workspace.write("slides.pptx", "plain text"), /只支持文本文件/);
  await assert.rejects(() => workspace.write("report.pdf", "plain text"), /只支持文本文件/);
  assert.equal((await workspace.write("文档/作文.doc", "<!DOCTYPE html>\n")).operation, "create");
});

test("run workspace cleanup removes only a validated run directory", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const workspace = runWorkspace({ ...project, runId }, { repoRoot });
  await workspace.write("notes.txt", "hello\n");

  await removeRunWorkspace(runId, { repoRoot });

  await assert.rejects(() => fs.stat(path.join(repoRoot, ".opc", "runs", runId)), /ENOENT/);
  await assert.rejects(() => removeRunWorkspace("../outside", { repoRoot }), /执行编号不合法/);
});
