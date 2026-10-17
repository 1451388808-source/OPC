import { randomUUID } from "node:crypto";
import {
  closeDecisionRequest,
  decisionRecommendationId,
  handoffWorkItemOwner,
  transitionWorkflow,
  transitionWorkItem,
  validateWorkItemDependencies,
  type ProjectEvent,
  type ProjectWorkflow,
  type ProjectWorkItem,
  type WorkItemDependency,
  type DecisionOption,
} from "../domain/collaboration";
import {
  dispatchTaskToRole,
  doingCount,
  approveTask,
  returnTask,
  submitTaskForReview,
  RuleError,
  type Task,
} from "../domain/task";
import { shanghaiTime } from "../domain/time";
import { presentDiff, type DiffHunk } from "../domain/diff-view";
import { releaseReadyWorkItems, workflowCanVerify } from "../collaboration/scheduler";
import { resolveDecisionScope } from "../collaboration/reference-resolver.ts";
import type { DecisionScope } from "../collaboration/action-protocol.ts";
import type { ToolFailureCode } from "../mcp/error.ts";
import { getPool, withTransaction, type Sql } from "../infrastructure/db";
import {
  appendProjectEvent,
  findActiveTaskWorkflow,
  getProjectWorkflow,
  getProjectWorkItem,
  getProjectDecisionRequest,
  insertProjectDecisionRequest,
  insertProjectWorkflow,
  insertProjectWorkItem,
  insertWorkItemDependencies,
  listProjectWorkItems,
  listOpenWorkflowDecisionRequests,
  listProjectWorkflows,
  listWorkflowDependencies,
  listWorkflowEvents,
  updateProjectWorkflow,
  updateProjectWorkItem,
  updateProjectDecisionRequest,
} from "../infrastructure/collaboration-store";
import { getProject, listMemberIds } from "../infrastructure/org-store";
import { workflowWorkspace } from "../project-workspace/workflow-workspace";
import { ensureReady } from "./board";
import { ensureProjectEventHistory } from "./project-event";
import { getTask, insertDecision, listDecisions, listTasks, updateTask } from "../infrastructure/store";
import { exportDecisions, exportTaskFile } from "../infrastructure/files";

export type WorkItemDraft = {
  key: string;
  title: string;
  objective: string;
  acceptance: string[];
  ownerRoleId: string;
  reviewerRoleId?: string | null;
  dependsOn?: string[];
};

export type CollaborationWorkflowView = {
  workflow: ProjectWorkflow;
  items: ProjectWorkItem[];
  dependencies: WorkItemDependency[];
  events: ProjectEvent[];
};

export type CollaborationReviewView = CollaborationWorkflowView & {
  files: {
    path: string;
    operation: "create" | "update";
    diff: string;
    afterSize: number;
    additions: number;
    deletions: number;
    hunks: DiffHunk[];
  }[];
};

export type ProjectWorkflowSummary = Pick<ProjectWorkflow, "id" | "title" | "status" | "createdAt">;

export async function loadProjectWorkflowSummaries(projectId: string): Promise<ProjectWorkflowSummary[]> {
  await ensureReady();
  return (await listProjectWorkflows(getPool(), projectId)).map(({ id, title, status, createdAt }) => ({
    id,
    title,
    status,
    createdAt,
  }));
}

function requireText(value: string, message: string, maxLength?: number): string {
  const text = value.trim();
  if (!text) throw new RuleError(message);
  if (maxLength && Array.from(text).length > maxLength) throw new RuleError(`${message.replace("不能为空", "")}太长`);
  return text;
}

async function loadWorkflowViewFrom(sql: Sql, workflowId: string): Promise<CollaborationWorkflowView> {
  const workflow = await getProjectWorkflow(sql, workflowId);
  if (!workflow) throw new RuleError("找不到这个协作任务");
  const [items, dependencies, events] = await Promise.all([
    listProjectWorkItems(sql, workflowId),
    listWorkflowDependencies(sql, workflowId),
    listWorkflowEvents(sql, workflowId),
  ]);
  return { workflow, items, dependencies, events };
}

async function appendStatusEvent(
  sql: Sql,
  input: {
    workflow: ProjectWorkflow;
    item?: ProjectWorkItem;
    actorType: "boss" | "agent" | "system";
    actorId: string;
    body?: Record<string, unknown>;
  },
): Promise<void> {
  await appendProjectEvent(sql, {
    projectId: input.workflow.projectId,
    workflowId: input.workflow.id,
    workItemId: input.item?.id ?? null,
    actorType: input.actorType,
    actorId: input.actorId,
    kind: input.item ? "work_item_status" : "workflow_status",
    body: {
      status: input.item?.status ?? input.workflow.status,
      ...(input.body ?? {}),
    },
    createdAt: input.item?.updatedAt ?? input.workflow.updatedAt,
  });
}

async function releaseItemWorkspaceLeases(sql: Sql, workflow: ProjectWorkflow, workItemId: string): Promise<void> {
  const project = await getProject(sql, workflow.projectId);
  if (!project) throw new RuleError("找不到这个项目");
  await workflowWorkspace({
    companyId: project.companyId,
    projectId: project.id,
    workflowId: workflow.id,
  }).releaseWorkItemLeases(workItemId);
}

