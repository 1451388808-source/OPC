import { z } from "zod";

export const WORKFLOW_STATUSES = [
  "intake",
  "planning",
  "collaborating",
  "waiting_user",
  "verifying",
  "review",
  "applying",
  "approved",
  "returned",
  "failed",
  "cancelled",
] as const;

export const WORK_ITEM_STATUSES = [
  "queued",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
  "failed",
  "cancelled",
] as const;

export const PROJECT_EVENT_KINDS = [
  "user_message",
  "agent_message",
  "workflow_created",
  "workflow_status",
  "work_item_created",
  "work_item_status",
  "handoff",
  "tool_call",
  "tool_result",
  "artifact",
  "decision_requested",
  "decision_resolved",
  "verification",
  "review_submitted",
  "approval",
  "return",
  "error",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export type ProjectEventKind = (typeof PROJECT_EVENT_KINDS)[number];
export type ProjectEventActorType = "boss" | "agent" | "system" | "tool";

export type ProjectWorkflow = {
  id: string;
  projectId: string;
  taskId: string | null;
  sourceEventId: number | null;
  title: string;
  requestText: string;
  coordinatorRoleId: string;
  status: WorkflowStatus;
  summary: string;
  errorText: string;
  returnReason: string;
  cancelReason: string;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
};

export type ProjectWorkItem = {
  id: string;
  workflowId: string;
  position: number;
  title: string;
  objective: string;
  acceptance: string[];
  ownerRoleId: string;
  reviewerRoleId: string | null;
  status: WorkItemStatus;
  blockedReason: string;
  summary: string;
  evidence: string[];
  errorText: string;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkItemDependency = {
  workItemId: string;
  dependsOnWorkItemId: string;
};

export type ProjectEvent = {
  id: number;
  projectId: string;
  workflowId: string | null;
  workItemId: string | null;
  actorType: ProjectEventActorType;
  actorId: string | null;
  kind: ProjectEventKind;
  body: unknown;
  createdAt: string;
};

export type DecisionOption = {
  id: string;
  label: string;
  impact: string;
};

export function decisionRecommendationId(
  options: DecisionOption[],
  recommendation: string,
): string | null {
  const value = recommendation.trim();
  const direct = options.find(
    (option) => option.id.toLocaleLowerCase() === value.toLocaleLowerCase() || option.label === value,
  );
  if (direct) return direct.id;

  const stated = value
    .replace(/^(?:(?:我)?(?:推荐|建议|首选)(?:项|选项)?(?:选择|选)?)[\s:：-]*/u, "")
    .trim();
  const choices = options
    .flatMap((option) => [
      { option, text: option.id },
      { option, text: option.label },
    ])
    .sort((left, right) => Array.from(right.text).length - Array.from(left.text).length);
  for (const choice of choices) {
    if (!stated.toLocaleLowerCase().startsWith(choice.text.toLocaleLowerCase())) continue;
    const next = stated.slice(choice.text.length, choice.text.length + 1);
    if (!next || /[\s:：,，。;；()（）\-—]/u.test(next)) return choice.option.id;
  }
  return null;
}

export type ProjectDecisionRequest = {
  id: string;
  workflowId: string;
  workItemId: string | null;
  askedByRoleId: string;
  question: string;
  options: DecisionOption[];
  recommendation: string;
  reason: string;
  blockingWorkItemIds: string[];
  status: "open" | "resolved" | "cancelled";
  answer: string;
  createdAt: string;
  resolvedAt: string | null;
};

export type WorkflowArtifact = {
  id: string;
  workflowId: string;
  workItemId: string | null;
  createdByRoleId: string;
  kind: string;
  relativeRef: string;
  sha256: string | null;
  sizeBytes: number | null;
  metadata: unknown;
  createdAt: string;
};

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const workflowIdSchema = z.string().regex(new RegExp(`^wf-${uuidPattern}$`, "i"));
const workItemIdSchema = z.string().regex(new RegExp(`^wi-${uuidPattern}$`, "i"));
const decisionIdSchema = z.string().regex(new RegExp(`^dr-${uuidPattern}$`, "i"));
const artifactIdSchema = z.string().regex(new RegExp(`^a-${uuidPattern}$`, "i"));
const roleIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

export const projectWorkflowSchema = z.object({
  id: workflowIdSchema,
  projectId: z.string().regex(/^p-\d{3}$/),
  taskId: z.string().regex(/^t-\d{3}$/).nullable(),
  sourceEventId: z.number().int().positive().nullable(),
  title: z.string().trim().min(1).max(300),
  requestText: z.string().trim().min(1),
  coordinatorRoleId: roleIdSchema,
  status: z.enum(WORKFLOW_STATUSES),
  summary: z.string(),
  errorText: z.string(),
  returnReason: z.string(),
  cancelReason: z.string(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  approvedAt: z.string().min(1).nullable(),
});

export const projectWorkItemSchema = z
  .object({
    id: workItemIdSchema,
    workflowId: workflowIdSchema,
    position: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(300),
    objective: z.string().trim().min(1),
    acceptance: z.array(z.string().trim().min(1)).min(1),
    ownerRoleId: roleIdSchema,
    reviewerRoleId: roleIdSchema.nullable(),
    status: z.enum(WORK_ITEM_STATUSES),
    blockedReason: z.string(),
    summary: z.string(),
    evidence: z.array(z.string().trim().min(1)),
    errorText: z.string(),
    retryCount: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .refine((item) => item.reviewerRoleId === null || item.reviewerRoleId !== item.ownerRoleId, {
    message: "复核员工不能与主责员工相同",
    path: ["reviewerRoleId"],
  });

export const projectEventSchema = z.object({
  id: z.number().int().nonnegative(),
  projectId: z.string().regex(/^p-\d{3}$/),
  workflowId: workflowIdSchema.nullable(),
  workItemId: workItemIdSchema.nullable(),
  actorType: z.enum(["boss", "agent", "system", "tool"]),
  actorId: z.string().min(1).max(128).nullable(),
  kind: z.enum(PROJECT_EVENT_KINDS),
  body: z.unknown(),
  createdAt: z.string().min(1),
});

export const projectDecisionRequestSchema = z.object({
  id: decisionIdSchema,
  workflowId: workflowIdSchema,
  workItemId: workItemIdSchema.nullable(),
  askedByRoleId: roleIdSchema,
  question: z.string().trim().min(1),
  options: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(40),
        label: z.string().trim().min(1),
        impact: z.string().trim().min(1),
      }),
    )
    .min(2),
  recommendation: z.string().trim().max(100),
  reason: z.string().trim().min(1),
  blockingWorkItemIds: z.array(workItemIdSchema),
  status: z.enum(["open", "resolved", "cancelled"]),
  answer: z.string(),
  createdAt: z.string().min(1),
  resolvedAt: z.string().min(1).nullable(),
});

export const workflowArtifactSchema = z.object({
  id: artifactIdSchema,
  workflowId: workflowIdSchema,
  workItemId: workItemIdSchema.nullable(),
  createdByRoleId: roleIdSchema,
  kind: z.string().trim().min(1).max(48),
  relativeRef: z
    .string()
    .trim()
    .min(1)
    .max(700)
    .refine(
      (value) =>
        !value.startsWith("/") &&
        !value.includes("\\") &&
        value.split("/").every((segment) => segment && segment !== "." && segment !== ".."),
      "产出引用必须是安全的相对路径",
    ),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  metadata: z.unknown(),
  createdAt: z.string().min(1),
});

const workflowTransitions: Record<WorkflowStatus, WorkflowStatus[]> = {
  intake: ["planning", "failed", "cancelled"],
  planning: ["collaborating", "waiting_user", "failed", "cancelled"],
  collaborating: ["waiting_user", "verifying", "failed", "cancelled"],
  waiting_user: ["collaborating", "verifying", "failed", "cancelled"],
  verifying: ["collaborating", "waiting_user", "review", "failed", "cancelled"],
  review: ["applying", "returned", "cancelled"],
  applying: ["approved", "review", "failed"],
  approved: [],
  returned: ["collaborating", "cancelled"],
  failed: ["collaborating", "cancelled"],
  cancelled: [],
};

const workItemTransitions: Record<WorkItemStatus, WorkItemStatus[]> = {
  queued: ["ready", "blocked", "cancelled"],
  ready: ["running", "blocked", "cancelled"],
  running: ["blocked", "review", "failed", "cancelled"],
  blocked: ["queued", "ready", "running", "failed", "cancelled"],
  review: ["done", "ready", "running", "blocked", "cancelled"],
  done: [],
  failed: ["ready", "cancelled"],
  cancelled: [],
};

export class CollaborationRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollaborationRuleError";
  }
}

