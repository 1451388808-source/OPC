import { z } from "zod";

export const PROJECT_RUN_STATUSES = [
  "queued",
  "running",
  "review",
  "applying",
  "approved",
  "returned",
  "failed",
] as const;

export type ProjectRunStatus = (typeof PROJECT_RUN_STATUSES)[number];

export type ProjectRun = {
  id: string;
  projectId: string;
  taskId: string | null;
  roleId: string;
  requestText: string;
  status: ProjectRunStatus;
  summary: string;
  errorText: string;
  returnReason: string;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
};

export type ProjectRunEventKind = "reasoning" | "tool_call" | "tool_result" | "message" | "error";

export type ProjectRunEvent = {
  id: number;
  runId: string;
  kind: ProjectRunEventKind;
  body: unknown;
  createdAt: string;
};

export type ProjectRunFile = {
  runId: string;
  path: string;
  operation: "create" | "update";
  beforeSha256: string | null;
  afterSha256: string;
  beforeSize: number;
  afterSize: number;
};

const runIdSchema = z.string().regex(/^r-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const projectPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !value.includes("\0") &&
      value.split("/").every((segment) => segment && segment !== "." && segment !== ".."),
  );

export const projectRunSchema = z.object({
  id: runIdSchema,
  projectId: z.string().regex(/^p-\d{3}$/),
  taskId: z.string().regex(/^t-\d{3}$/).nullable(),
  roleId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  requestText: z.string().min(1),
  status: z.enum(PROJECT_RUN_STATUSES),
  summary: z.string(),
  errorText: z.string(),
  returnReason: z.string(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  approvedAt: z.string().min(1).nullable(),
});

export const projectRunEventSchema = z.object({
  id: z.number().int().nonnegative(),
  runId: runIdSchema,
  kind: z.enum(["reasoning", "tool_call", "tool_result", "message", "error"]),
  body: z.unknown(),
  createdAt: z.string().min(1),
});

export const projectRunFileSchema = z.object({
  runId: runIdSchema,
  path: projectPathSchema,
  operation: z.enum(["create", "update"]),
  beforeSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  afterSha256: z.string().regex(/^[0-9a-f]{64}$/),
  beforeSize: z.number().int().nonnegative(),
  afterSize: z.number().int().nonnegative(),
});

const allowedTransitions: Record<ProjectRunStatus, ProjectRunStatus[]> = {
  queued: ["running", "failed"],
  running: ["review", "failed"],
  review: ["applying", "returned"],
  applying: ["approved", "review", "failed"],
  approved: [],
  returned: [],
  failed: [],
};

export class ProjectRunRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRunRuleError";
  }
}

export function transitionProjectRun(
  run: ProjectRun,
  status: ProjectRunStatus,
  updatedAt: string,
  detail: { summary?: string; errorText?: string; returnReason?: string } = {},
): ProjectRun {
  if (!allowedTransitions[run.status].includes(status)) {
    throw new ProjectRunRuleError(`执行不能从 ${run.status} 变为 ${status}`);
  }

  const summary = detail.summary?.trim() || run.summary;
  const errorText = detail.errorText?.trim() || "";
  const returnReason = detail.returnReason?.trim() || "";
  if (status === "review" && !summary) throw new ProjectRunRuleError("完成摘要不能为空");
  if (status === "returned" && !returnReason) throw new ProjectRunRuleError("退回原因不能为空");
  if (status === "failed" && !errorText) throw new ProjectRunRuleError("失败原因不能为空");

  return {
    ...run,
    status,
    summary,
    errorText: status === "failed" ? errorText : run.errorText,
    returnReason: status === "returned" ? returnReason : run.returnReason,
    updatedAt,
    approvedAt: status === "approved" ? updatedAt : null,
  };
}