async function advanceWorkflowAfterItemChange(
  sql: Sql,
  workflow: ProjectWorkflow,
  updatedAt: string,
): Promise<ProjectWorkflow> {
  const items = await listProjectWorkItems(sql, workflow.id, true);
  const dependencies = await listWorkflowDependencies(sql, workflow.id);
  if (workflowCanVerify(items)) {
    if (workflow.status !== "collaborating" && workflow.status !== "waiting_user") return workflow;
    const verifying = transitionWorkflow(workflow, "verifying", updatedAt);
    await updateProjectWorkflow(sql, verifying);
    await appendStatusEvent(sql, {
      workflow: verifying,
      actorType: "system",
      actorId: "collaboration-scheduler",
    });
    return verifying;
  }

  const released = releaseReadyWorkItems(items, dependencies, updatedAt);
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of released) {
    if (byId.get(item.id)?.status === item.status) continue;
    await updateProjectWorkItem(sql, item);
    await appendStatusEvent(sql, {
      workflow,
      item,
      actorType: "system",
      actorId: "collaboration-scheduler",
      body: { reason: "依赖已经完成" },
    });
  }

  const hasActionableItem = released.some(
    (item) => item.status === "ready" || item.status === "running" || item.status === "review",
  );
  const hasBlockedItem = released.some((item) => item.status === "blocked");
  if (workflow.status === "collaborating" && !hasActionableItem && hasBlockedItem) {
    const waiting = transitionWorkflow(workflow, "waiting_user", updatedAt);
    await updateProjectWorkflow(sql, waiting);
    await appendStatusEvent(sql, {
      workflow: waiting,
      actorType: "system",
      actorId: "collaboration-scheduler",
    });
    return waiting;
  }
  return workflow;
}

export async function createCollaborationWorkflow(input: {
  projectId: string;
  taskId?: string | null;
  sourceEventId?: number | null;
  title: string;
  requestText: string;
  coordinatorRoleId: string;
  workItems: WorkItemDraft[];
}): Promise<CollaborationWorkflowView> {
  await ensureReady();
  await ensureProjectEventHistory(input.projectId);
  const title = requireText(input.title, "协作任务标题不能为空", 300);
  const requestText = requireText(input.requestText, "协作任务要求不能为空");
  const coordinatorRoleId = requireText(input.coordinatorRoleId, "先选择协调员工");
  if (input.workItems.length < 1 || input.workItems.length > 12) {
    throw new RuleError("协作任务必须包含 1 到 12 个工作项");
  }

  const project = await getProject(getPool(), input.projectId);
  if (!project) throw new RuleError("找不到这个项目");
  const members = new Set(await listMemberIds(getPool(), input.projectId));
  if (!members.has(coordinatorRoleId)) throw new RuleError("协调员工必须是项目成员");

  const keys = new Set<string>();
  for (const draft of input.workItems) {
    const key = requireText(draft.key, "工作项 key 不能为空");
    if (keys.has(key)) throw new RuleError("工作项 key 不能重复");
    keys.add(key);
    if (!members.has(draft.ownerRoleId)) throw new RuleError(`工作项 ${key} 的主责员工不在项目中`);
    if (draft.reviewerRoleId && !members.has(draft.reviewerRoleId)) {
      throw new RuleError(`工作项 ${key} 的复核员工不在项目中`);
    }
  }
  for (const draft of input.workItems) {
    for (const dependencyKey of draft.dependsOn ?? []) {
      if (!keys.has(dependencyKey)) throw new RuleError(`工作项 ${draft.key} 依赖了未知工作项`);
    }
  }

  const now = shanghaiTime();
  const createdAt = now.iso;
  const workflowId = `wf-${randomUUID()}`;
  const idByKey = new Map(input.workItems.map((draft) => [draft.key, `wi-${randomUUID()}`]));
  const items: ProjectWorkItem[] = input.workItems.map((draft, position) => ({
    id: idByKey.get(draft.key)!,
    workflowId,
    position,
    title: requireText(draft.title, "工作项标题不能为空", 300),
    objective: requireText(draft.objective, "工作项目标不能为空"),
    acceptance: draft.acceptance.map((value) => value.trim()).filter(Boolean),
    ownerRoleId: draft.ownerRoleId,
    reviewerRoleId: draft.reviewerRoleId ?? null,
    status: "queued",
    blockedReason: "",
    summary: "",
    evidence: [],
    errorText: "",
    retryCount: 0,
    createdAt,
    updatedAt: createdAt,
  }));
  if (items.some((item) => item.acceptance.length === 0)) throw new RuleError("每个工作项至少需要一条验收条件");
  const dependencies: WorkItemDependency[] = input.workItems.flatMap((draft) =>
    (draft.dependsOn ?? []).map((dependencyKey) => ({
      workItemId: idByKey.get(draft.key)!,
      dependsOnWorkItemId: idByKey.get(dependencyKey)!,
    })),
  );
  validateWorkItemDependencies(
    items.map((item) => item.id),
    dependencies,
  );

  let dispatchedTask: Task | null = null;
  await withTransaction(async (connection) => {
    if (input.taskId && (await findActiveTaskWorkflow(connection, input.taskId, true))) {
      throw new RuleError("这条任务已经有正在进行的协作任务");
    }
    if (input.taskId) {
      const tasks = await listTasks(connection);
      const task = await getTask(connection, input.taskId, true);
      if (!task) throw new RuleError("找不到这条任务");
      dispatchedTask = dispatchTaskToRole(
        task,
        coordinatorRoleId,
        doingCount(tasks),
        now.noteStamp,
        now.iso,
      );
      await updateTask(connection, dispatchedTask);
    }
    let workflow: ProjectWorkflow = {
      id: workflowId,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      sourceEventId: input.sourceEventId ?? null,
      title,
      requestText,
      coordinatorRoleId,
      status: "planning",
      summary: "",
      errorText: "",
      returnReason: "",
      cancelReason: "",
      createdAt,
      updatedAt: createdAt,
      approvedAt: null,
    };
    await insertProjectWorkflow(connection, workflow);
    await appendProjectEvent(connection, {
      projectId: input.projectId,
      workflowId,
      workItemId: null,
      actorType: "system",
      actorId: "collaboration-scheduler",
      kind: "workflow_created",
      body: { title, coordinatorRoleId, workItemCount: items.length },
      createdAt,
    });
    for (const item of items) {
      await insertProjectWorkItem(connection, item);
      await appendProjectEvent(connection, {
        projectId: input.projectId,
        workflowId,
        workItemId: item.id,
        actorType: "system",
        actorId: "collaboration-scheduler",
        kind: "work_item_created",
        body: {
          position: item.position,
          title: item.title,
          ownerRoleId: item.ownerRoleId,
          reviewerRoleId: item.reviewerRoleId,
        },
        createdAt,
      });
    }
    await insertWorkItemDependencies(connection, dependencies);
    workflow = transitionWorkflow(workflow, "collaborating", createdAt);
    await updateProjectWorkflow(connection, workflow);
    await appendStatusEvent(connection, {
      workflow,
      actorType: "system",
      actorId: "collaboration-scheduler",
    });
    await advanceWorkflowAfterItemChange(connection, workflow, createdAt);
  });

  if (dispatchedTask) {
    await exportTaskFile(dispatchedTask).catch(async (error) => {
      await appendProjectEvent(getPool(), {
        projectId: input.projectId,
        workflowId,
        workItemId: null,
        actorType: "system",
        actorId: "task-export",
        kind: "error",
        body: { message: `数据库已写入，任务文件副本尚未刷新。${error instanceof Error ? error.message : "导出失败"}` },
        createdAt: shanghaiTime().iso,
      });
    });
  }

  return loadCollaborationWorkflow(workflowId);
}

