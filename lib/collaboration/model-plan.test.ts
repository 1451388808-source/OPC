import assert from "node:assert/strict";
import test from "node:test";
import { generateWorkflowPlan, planDrafts } from "./model-plan.ts";
import type { RoleDefinition } from "../domain/role.ts";

const planner: RoleDefinition = {
  id: "planner",
  name: "策划",
  inboxDefault: true,
  prompt: "拆分任务",
  skills: ["task-shaping"],
  model: { provider: "deepseek", model: "deepseek-flash" },
};
const engineer: RoleDefinition = {
  ...planner,
  id: "engineer",
  name: "工程",
  inboxDefault: false,
  skills: ["implement-and-verify"],
};

test("model plan assigns implementation without an AI reviewer", async () => {
  const plan = await generateWorkflowPlan({
    requestText: "实现页面",
    coordinator: planner,
    members: [planner, engineer],
    complete: async ({ system }) => {
      assert.match(system, /代码、页面、配置或验证.*工程/);
      assert.match(system, /协调员工.*不要把实现工作分给自己/);
      assert.match(system, /不安排 AI 复核员工/);
      return {
        text: JSON.stringify({
        summary: "工程实现",
        workItems: [
          {
            key: "implement",
            title: "实现",
            objective: "实现页面",
            acceptance: ["页面文件存在"],
            ownerRoleId: "engineer",
            reviewerRoleId: "planner",
            dependsOn: [],
          },
        ],
        }),
      };
    },
  });

  assert.equal(plan.summary, "工程实现");
  assert.equal(planDrafts(plan)[0]?.ownerRoleId, "engineer");
  assert.equal(planDrafts(plan)[0]?.reviewerRoleId, null);
});

test("model plan rejects employees outside the project", async () => {
  await assert.rejects(
    () =>
      generateWorkflowPlan({
        requestText: "实现页面",
        coordinator: planner,
        members: [planner, engineer],
        complete: async () => ({
          text: JSON.stringify({
            summary: "错误计划",
            workItems: [
              {
                key: "implement",
                title: "实现",
                objective: "实现页面",
                acceptance: ["页面文件存在"],
                ownerRoleId: "outsider",
                reviewerRoleId: null,
                dependsOn: [],
              },
            ],
          }),
        }),
      }),
    /不在项目中的员工/,
  );
});

