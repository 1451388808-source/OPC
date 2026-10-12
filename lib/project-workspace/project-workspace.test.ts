import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { projectWorkspace } from "./index.ts";

async function temporaryRepo(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opc-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("ensure creates the deterministic project workspace", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const workspace = projectWorkspace({ companyId: "c-001", projectId: "p-001" }, { repoRoot });

  await workspace.ensure();

  const info = await fs.stat(path.join(repoRoot, "workspaces", "c-001", "p-001"));
  assert.equal(info.isDirectory(), true);
});

test("workspace rejects invalid company and project ids", async (t) => {
  const repoRoot = await temporaryRepo(t);

  assert.throws(
    () => projectWorkspace({ companyId: "../company", projectId: "p-001" }, { repoRoot }),
    /公司编号不合法/,
  );
  assert.throws(
    () => projectWorkspace({ companyId: "c-001", projectId: "project" }, { repoRoot }),
    /项目编号不合法/,
  );
});

test("list returns sorted project entries and hides internal directories", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const root = path.join(repoRoot, "workspaces", "c-001", "p-001");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await fs.mkdir(path.join(root, ".cache"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), "hello\n", "utf8");
  await fs.writeFile(path.join(root, "src", "app.ts"), "export {};\n", "utf8");
  await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "ignored\n", "utf8");
  await fs.writeFile(path.join(root, ".cache", "state"), "ignored\n", "utf8");
  const workspace = projectWorkspace({ companyId: "c-001", projectId: "p-001" }, { repoRoot });

  const entries = await workspace.list({ depth: 3 });

  assert.deepEqual(entries, [
    { path: "README.md", type: "file", size: 6 },
    { path: "src", type: "directory", size: 0 },
    { path: "src/app.ts", type: "file", size: 11 },
  ]);
});

test("read returns UTF-8 content, byte size, and SHA-256", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const root = path.join(repoRoot, "workspaces", "c-001", "p-001");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), "hello\n", "utf8");
  const workspace = projectWorkspace({ companyId: "c-001", projectId: "p-001" }, { repoRoot });

  const file = await workspace.read("README.md");

  assert.deepEqual(file, {
    path: "README.md",
    content: "hello\n",
    size: 6,
    sha256: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
  });
});

test("read rejects paths outside the project and internal directories", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const root = path.join(repoRoot, "workspaces", "c-001", "p-001");
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "workspaces", "c-001", "outside.txt"), "secret\n", "utf8");
  await fs.writeFile(path.join(root, ".git", "config"), "secret\n", "utf8");
  const workspace = projectWorkspace({ companyId: "c-001", projectId: "p-001" }, { repoRoot });

  const invalid = [
    "../outside.txt",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "C:\\Windows\\win.ini",
    "\\\\server\\share\\file.txt",
    "src\\..\\outside.txt",
    "bad\0name.txt",
    "file.txt:secret",
    "node_modules./pkg/index.js",
    "CON",
    "aux.txt",
    ".git/config",
    "node_modules/pkg/index.js",
  ];
  for (const candidate of invalid) {
    await assert.rejects(() => workspace.read(candidate), /路径不合法|禁止访问/);
  }
});

test("read rejects a symlink that escapes the project workspace", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const root = path.join(repoRoot, "workspaces", "c-001", "p-001");
  const outside = path.join(repoRoot, "outside");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "secret.txt"), "secret\n", "utf8");
  await fs.symlink(outside, path.join(root, "linked"), "junction");
  const workspace = projectWorkspace({ companyId: "c-001", projectId: "p-001" }, { repoRoot });

  await assert.rejects(() => workspace.read("linked/secret.txt"), /符号链接/);
});

test("list rejects symlinks instead of silently hiding them", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const root = path.join(repoRoot, "workspaces", "c-001", "p-001");
  const outside = path.join(repoRoot, "outside");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.symlink(outside, path.join(root, "linked"), "junction");
  const workspace = projectWorkspace({ companyId: "c-001", projectId: "p-001" }, { repoRoot });

  await assert.rejects(() => workspace.list(), /符号链接/);
});

test("read rejects oversized and binary files", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const root = path.join(repoRoot, "workspaces", "c-001", "p-001");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 97));
  await fs.writeFile(path.join(root, "binary.txt"), Buffer.from([97, 0, 98]));
  await fs.writeFile(path.join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
  const workspace = projectWorkspace({ companyId: "c-001", projectId: "p-001" }, { repoRoot });

  await assert.rejects(() => workspace.read("large.txt"), /超过 1 MiB/);
  await assert.rejects(() => workspace.read("binary.txt"), /二进制/);
  await assert.rejects(() => workspace.read("invalid.txt"), /UTF-8/);
});

test("list supports a guarded subdirectory and bounded depth", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const root = path.join(repoRoot, "workspaces", "c-001", "p-001");
  await fs.mkdir(path.join(root, "src", "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
  await fs.writeFile(path.join(root, "src", "nested", "deep.ts"), "export {};\n", "utf8");
  const workspace = projectWorkspace({ companyId: "c-001", projectId: "p-001" }, { repoRoot });

  assert.deepEqual(await workspace.list({ path: "src", depth: 1 }), [
    { path: "src/index.ts", type: "file", size: 11 },
    { path: "src/nested", type: "directory", size: 0 },
  ]);
  await assert.rejects(() => workspace.list({ path: "../outside", depth: 1 }), /路径不合法/);
  await assert.rejects(() => workspace.list({ depth: 0 }), /深度/);
  await assert.rejects(() => workspace.list({ depth: 6 }), /深度/);
});

test("list rejects more than 500 visible entries", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const root = path.join(repoRoot, "workspaces", "c-001", "p-001");
  await fs.mkdir(root, { recursive: true });
  await Promise.all(
    Array.from({ length: 501 }, (_, index) =>
      fs.writeFile(path.join(root, `file-${String(index).padStart(3, "0")}.txt`), "x", "utf8"),
    ),
  );
  const workspace = projectWorkspace({ companyId: "c-001", projectId: "p-001" }, { repoRoot });

  await assert.rejects(() => workspace.list(), /超过 500/);
});

test("ensure rejects symlinks in the project root chain", async (t) => {
  const repoRoot = await temporaryRepo(t);
  const workspaces = path.join(repoRoot, "workspaces");
  const outside = path.join(repoRoot, "outside");
  await fs.mkdir(workspaces, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.symlink(outside, path.join(workspaces, "c-001"), "junction");
  const workspace = projectWorkspace({ companyId: "c-001", projectId: "p-001" }, { repoRoot });

  await assert.rejects(() => workspace.ensure(), /符号链接/);
  await assert.rejects(() => fs.stat(path.join(outside, "p-001")), /ENOENT/);
});