export async function loadCollaborationWorkflow(workflowId: string): Promise<CollaborationWorkflowView> {
  await ensureReady();
  return loadWorkflowViewFrom(getPool(), workflowId);
}

export async function loadCollaborationReview(workflowId: string): Promise<CollaborationReviewView> {
  const view = await loadCollaborationWorkflow(workflowId);
  const project = await getProject(getPool(), view.workflow.projectId);
  if (!project) throw new RuleError("找不到这个项目");
  const workspace = workflowWorkspace({
    companyId: project.companyId,
    projectId: project.id,
    workflowId,
  });
  const changes = await workspace.changes();
  return {
    ...view,
    files: await Promise.all(
      changes.map(async (change) => {
        const diff = await workspace.diff(change.path);
        return {
          path: change.path,
          operation: change.operation,
          diff,
          afterSize: change.afterSize,
          ...presentDiff(diff),
        };
      }),
    ),
  };
}

export async function claimWorkItem(workItemId: string, roleId: string): Promise<ProjectWorkItem> {
  await ensureReady();
  const actor = requireText(roleId, "认领员工不能为空");
  return withTransaction(async (connection) => {
    const item = await getProjectWorkItem(connection, workItemId, true);
    if (!item) throw new RuleError("找不到这个工作项");
    const workflow = await getProjectWorkflow(connection, item.workflowId, true);
    if (!workflow) throw new RuleError("找不到这个协作任务");
    if (workflow.status !== "collaborating") throw new RuleError("协作任务当前不能认领工作项");
    if (item.ownerRoleId !== actor) throw new RuleError("只有主责员工可以认领这个工作项");
    const running = transitionWorkItem(item, "running", shanghaiTime().iso);
    await updateProjectWorkItem(connection, running);
    await appendStatusEvent(connection, {
      workflow,
      item: running,
      actorType: "agent",
      actorId: actor,
      body: { action: "claimed" },
    });
    return running;
  });
}

export async function handoffWorkItem(input: {
  workItemId: string;
  fromRoleId: string;
  toRoleId: string;
  reason: string;
}): Promise<ProjectWorkItem> {
  await ensureReady();
  const fromRoleId = requireText(input.fromRoleId, "当前主责员工不能为空");
  const toRoleId = requireText(input.toRoleId, "交接员工不能为空");
  const reason = requireText(input.reason, "交接原因不能为空");
  return withTransaction(async (connection) => {
    const item = await getProjectWorkItem(connection, input.workItemId, true);
    if (!item) throw new RuleError("找不到这个工作项");
    const workflow = await getProjectWorkflow(connection, item.workflowId, true);
    if (!workflow) throw new RuleError("找不到这个协作任务");
    if (workflow.status !== "collaborating") throw new RuleError("协作任务当前不能交接工作项");
    const members = await listMemberIds(connection, workflow.projectId);
    if (!members.includes(toRoleId)) throw new RuleError("交接员工必须是项目成员");
    const handedOff = handoffWorkItemOwner(item, fromRoleId, toRoleId, shanghaiTime().iso);
    await updateProjectWorkItem(connection, handedOff);
    await appendProjectEvent(connection, {
      projectId: workflow.projectId,
      workflowId: workflow.id,
      workItemId: item.id,
      actorType: "agent",
      actorId: fromRoleId,
      kind: "handoff",
      body: { fromRoleId, toRoleId, reason },
      createdAt: handedOff.updatedAt,
    });
    await appendStatusEvent(connection, {
      workflow,
      item: handedOff,
      actorType: "system",
      actorId: "collaboration-scheduler",
      body: { action: "handed_off", fromRoleId, toRoleId },
    });
    return handedOff;
  });
}