export function transitionWorkflow(
  workflow: ProjectWorkflow,
  status: WorkflowStatus,
  updatedAt: string,
  detail: { summary?: string; errorText?: string; returnReason?: string; cancelReason?: string } = {},
): ProjectWorkflow {
  if (!workflowTransitions[workflow.status].includes(status)) {
    throw new CollaborationRuleError(`协作任务不能从 ${workflow.status} 变为 ${status}`);
  }

  const summary = detail.summary?.trim() || workflow.summary;
  const errorText = detail.errorText?.trim() || "";
  const returnReason = detail.returnReason?.trim() || "";
  const cancelReason = detail.cancelReason?.trim() || "";

  if (status === "review" && !summary) throw new CollaborationRuleError("验收摘要不能为空");
  if (status === "returned" && !returnReason) throw new CollaborationRuleError("退回原因不能为空");
  if (status === "failed" && !errorText) throw new CollaborationRuleError("失败原因不能为空");
  if (status === "cancelled" && !cancelReason) throw new CollaborationRuleError("取消原因不能为空");

  return {
    ...workflow,
    status,
    summary,
    errorText: status === "failed" ? errorText : workflow.errorText,
    returnReason: status === "returned" ? returnReason : workflow.returnReason,
    cancelReason: status === "cancelled" ? cancelReason : workflow.cancelReason,
    updatedAt,
    approvedAt: status === "approved" ? updatedAt : null,
  };
}

