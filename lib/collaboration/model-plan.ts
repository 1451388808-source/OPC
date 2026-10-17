import { z } from "zod";
import type { RoleDefinition } from "../domain/role.ts";
import type { WorkItemDraft } from "../application/collaboration.ts";

const planSchema = z.object({
  summary: z.string().trim().min(1),
  workItems: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
        title: z.string().trim().min(1).max(100),
        objective: z.string().trim().min(1),
        acceptance: z.array(z.string().trim().min(1)).min(1).max(7),
        ownerRoleId: z.string().min(1),
        dependsOn: z.array(z.string()).default([]),
      }),
    )
    .min(1)
    .max(8),
});

export type WorkflowPlan = z.infer<typeof planSchema>;

function jsonObject(text: string): unknown {
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("协调员工没有返回 JSON 计划");
  return JSON.parse(unfenced.slice(start, end + 1));
}

export async function generateWorkflowPlan(input: {
  requestText: string;
  coordinator: RoleDefinition;
  members: RoleDefinition[];
  complete?: (input: { model: string; system: string; user: string }) => Promise<{ text: string }>;
}): Promise<WorkflowPlan> {
  const memberLines = input.members.map(
    (member) => `- ${member.id}：${member.name}；技能：${member.skills.join("、") || "未配置"}`,
  );
  const system = [
    input.coordinator.prompt || `你是 OPC 的${input.coordinator.name}。`,
    "你负责把老板的一条项目任务拆成 1-8 个可以独立认领的工作项。",
    "每个工作项只有一个主责；依赖使用其他工作项的 key。当前不安排 AI 复核员工，最终产出由老板批准。",
    "代码、页面、配置或验证类工作，优先分给名称或技能显示为工程、实现或开发职责的员工。",
    "协调员工负责拆分和依赖；只要项目中有合适员工，就不要把实现工作分给自己。",
    "验收必须可通过文件、工具结果或明确产出来检查。只使用下面列出的员工 id。",
    "只返回 JSON，不要 Markdown，不要解释。格式：",
    '{"summary":"计划摘要","workItems":[{"key":"implement","title":"标题","objective":"目标","acceptance":["产出"],"ownerRoleId":"engineer","dependsOn":[]}]}',
    "项目成员：",
    ...memberLines,
  ].join("\n");
  const complete =
    input.complete ??
    (async (request) => {
      const { callDeepSeek } = await import("../employees/deepseek.ts");
      return callDeepSeek(request);
    });
  const result = await complete({
    model: input.coordinator.model.model,
    system,
    user: input.requestText,
  });
  const plan = planSchema.parse(jsonObject(result.text));
  const memberIds = new Set(input.members.map((member) => member.id));
  const keys = new Set(plan.workItems.map((item) => item.key));
  for (const item of plan.workItems) {
    if (!memberIds.has(item.ownerRoleId)) throw new Error(`计划使用了不在项目中的员工：${item.ownerRoleId}`);
    for (const dependency of item.dependsOn) {
      if (!keys.has(dependency)) throw new Error(`计划依赖了未知工作项：${dependency}`);
    }
  }
  return plan;
}

export function planDrafts(plan: WorkflowPlan): WorkItemDraft[] {
  return plan.workItems.map((item) => ({
    key: item.key,
    title: item.title,
    objective: item.objective,
    acceptance: item.acceptance,
    ownerRoleId: item.ownerRoleId,
    reviewerRoleId: null,
    dependsOn: item.dependsOn,
  }));
}