export async function submitWorkItemForReview(input: {
  workItemId: string;
  roleId: string;
  summary: string;
  evidence: string[];
  skipReview?: boolean;
}): Promise<CollaborationWorkflowView> {
  await ensureReady();
  const actor = requireText(input.roleId, "提交员工不能为空");
  const updatedAt = shanghaiTime().iso;
  let workflowId = "";
  await withTransaction(async (connection) => {
    let item = await getProjectWorkItem(connection, input.workItemId, true);
    if (!item) throw new RuleError("找不到这个工作项");
    const workflow = await getProjectWorkflow(connection, item.workflowId, true);
    if (!workflow) throw new RuleError("找不到这个协作任务");
    workflowId = workflow.id;
    if (workflow.status !== "collaborating") throw new RuleError("协作任务当前不能提交工作项");
    if (item.ownerRoleId !== actor) throw new RuleError("只有主责员工可以提交这个工作项");
    if (item.status !== "review" || !input.skipReview) {
      item = transitionWorkItem(item, "review", updatedAt, {
        summary: input.summary,
        evidence: input.evidence,
      });
      await updateProjectWorkItem(connection, item);
    }
    if (!input.skipReview) {
      await appendProjectEvent(connection, {
        projectId: workflow.projectId,
        workflowId: workflow.id,
        workItemId: item.id,
        actorType: "agent",
        actorId: actor,
        kind: "review_submitted",
        body: { summary: item.summary, evidence: item.evidence, reviewerRoleId: item.reviewerRoleId },
        createdAt: updatedAt,
      });
    }
    if (input.skipReview || !item.reviewerRoleId) {
      await releaseItemWorkspaceLeases(connection, workflow, item.id);
      item = transitionWorkItem(item, "done", updatedAt);
      await updateProjectWorkItem(connection, item);
      await appendStatusEvent(connection, {
        workflow,
        item,
        actorType: "system",
        actorId: "collaboration-scheduler",
        body: { detail: "工作项已完成", summary: item.summary },
      });
      await advanceWorkflowAfterItemChange(connection, workflow, updatedAt);
    }
  });
  return loadCollaborationWorkflow(workflowId);
}

export async function reviewWorkItem(input: {
  workItemId: string;
  reviewerRoleId: string;
  approved: boolean;
  reason?: string;
}): Promise<CollaborationWorkflowView> {
  await ensureReady();
  const reviewer = requireText(input.reviewerRoleId, "复核员工不能为空");
  const updatedAt = shanghaiTime().iso;
  let workflowId = "";
  await withTransaction(async (connection) => {
    let item = await getProjectWorkItem(connection, input.workItemId, true);
    if (!item) throw new RuleError("找不到这个工作项");
    const workflow = await getProjectWorkflow(connection, item.workflowId, true);
    if (!workflow) throw new RuleError("找不到这个协作任务");
    workflowId = workflow.id;
    if (item.reviewerRoleId !== reviewer) throw new RuleError("只有指定复核员工可以复核这个工作项");
    if (input.approved) {
      await releaseItemWorkspaceLeases(connection, workflow, item.id);
      item = transitionWorkItem(item, "done", updatedAt);
    } else {
      const reason = requireText(input.reason ?? "", "返工原因不能为空");
      item = transitionWorkItem(item, "ready", updatedAt);
      await appendProjectEvent(connection, {
        projectId: workflow.projectId,
        workflowId: workflow.id,
        workItemId: item.id,
        actorType: "agent",
        actorId: reviewer,
        kind: "return",
        body: { reason, target: "work_item" },
        createdAt: updatedAt,
      });
    }
    await updateProjectWorkItem(connection, item);
    await appendStatusEvent(connection, {
      workflow,
      item,
      actorType: "agent",
      actorId: reviewer,
      body: { action: input.approved ? "approved" : "returned" },
    });
    if (input.approved) await advanceWorkflowAfterItemChange(connection, workflow, updatedAt);
  });
  return loadCollaborationWorkflow(workflowId);
}

export async function submitWorkflowForReview(input: {
  workflowId: string;
  coordinatorRoleId: string;
  summary: string;
}): Promise<CollaborationWorkflowView> {
  await ensureReady();
  const coordinator = requireText(input.coordinatorRoleId, "协调员工不能为空");
  const before = await loadCollaborationWorkflow(input.workflowId);
  const project = await getProject(getPool(), before.workflow.projectId);
  if (!project) throw new RuleError("找不到这个项目");
  const stagedPaths = (await workflowWorkspace({
    companyId: project.companyId,
    projectId: project.id,
    workflowId: input.workflowId,
  }).changes()).map((change) => `workspaces/${project.companyId}/${project.id}/${change.path}`);
  let submittedTask: Task | null = null;
  await withTransaction(async (connection) => {
    const workflow = await getProjectWorkflow(connection, input.workflowId, true);
    if (!workflow) throw new RuleError("找不到这个协作任务");
    if (workflow.coordinatorRoleId !== coordinator) throw new RuleError("只有协调员工可以提交最终验收");
    const items = await listProjectWorkItems(connection, workflow.id, true);
    if (!workflowCanVerify(items)) throw new RuleError("还有工作项没有完成");
    const review = transitionWorkflow(workflow, "review", shanghaiTime().iso, {
      summary: input.summary,
    });
    if (workflow.taskId) {
      const task = await getTask(connection, workflow.taskId, true);
      if (!task) throw new RuleError("找不到关联任务");
      submittedTask = submitTaskForReview(
        task,
        stagedPaths,
        review.summary,
        shanghaiTime().noteStamp,
        review.updatedAt,
      );
      await updateTask(connection, submittedTask);
    }
    await updateProjectWorkflow(connection, review);
    await appendProjectEvent(connection, {
      projectId: workflow.projectId,
      workflowId: workflow.id,
      workItemId: null,
      actorType: "agent",
      actorId: coordinator,
      kind: "review_submitted",
      body: {
        summary: review.summary,
        workItems: items.map((item) => ({ id: item.id, title: item.title, evidence: item.evidence })),
      },
      createdAt: review.updatedAt,
    });
  });
  if (submittedTask) await exportTaskFile(submittedTask);
  return loadCollaborationWorkflow(input.workflowId);
}

