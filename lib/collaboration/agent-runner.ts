import type { ProjectWorkflow, ProjectWorkItem } from "../domain/collaboration";
import { deepSeekToolModel, deepseekProvider } from "../employees/deepseek";
import { createMcpWorkflowTools } from "../employees/mcp-tools";
import { executeToolLoop } from "../employees/tool-loop";
import { readRoles, readSkillText } from "../infrastructure/files";
import {
  blockWorkItemExecution,
  claimWorkItem,
  failWorkItemExecution,
  loadCollaborationWorkflow,
  submitWorkflowForReview,
  submitWorkItemForReview,
} from "../application/collaboration";
import { ToolExecutionError } from "../mcp/error.ts";
import { recordProjectEvent } from "../application/project-event";
import { createProjectRunQueue, type ProjectRunQueue } from "../application/project-run-queue";
import { ensureReady } from "../application/board";
import { getPool } from "../infrastructure/db";
import { listResumableWorkflowIds, resetInterruptedWorkItems } from "../infrastructure/collaboration-store";
import { listExpiredWorkflowIds } from "../infrastructure/collaboration-store";
import { shanghaiTime } from "../domain/time";
import { removeWorkflowWorkspace } from "../project-workspace/workflow-workspace";
import {
  collaborationProgressEvent,
  type CollaborationProgressState,
} from "./progress-events.ts";
import { appendProjectEvent } from "../infrastructure/collaboration-store";

export type WorkItemExecutionResult = {
  summary: string;
  evidence: string[];
  waitingUser?: boolean;
};

export type CollaborationRunnerDependencies = {
  execute(input: { workflow: ProjectWorkflow; item: ProjectWorkItem }): Promise<WorkItemExecutionResult>;
};

function projectEventBody(event: { body: unknown }): Record<string, unknown> {
  return event.body !== null && typeof event.body === "object" ? (event.body as Record<string, unknown>) : {};
}

function resolvedDecisionSummaries(events: { kind: string; body: unknown }[]): string[] {
  const answers = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "decision_resolved") continue;
    const body = projectEventBody(event);
    const decisionId = String(body.decisionId ?? "").trim();
    const answer = String(body.answer ?? "").trim();
    if (decisionId && answer) answers.set(decisionId, answer);
  }
  const summaries: string[] = [];
  for (const event of events) {
    if (event.kind !== "decision_requested") continue;
    const body = projectEventBody(event);
    const decisionId = String(body.decisionId ?? "").trim();
    const answer = decisionId ? answers.get(decisionId) : undefined;
    if (!answer) continue;
    const question = String(body.question ?? "").trim();
    if (!question) continue;
    summaries.push(`${question} → 老板已决定：${answer}`);
  }
  return summaries.slice(-10);
}