export function transitionWorkItem(
  item: ProjectWorkItem,
  status: WorkItemStatus,
  updatedAt: string,
  detail: { summary?: string; evidence?: string[]; blockedReason?: string; errorText?: string } = {},
): ProjectWorkItem {
  if (!workItemTransitions[item.status].includes(status)) {
    throw new CollaborationRuleError(`工作项不能从 ${item.status} 变为 ${status}`);
  }

  const summary = detail.summary?.trim() || item.summary;
  const evidence = detail.evidence
    ? [...new Set(detail.evidence.map((value) => value.trim()).filter(Boolean))]
    : item.evidence;
  const blockedReason = detail.blockedReason?.trim() || "";
  const errorText = detail.errorText?.trim() || "";

  if (status === "blocked" && !blockedReason) throw new CollaborationRuleError("阻塞原因不能为空");
  if (status === "review" && !summary) throw new CollaborationRuleError("工作项完成摘要不能为空");
  if (status === "review" && evidence.length === 0) throw new CollaborationRuleError("工作项验收证据不能为空");
  if (status === "failed" && !errorText) throw new CollaborationRuleError("工作项失败原因不能为空");

  const retried =
    (item.status === "review" && (status === "ready" || status === "running")) ||
    (item.status === "failed" && status === "ready");

  return {
    ...item,
    status,
    summary,
    evidence,
    blockedReason: status === "blocked" ? blockedReason : "",
    errorText: status === "failed" ? errorText : "",
    retryCount: retried ? item.retryCount + 1 : item.retryCount,
    updatedAt,
  };
}

export function handoffWorkItemOwner(
  item: ProjectWorkItem,
  fromRoleId: string,
  toRoleId: string,
  updatedAt: string,
): ProjectWorkItem {
  const from = fromRoleId.trim();
  const target = toRoleId.trim();
  if (item.status !== "ready" && item.status !== "running") {
    throw new CollaborationRuleError("只有待认领或执行中的工作项可以交接");
  }
  if (item.ownerRoleId !== from) throw new CollaborationRuleError("只有当前主责员工可以交接工作项");
  if (!target) throw new CollaborationRuleError("交接目标不能为空");
  if (target === from) throw new CollaborationRuleError("工作项不能交接给当前主责");
  if (target === item.reviewerRoleId) throw new CollaborationRuleError("工作项不能交接给复核员工");
  return {
    ...item,
    ownerRoleId: target,
    status: "ready",
    blockedReason: "",
    updatedAt,
  };
}

export function closeDecisionRequest(
  request: ProjectDecisionRequest,
  status: "resolved" | "cancelled",
  answer: string,
  resolvedAt: string,
): ProjectDecisionRequest {
  if (request.status !== "open") throw new CollaborationRuleError("只有待决定的问题可以关闭");
  const text = answer.trim();
  if (!text) throw new CollaborationRuleError(status === "resolved" ? "决定内容不能为空" : "取消原因不能为空");
  return { ...request, status, answer: text, resolvedAt };
}

export function validateWorkItemDependencies(
  workItemIds: string[],
  dependencies: WorkItemDependency[],
): void {
  const ids = new Set(workItemIds);
  if (ids.size !== workItemIds.length) throw new CollaborationRuleError("工作项编号不能重复");

  const graph = new Map<string, string[]>();
  for (const id of ids) graph.set(id, []);
  const seenEdges = new Set<string>();

  for (const dependency of dependencies) {
    if (!ids.has(dependency.workItemId) || !ids.has(dependency.dependsOnWorkItemId)) {
      throw new CollaborationRuleError("工作项依赖引用了未知工作项");
    }
    if (dependency.workItemId === dependency.dependsOnWorkItemId) {
      throw new CollaborationRuleError("工作项不能依赖自己");
    }
    const edge = `${dependency.workItemId}\0${dependency.dependsOnWorkItemId}`;
    if (seenEdges.has(edge)) throw new CollaborationRuleError("工作项依赖不能重复");
    seenEdges.add(edge);
    graph.get(dependency.workItemId)!.push(dependency.dependsOnWorkItemId);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new CollaborationRuleError("工作项依赖不能形成环");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of graph.get(id) ?? []) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

export function readyWorkItemIds(
  items: Pick<ProjectWorkItem, "id" | "status">[],
  dependencies: WorkItemDependency[],
): string[] {
  validateWorkItemDependencies(
    items.map((item) => item.id),
    dependencies,
  );
  const statusById = new Map(items.map((item) => [item.id, item.status]));
  const parents = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const current = parents.get(dependency.workItemId) ?? [];
    current.push(dependency.dependsOnWorkItemId);
    parents.set(dependency.workItemId, current);
  }
  return items
    .filter((item) => item.status === "queued")
    .filter((item) => (parents.get(item.id) ?? []).every((id) => statusById.get(id) === "done"))
    .map((item) => item.id);
}