export async function failWorkItemExecution(input: {
  workItemId: string;
  roleId: string;
  errorText: string;
}): Promise<void> {
  await ensureReady();
  const actor = requireText(input.roleId, "失败员工不能为空");
  const errorText = requireText(input.errorText, "失败原因不能为空");
  const updatedAt = shanghaiTime().iso;
  await withTransaction(async (connection) => {
    const item = await getProjectWorkItem(connection, input.workItemId, true);
    if (!item) throw new RuleError("找不到这个工作项");
    const workflow = await getProjectWorkflow(connection, item.workflowId, true);
    if (!workflow) throw new RuleError("找不到这个协作任务");
    if (item.ownerRoleId !== actor) throw new RuleError("只有主责员工可以报告工作项失败");
    await releaseItemWorkspaceLeases(connection, workflow, item.id);
    const failedItem = transitionWorkItem(item, "failed", updatedAt, { errorText });
    await updateProjectWorkItem(connection, failedItem);
    const failedWorkflow = transitionWorkflow(workflow, "failed", updatedAt, { errorText });
    await updateProjectWorkflow(connection, failedWorkflow);
    await appendProjectEvent(connection, {
      projectId: workflow.projectId,
      workflowId: workflow.id,
      workItemId: item.id,
      actorType: "agent",
      actorId: actor,
      kind: "error",
      body: { message: errorText },
      createdAt: updatedAt,
    });
    await appendStatusEvent(connection, {
      workflow: failedWorkflow,
      actorType: "system",
      actorId: "collaboration-scheduler",
    });
  });
}

export async function blockWorkItemExecution(input: {
  workItemId: string;
  roleId: string;
  code: ToolFailureCode;
  detail: string;
}): Promise<void> {
  await ensureReady();
  const actor = requireText(input.roleId, "阻塞员工不能为空");
  const detail = requireText(input.detail, "阻塞原因不能为空");
  const updatedAt = shanghaiTime().iso;
  await withTransaction(async (connection) => {
    const item = await getProjectWorkItem(connection, input.workItemId, true);
    if (!item) throw new RuleError("找不到这个工作项");
    let workflow = await getProjectWorkflow(connection, item.workflowId, true);
    if (!workflow) throw new RuleError("找不到这个协作任务");
    if (item.ownerRoleId !== actor) throw new RuleError("只有主责员工可以报告工作项阻塞");
    await releaseItemWorkspaceLeases(connection, workflow, item.id);
    const blocked = transitionWorkItem(item, "blocked", updatedAt, {
      blockedReason: `${input.code}: ${detail}`,
    });
    await updateProjectWorkItem(connection, blocked);
    await appendStatusEvent(connection, {
      workflow,
      item: blocked,
      actorType: "agent",
      actorId: actor,
      body: { action: "blocked", code: input.code, detail },
    });
    const items = await listProjectWorkItems(connection, workflow.id, true);
    if (
      workflow.status === "collaborating" &&
      !items.some((candidate) => ["ready", "running", "review"].includes(candidate.status))
    ) {
      workflow = transitionWorkflow(workflow, "waiting_user", updatedAt);
      await updateProjectWorkflow(connection, workflow);
      await appendStatusEvent(connection, {
        workflow,
        actorType: "system",
        actorId: "collaboration-scheduler",
        body: { reason: input.code },
      });
    }
  });
}

export async function blockReviewWorkItem(input: {
  workItemId: string;
  reviewerRoleId: string;
  code: string;
  detail: string;
}): Promise<void> {
  await ensureReady();
  const actor = requireText(input.reviewerRoleId, "复核员工不能为空");
  const detail = requireText(input.detail, "阻塞原因不能为空");
  const updatedAt = shanghaiTime().iso;
  await withTransaction(async (connection) => {
    const item = await getProjectWorkItem(connection, input.workItemId, true);
    if (!item) throw new RuleError("找不到这个工作项");
    let workflow = await getProjectWorkflow(connection, item.workflowId, true);
    if (!workflow) throw new RuleError("找不到这个协作任务");
    if (item.reviewerRoleId !== actor) throw new RuleError("只有指定复核员工可以阻塞这个工作项");
    const blocked = transitionWorkItem(item, "blocked", updatedAt, {
      blockedReason: `${input.code}: ${detail}`,
    });
    await updateProjectWorkItem(connection, blocked);
    await appendStatusEvent(connection, {
      workflow,
      item: blocked,
      actorType: "agent",
      actorId: actor,
      body: { action: "blocked", code: input.code, detail, source: "reviewer" },
    });
    const items = await listProjectWorkItems(connection, workflow.id, true);
    if (
      workflow.status === "collaborating" &&
      !items.some((candidate) => ["ready", "running", "review"].includes(candidate.status))
    ) {
      workflow = transitionWorkflow(workflow, "waiting_user", updatedAt);
      await updateProjectWorkflow(connection, workflow);
      await appendStatusEvent(connection, {
        workflow,
        actorType: "system",
        actorId: "collaboration-scheduler",
        body: { reason: input.code },
      });
    }
  });
}

export async function resumeRecoverableWorkflowBlocks(workflowId: string): Promise<boolean> {
  await ensureReady();
  const updatedAt = shanghaiTime().iso;
  return withTransaction(async (connection) => {
    let workflow = await getProjectWorkflow(connection, workflowId, true);
    if (!workflow || workflow.status !== "waiting_user") return false;
    const items = await listProjectWorkItems(connection, workflow.id, true);
    const recoverable = items.filter(
      (item) =>
        item.status === "blocked" &&
        (/^missing_configuration:\s*找不到验证配置：.+可用 profile：/i.test(item.blockedReason) ||
          /^missing_configuration:.*(?:无法执行|缺少|profile|验证配置)/i.test(item.blockedReason)),
    );
    if (recoverable.length === 0) return false;
    for (const item of recoverable) {
      const queued = transitionWorkItem(item, "queued", updatedAt);
      await updateProjectWorkItem(connection, queued);
      await appendStatusEvent(connection, {
        workflow,
        item: queued,
        actorType: "system",
        actorId: "collaboration-scheduler",
        body: { action: "resumed", reason: "工具 profile 已可自动纠正" },
      });
    }
    workflow = transitionWorkflow(workflow, "collaborating", updatedAt);
    await updateProjectWorkflow(connection, workflow);
    await appendStatusEvent(connection, {
      workflow,
      actorType: "system",
      actorId: "collaboration-scheduler",
      body: { reason: "系统已修复工具 profile 引用" },
    });
    await advanceWorkflowAfterItemChange(connection, workflow, updatedAt);
    return true;
  });
}