async function executeWithModel(input: {
  workflow: ProjectWorkflow;
  item: ProjectWorkItem;
}): Promise<WorkItemExecutionResult> {
  const roles = await readRoles();
  const employee = roles.find((role) => role.id === input.item.ownerRoleId);
  if (!employee) throw new Error("找不到工作项主责员工");
  if (employee.model.provider !== deepseekProvider || !employee.model.model) {
    throw new Error(`${employee.name} 还没有接入可执行模型`);
  }
  const skillText = (
    await Promise.all(employee.skills.map((skillId) => readSkillText(skillId)))
  )
    .filter(Boolean)
    .join("\n\n");
  const tools = createMcpWorkflowTools({
    context: {
      workflowId: input.workflow.id,
      workItemId: input.item.id,
      roleId: input.item.ownerRoleId,
    },
  });
  const currentView = await loadCollaborationWorkflow(input.workflow.id);
  const followUps = currentView.events
    .filter((event) => {
      if (event.kind !== "user_message") return false;
      const route = projectEventBody(event).route;
      return route !== null && typeof route === "object" && (route as Record<string, unknown>).type === "workflow_input";
    })
    .slice(-6)
    .map((event) => String(projectEventBody(event).text ?? "").trim())
    .filter(Boolean);
  const decidedQuestions = resolvedDecisionSummaries(currentView.events);
  await recordProjectEvent({
    projectId: input.workflow.projectId,
    workflowId: input.workflow.id,
    workItemId: input.item.id,
    actorType: "agent",
    actorId: input.item.ownerRoleId,
    kind: "agent_message",
    body: { text: `认领工作项：${input.item.title}` },
  });
  const progressState: CollaborationProgressState = { analysisAnnounced: false };
  const system = [
    employee.prompt || `你是 OPC 的${employee.name}。`,
    skillText ? `按这些技能工作：\n${skillText}` : "",
    `协作任务：${input.workflow.title}`,
    `当前工作项：${input.item.title}`,
    `目标：${input.item.objective}`,
    `验收：\n${input.item.acceptance.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
    "你只能通过提供的工具读取、暂存和验证项目文件。正式文件不会立即改变。",
    "更新现有文件前先 read_file。需要验证时使用项目允许的 run_validation profile。",
    decidedQuestions.length > 0
      ? `以下取舍老板已经决定过，不要再就同一个问题重新提交待决问题：\n${decidedQuestions.map((text) => `- ${text}`).join("\n")}`
      : "",
    "最后用中文给出简短完成摘要和实际证据，不要声称没有验证过的结果。",
  ]
    .filter(Boolean)
    .join("\n\n");
  const result = await executeToolLoop({
    model: deepSeekToolModel,
    modelName: employee.model.model,
    system,
    user: [
      input.workflow.requestText,
      followUps.length > 0 ? `老板对当前任务的补充要求：\n${followUps.map((text) => `- ${text}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    tools,
    emit: async (event) => {
      const progress = collaborationProgressEvent(event, progressState);
      if (!progress) return;
      await appendProjectEvent(getPool(), {
        projectId: input.workflow.projectId,
        workflowId: input.workflow.id,
        workItemId: input.item.id,
        actorType: progress.actorType,
        actorId: input.item.ownerRoleId,
        kind: progress.kind,
        body: progress.body,
        createdAt: shanghaiTime().iso,
      });
    },
    limits: { maxRounds: 100, maxToolCalls: 300, maxDurationMs: 30 * 60_000 },
  });
  const refreshed = await loadCollaborationWorkflow(input.workflow.id);
  const currentItem = refreshed.items.find((item) => item.id === input.item.id);
  if (currentItem?.status === "blocked") {
    return { summary: result.summary, evidence: [result.summary], waitingUser: true };
  }
  const evidence = result.changedPaths.length > 0 ? result.changedPaths : [result.summary];
  await recordProjectEvent({
    projectId: input.workflow.projectId,
    workflowId: input.workflow.id,
    workItemId: input.item.id,
    actorType: "agent",
    actorId: input.item.ownerRoleId,
    kind: "agent_message",
    body: { text: result.summary },
  });
  return { summary: result.summary, evidence };
}

const productionDependencies: CollaborationRunnerDependencies = {
  execute: executeWithModel,
};

export async function driveCollaborationWorkflow(
  workflowId: string,
  dependencies: CollaborationRunnerDependencies = productionDependencies,
): Promise<void> {
  for (let step = 0; step < 30; step += 1) {
    const view = await loadCollaborationWorkflow(workflowId);
    if (["review", "applying", "approved", "failed", "cancelled"].includes(view.workflow.status)) return;
    if (view.workflow.status === "verifying") {
      await submitWorkflowForReview({
        workflowId,
        coordinatorRoleId: view.workflow.coordinatorRoleId,
        summary: view.items.map((item) => `${item.title}：${item.summary}`).join("\n"),
      });
      return;
    }
    if (view.workflow.status !== "collaborating") return;
    const pendingReview = view.items.find((candidate) => candidate.status === "review");
    if (pendingReview) {
      await submitWorkItemForReview({
        workItemId: pendingReview.id,
        roleId: pendingReview.ownerRoleId,
        summary: pendingReview.summary,
        evidence: pendingReview.evidence,
        skipReview: true,
      });
      continue;
    }
    const item = view.items.find((candidate) => candidate.status === "ready");
    if (!item) {
      const active = view.items.some((candidate) => candidate.status === "running");
      if (active) return;
      throw new Error("协作任务没有可执行工作项，依赖可能未满足");
    }
    await claimWorkItem(item.id, item.ownerRoleId);
    try {
      const result = await dependencies.execute({ workflow: view.workflow, item: { ...item, status: "running" } });
      if (result.waitingUser) continue;
      const next = await submitWorkItemForReview({
        workItemId: item.id,
        roleId: item.ownerRoleId,
        summary: result.summary,
        evidence: result.evidence.length > 0 ? result.evidence : [result.summary],
        skipReview: true,
      });
      if (next.workflow.status === "verifying") continue;
    } catch (error) {
      if (
        error instanceof ToolExecutionError &&
        ["missing_configuration", "permission_denied", "budget_exceeded"].includes(error.failure.code)
      ) {
        await blockWorkItemExecution({
          workItemId: item.id,
          roleId: item.ownerRoleId,
          code: error.failure.code,
          detail: error.failure.message,
        });
        return;
      }
      await failWorkItemExecution({
        workItemId: item.id,
        roleId: item.ownerRoleId,
        errorText: error instanceof Error ? error.message : "员工执行失败",
      });
      return;
    }
  }
  throw new Error("协作调度超过 30 步");
}

declare global {
  var __opcCollaborationQueue: ProjectRunQueue | undefined;
  var __opcCollaborationRecovery: Promise<void> | undefined;
}

function collaborationQueue(): ProjectRunQueue {
  globalThis.__opcCollaborationQueue ??= createProjectRunQueue(driveCollaborationWorkflow, (workflowId, error) => {
    console.error(`协作任务 ${workflowId} 执行失败`, error);
  });
  return globalThis.__opcCollaborationQueue;
}

export function enqueueCollaborationWorkflow(workflowId: string): void {
  collaborationQueue().enqueue(workflowId);
}

export async function recoverCollaborationWorkflows(
  enqueue: (workflowId: string) => void = enqueueCollaborationWorkflow,
  onlyWorkflowId?: string,
): Promise<string[]> {
  await ensureReady();
  await resetInterruptedWorkItems(getPool(), shanghaiTime().iso, onlyWorkflowId);
  const workflowIds = await listResumableWorkflowIds(getPool(), onlyWorkflowId);
  for (const workflowId of workflowIds) enqueue(workflowId);
  return workflowIds;
}

export function ensureCollaborationRuntime(): Promise<void> {
  globalThis.__opcCollaborationRecovery ??= recoverCollaborationWorkflows()
    .then(async () => {
      const configured = Number(process.env.COLLABORATION_RETENTION_DAYS ?? 30);
      const retentionDays = Number.isInteger(configured) && configured > 0 ? configured : 30;
      await cleanupExpiredCollaborationWorkspaces(retentionDays);
    })
    .catch((error) => {
      globalThis.__opcCollaborationRecovery = undefined;
      console.error("恢复协作任务失败", error);
      throw error;
    });
  return globalThis.__opcCollaborationRecovery;
}

export async function cleanupExpiredCollaborationWorkspaces(retentionDays = 30): Promise<string[]> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error("协作暂存保留天数必须是正整数");
  await ensureReady();
  const before = shanghaiTime(new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)).iso;
  const workflowIds = await listExpiredWorkflowIds(getPool(), before);
  for (const workflowId of workflowIds) await removeWorkflowWorkspace(workflowId);
  return workflowIds;
}

