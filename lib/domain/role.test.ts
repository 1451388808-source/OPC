import assert from "node:assert/strict";
import test from "node:test";
import { parseRoleFile, pickInboxRole } from "./role.ts";

test("role name comes from the heading and inbox default is explicit", () => {
  const role = parseRoleFile("planner", "# 策划\n\n收件默认: 是\n");
  assert.equal(role.name, "策划");
  assert.equal(role.inboxDefault, true);
});

test("a file without the marker is not the inbox role", () => {
  const role = parseRoleFile("finance", "# 财务\n\n负责记账。\n");
  assert.equal(role.inboxDefault, false);
});

test("prompt, skills and model come from the handbook", () => {
  const role = parseRoleFile(
    "planner",
    "# 策划\n\n## 提示词\n\n把一句话收成任务。\n\n## 技能\n\n- task-shaping\n\n## 模型\n\nprovider:\nmodel:\n",
  );
  assert.equal(role.prompt, "把一句话收成任务。");
  assert.deepEqual(role.skills, ["task-shaping"]);
  assert.equal(role.model.provider, "");
  assert.equal(role.model.model, "");
});

test("inbox uses the marked role", () => {
  const chosen = pickInboxRole([
    parseRoleFile("engineer", "# 工程\n"),
    parseRoleFile("planner", "# 策划\n\n收件默认: 是\n"),
  ]);
  assert.equal(chosen?.id, "planner");
});