export async function resumeWorkflowAfterSystemFix(input: {
  workflowId: string;
  expectedErrorText: string;
}): Promise<boolean> {
  await ensureReady();
  const expected = requireText(input.expectedErrorText, "预期错误不能为空");
  const updatedAt = shanghaiTime().iso;
  return withTransaction(async (connection) => {
    let workflow = await getProjectWorkflow(connection, input.workflowId, true);
    if (!workflow || workflow.status !== "failed" || workflow.errorText !== expected) return false;
    const items = await listProjectWorkItems(connection, workflow.id, true);
    for (const item of items.filter((candidate) => candidate.status === "done")) {
      await releaseItemWorkspaceLeases(connection, workflow, item.id);
    }
    const failedItems = items.filter((item) => item.status === "failed" && item.errorText === expected);
    if (failedItems.length === 0) return false;
    for (const item of failedItems) {
      const ready = transitionWorkItem(item, "ready", updatedAt);
      await updateProjectWorkItem(connection, ready);
      await appendStatusEvent(connection, {
        workflow,
        item: ready,
        actorType: "system",
        actorId: "collaboration-scheduler",
        body: { action: "resumed", reason: "系统缺陷已修复" },
      });
    }
    workflow = {
      ...transitionWorkflow(workflow, "collaborating", updatedAt),
      errorText: "",
    };
    await updateProjectWorkflow(connection, workflow);
    await appendStatusEvent(connection, {
      workflow,
      actorType: "system",
      actorId: "collaboration-scheduler",
      body: { reason: "系统缺陷已修复，自动恢复执行" },
    });
    return true;
  });
}

export async function retryFailedWorkflow(workflowId: string): Promise<boolean> {
  await ensureReady();
  const updatedAt = shanghaiTime().iso;
  return withTransaction(async (connection) => {
    let workflow = await getProjectWorkflow(connection, workflowId, true);
    if (!workflow) throw new RuleError("找不到这个协作任务");
    if (workflow.status !== "failed") throw new RuleError("只有失败的协作任务可以重试");
    const items = await listProjectWorkItems(connection, workflow.id, true);
    const failedItems = items.filter((item) => item.status === "failed");
    if (failedItems.length === 0) throw new RuleError("没有可重试的失败工作项");
    for (const item of failedItems) {
      const ready = { ...transitionWorkItem(item, "ready", updatedAt), retryCount: 0 };
      await updateProjectWorkItem(connection, ready);
      await appendStatusEvent(connection, {
        workflow,
        item: ready,
        actorType: "boss",
        actorId: "boss",
        body: { action: "retried", detail: "老板要求重新执行" },
      });
    }
    workflow = {
      ...transitionWorkflow(workflow, "collaborating", updatedAt),
      errorText: "",
    };
    await updateProjectWorkflow(connection, workflow);
    await appendStatusEvent(connection, {
      workflow,
      actorType: "boss",
      actorId: "boss",
      body: { action: "retried", detail: "失败任务已重新进入队列" },
    });
    return true;
  });
}

export async function requestWorkflowDecision(input: {
  workflowId: string;
  workItemId: string | null;
  askedByRoleId: string;
  question: string;
  options: DecisionOption[];
  recommendation: string;
  reason: string;
  blockingWorkItemIds: string[];
}): Promise<{ decisionId: string; workflowStatus: ProjectWorkflow["status"] }> {
  await ensureReady();
  const question = requireText(input.question, "待决问题不能为空");
  const reason = requireText(input.reason, "待决理由不能为空");
  if (input.options.length < 2) throw new RuleError("待决问题至少需要两个选项");
  const recommendation = decisionRecommendationId(input.options, input.recommendation) ?? "";
  const now = shanghaiTime().iso;
  const decisionId = `dr-${randomUUID()}`;
  let workflowStatus: ProjectWorkflow["status"] = "collaborating";
  await withTransaction(async (connection) => {
    let workflow = await getProjectWorkflow(connection, input.workflowId, true);
    if (!workflow) throw new RuleError("找不到这个协作任务");
    if (workflow.status !== "collaborating") throw new RuleError("协作任务当前不能提交待决问题");
    const items = await listProjectWorkItems(connection, workflow.id, true);
    const itemById = new Map(items.map((item) => [item.id, item]));
    if (input.workItemId && !itemById.has(input.workItemId)) throw new RuleError("待决问题的工作项不属于这个协作任务");
    const askingItem = input.workItemId ? itemById.get(input.workItemId) : null;
    if (
      input.askedByRoleId !== workflow.coordinatorRoleId &&
      askingItem?.ownerRoleId !== input.askedByRoleId
    ) {
      throw new RuleError("只有协调员工或工作项主责可以提交待决问题");
    }
    const openRequests = await listOpenWorkflowDecisionRequests(connection, workflow.id);
    if (input.workItemId && openRequests.some((request) => request.workItemId === input.workItemId)) {
      throw new RuleError("这个工作项已经有一个待决问题在等老板回复，不能重复提交");
    }
    const blockingIds = [...new Set(input.blockingWorkItemIds)];
    if (blockingIds.length === 0) throw new RuleError("待决问题必须指定阻塞工作项");
    for (const id of blockingIds) {
      const item = itemById.get(id);
      if (!item) throw new RuleError("待决问题阻塞了未知工作项");
      if (["done", "failed", "cancelled"].includes(item.status)) {
        throw new RuleError("已结束的工作项不能被待决问题阻塞");
      }
      const blocked = transitionWorkItem(item, "blocked", now, { blockedReason: question });
      await updateProjectWorkItem(connection, blocked);
      itemById.set(id, blocked);
    }
    await insertProjectDecisionRequest(connection, {
      id: decisionId,
      workflowId: workflow.id,
      workItemId: input.workItemId,
      askedByRoleId: input.askedByRoleId,
      question,
      options: input.options,
      recommendation,
      reason,
      blockingWorkItemIds: blockingIds,
      status: "open",
      answer: "",
      createdAt: now,
      resolvedAt: null,
    });
    const remaining = [...itemById.values()];
    if (!remaining.some((item) => item.status === "ready" || item.status === "running" || item.status === "review")) {
      workflow = transitionWorkflow(workflow, "waiting_user", now);
      await updateProjectWorkflow(connection, workflow);
      await appendStatusEvent(connection, {
        workflow,
        actorType: "system",
        actorId: "collaboration-scheduler",
      });
    }
    workflowStatus = workflow.status;
    await appendProjectEvent(connection, {
      projectId: workflow.projectId,
      workflowId: workflow.id,
      workItemId: input.workItemId,
      actorType: "agent",
      actorId: input.askedByRoleId,
      kind: "decision_requested",
      body: {
        decisionId,
        question,
        options: input.options,
        recommendation,
        reason,
        blockingWorkItemIds: blockingIds,
      },
      createdAt: now,
    });
  });
  return { decisionId, workflowStatus };
}

export async function requestWorkflowDecisionByScope(input: {
  workflowId: string;
  currentWorkItemId: string;
  askedByRoleId: string;
  scope: DecisionScope;
  question: string;
  options: DecisionOption[];
  recommendation: string;
  reason: string;
}): Promise<{ decisionId: string; workflowStatus: ProjectWorkflow["status"] }> {
  const view = await loadCollaborationWorkflow(input.workflowId);
  const blockingWorkItemIds = resolveDecisionScope({
    currentWorkItemId: input.currentWorkItemId,
    scope: input.scope,
    items: view.items,
    dependencies: view.dependencies,
  });
  if (blockingWorkItemIds.length === 0) throw new RuleError("待决作用域没有可阻塞的工作项");
  return requestWorkflowDecision({
    workflowId: input.workflowId,
    workItemId: input.currentWorkItemId,
    askedByRoleId: input.askedByRoleId,
    question: input.question,
    options: input.options,
    recommendation: input.recommendation,
    reason: input.reason,
    blockingWorkItemIds,
  });
}

export async function resolveWorkflowDecision(input: {
  decisionId: string;
  answer: string;
}): Promise<{ workflowId: string; workflowStatus: ProjectWorkflow["status"] }> {
  await ensureReady();
  const answer = requireText(input.answer, "决定内容不能为空");
  const now = shanghaiTime().iso;
  let workflowId = "";
  let workflowStatus: ProjectWorkflow["status"] = "collaborating";
  await withTransaction(async (connection) => {
    const request = await getProjectDecisionRequest(connection, input.decisionId, true);
    if (!request) throw new RuleError("找不到这个待决问题");
    workflowId = request.workflowId;
    let workflow = await getProjectWorkflow(connection, request.workflowId, true);
    if (!workflow) throw new RuleError("找不到这个协作任务");
    const resolved = closeDecisionRequest(request, "resolved", answer, now);
    await updateProjectDecisionRequest(connection, resolved);
    const items = await listProjectWorkItems(connection, workflow.id, true);
    for (const item of items) {
      if (request.blockingWorkItemIds.includes(item.id) && item.status === "blocked") {
        await updateProjectWorkItem(connection, transitionWorkItem(item, "queued", now));
      }
    }
    if (workflow.status === "waiting_user") {
      workflow = transitionWorkflow(workflow, "collaborating", now);
      await updateProjectWorkflow(connection, workflow);
      await appendStatusEvent(connection, {
        workflow,
        actorType: "system",
        actorId: "collaboration-scheduler",
      });
    }
    const refreshed = await listProjectWorkItems(connection, workflow.id, true);
    const dependencies = await listWorkflowDependencies(connection, workflow.id);
    const released = releaseReadyWorkItems(refreshed, dependencies, now);
    const previous = new Map(refreshed.map((item) => [item.id, item.status]));
    for (const item of released) {
      if (previous.get(item.id) === item.status) continue;
      await updateProjectWorkItem(connection, item);
      await appendStatusEvent(connection, {
        workflow,
        item,
        actorType: "system",
        actorId: "collaboration-scheduler",
        body: { reason: "老板已经做出决定" },
      });
    }
    workflowStatus = workflow.status;
    await appendProjectEvent(connection, {
      projectId: workflow.projectId,
      workflowId: workflow.id,
      workItemId: request.workItemId,
      actorType: "boss",
      actorId: null,
      kind: "decision_resolved",
      body: { decisionId: request.id, answer },
      createdAt: now,
    });
  });
  return { workflowId, workflowStatus };
}

export async function approveCollaborationWorkflow(
  workflowId: string,
  decision = "",
  record = true,
): Promise<{ paths: string[]; exportWarning: string | null }> {
  await ensureReady();
  const applying = await withTransaction(async (connection) => {
    const workflow = await getProjectWorkflow(connection, workflowId, true);
    if (!workflow) throw new RuleError("找不到这个协作任务");
    const next = transitionWorkflow(workflow, "applying", shanghaiTime().iso);
    await updateProjectWorkflow(connection, next);
    await appendStatusEvent(connection, {
      workflow: next,
      actorType: "boss",
      actorId: "boss",
    });
    return next;
  });
  const project = await getProject(getPool(), applying.projectId);
  if (!project) throw new RuleError("找不到这个项目");
  const workspace = workflowWorkspace({
    companyId: project.companyId,
    projectId: project.id,
    workflowId,
  });
  let approvedTask: Task | null = null;
  try {
    const applied = await workspace.apply(async () => {
      await withTransaction(async (connection) => {
        const current = await getProjectWorkflow(connection, workflowId, true);
        if (!current || current.status !== "applying") throw new RuleError("协作任务不在应用状态");
        const approved = transitionWorkflow(current, "approved", shanghaiTime().iso);
        if (current.taskId) {
          const task = await getTask(connection, current.taskId, true);
          if (!task || task.status !== "review") throw new RuleError("关联任务不在待批准状态");
          const now = shanghaiTime();
          approvedTask = approveTask(task, decision, now.noteStamp, now.iso);
          await updateTask(connection, approvedTask);
          if (record) {
            await insertDecision(
              connection,
              {
                day: now.day,
                title: approvedTask.decision ?? decision.trim(),
                decision: approvedTask.decision ?? decision.trim(),
                reason: `你批准了任务 ${task.id} 的项目团队协作。`,
                taskId: task.id,
              },
              now.iso,
            );
          }
        }
        await updateProjectWorkflow(connection, approved);
        await appendProjectEvent(connection, {
          projectId: approved.projectId,
          workflowId: approved.id,
          workItemId: null,
          actorType: "boss",
          actorId: null,
          kind: "approval",
          body: { summary: approved.summary },
          createdAt: approved.updatedAt,
        });
      });
    });
    const warnings: string[] = [];
    if (approvedTask) {
      await exportTaskFile(approvedTask).catch((error) => {
        warnings.push(`数据库已写入，任务文件副本尚未刷新。${error instanceof Error ? error.message : "导出失败"}`);
      });
    }
    if (record && approvedTask) {
      await exportDecisions(await listDecisions(getPool())).catch((error) => {
        warnings.push(`数据库已写入，决策文件副本尚未刷新。${error instanceof Error ? error.message : "导出失败"}`);
      });
    }
    return { paths: applied.paths, exportWarning: warnings.join(" ") || null };
  } catch (error) {
    await withTransaction(async (connection) => {
      const current = await getProjectWorkflow(connection, workflowId, true);
      if (current?.status === "applying") {
        const review = transitionWorkflow(current, "review", shanghaiTime().iso, {
          summary: current.summary || "应用文件失败",
        });
        await updateProjectWorkflow(connection, review);
        await appendProjectEvent(connection, {
          projectId: review.projectId,
          workflowId: review.id,
          workItemId: null,
          actorType: "system",
          actorId: "collaboration-scheduler",
          kind: "error",
          body: { message: error instanceof Error ? error.message : "应用文件失败" },
          createdAt: review.updatedAt,
        });
      }
    });
    throw error;
  }
}

export async function returnCollaborationWorkflow(
  workflowId: string,
  reason: string,
): Promise<{ correctionWorkItemId: string }> {
  await ensureReady();
  const returnReason = requireText(reason, "退回原因不能为空");
  const correctionWorkItemId = `wi-${randomUUID()}`;
  let returnedTask: Task | null = null;
  await withTransaction(async (connection) => {
    let workflow = await getProjectWorkflow(connection, workflowId, true);
    if (!workflow) throw new RuleError("找不到这个协作任务");
    if (workflow.taskId) {
      const task = await getTask(connection, workflow.taskId, true);
      if (!task) throw new RuleError("找不到关联任务");
      returnedTask = returnTask(
        task,
        returnReason,
        doingCount(await listTasks(connection)),
        shanghaiTime().noteStamp,
        shanghaiTime().iso,
      );
      await updateTask(connection, returnedTask);
    }
    workflow = transitionWorkflow(workflow, "returned", shanghaiTime().iso, { returnReason });
    await updateProjectWorkflow(connection, workflow);
    const items = await listProjectWorkItems(connection, workflow.id, true);
    const correction = transitionWorkItem(
      {
        id: correctionWorkItemId,
        workflowId: workflow.id,
        position: items.length,
        title: "处理老板退回意见",
        objective: returnReason,
        acceptance: ["退回原因已经处理并提供新的验收证据"],
        ownerRoleId: workflow.coordinatorRoleId,
        reviewerRoleId: null,
        status: "queued",
        blockedReason: "",
        summary: "",
        evidence: [],
        errorText: "",
        retryCount: 0,
        createdAt: workflow.updatedAt,
        updatedAt: workflow.updatedAt,
      },
      "ready",
      workflow.updatedAt,
    );
    await insertProjectWorkItem(connection, correction);
    workflow = transitionWorkflow(workflow, "collaborating", workflow.updatedAt);
    await updateProjectWorkflow(connection, workflow);
    await appendProjectEvent(connection, {
      projectId: workflow.projectId,
      workflowId: workflow.id,
      workItemId: null,
      actorType: "boss",
      actorId: null,
      kind: "return",
      body: { reason: returnReason, correctionWorkItemId },
      createdAt: workflow.updatedAt,
    });
    await appendProjectEvent(connection, {
      projectId: workflow.projectId,
      workflowId: workflow.id,
      workItemId: correction.id,
      actorType: "system",
      actorId: "collaboration-scheduler",
      kind: "work_item_created",
      body: {
        position: correction.position,
        title: correction.title,
        ownerRoleId: correction.ownerRoleId,
        reviewerRoleId: null,
      },
      createdAt: workflow.updatedAt,
    });
  });
  if (returnedTask) await exportTaskFile(returnedTask);
  return { correctionWorkItemId };
}

