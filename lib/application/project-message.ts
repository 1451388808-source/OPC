import {
  createCollaborationWorkflow,
  loadCollaborationWorkflow,
  resumeRecoverableWorkflowBlocks,
} from "./collaboration";
import { recordProjectEvent } from "./project-event";
import { sayInProject, type ProjectEvent as LiveProjectEvent } from "./org";
import {
  isWorkflowFollowUp,
  routeProjectMessage,
  type ProjectMessageRoute,
  type ProjectMessageRouteContext,
} from "../collaboration/router";
import { RuleError } from "../domain/task";
import { readRoles } from "../infrastructure/files";
import { getPool } from "../infrastructure/db";
import { getProject, listMemberIds } from "../infrastructure/org-store";
import { ensureReady } from "./board";
import { generateWorkflowPlan, planDrafts } from "../collaboration/model-plan";
import { enqueueCollaborationWorkflow } from "../collaboration/agent-runner";
import { listProjectWorkflows } from "../infrastructure/collaboration-store";
import { isWorkflowStatusQuestion, workflowStatusMessage } from "../collaboration/status-message.ts";

export type ProjectMessageProcessingEvent =
  | { type: "route"; route: ProjectMessageRoute }
  | { type: "workflow"; workflowId: string; title: string; status: string }
  | LiveProjectEvent;

export async function selectProjectCoordinator(projectId: string): Promise<string> {
  await ensureReady();
  const project = await getProject(getPool(), projectId);
  if (!project) throw new RuleError("找不到这个项目");
  const memberIds = await listMemberIds(getPool(), projectId);
  if (memberIds.length === 0) throw new RuleError("先把员工加入项目");
  const roles = await readRoles();
  const members = roles.filter((role) => memberIds.includes(role.id));
  return (
    members.find((role) => role.id === "planner") ??
    members.find((role) => role.skills.includes("task-shaping")) ??
    members.find((role) => role.inboxDefault) ??
    members[0]
  )!.id;
}

export async function planProjectWorkItems(
  projectId: string,
  requestText: string,
  coordinatorRoleId: string,
) {
  const memberIds = await listMemberIds(getPool(), projectId);
  const roles = await readRoles();
  const members = roles.filter((role) => memberIds.includes(role.id));
  const coordinator = members.find((role) => role.id === coordinatorRoleId);
  if (!coordinator) throw new RuleError("找不到协调员工");
  try {
    return planDrafts(
      await generateWorkflowPlan({
        requestText,
        coordinator,
        members,
      }),
    );
  } catch (error) {
    const owner = members.find((role) => role.id === "engineer") ?? coordinator;
    console.error("协调计划生成失败，使用保守计划", error);
    return [
      {
        key: "execute",
        title: requestText.length <= 40 ? requestText : `${Array.from(requestText).slice(0, 40).join("")}…`,
        objective: requestText,
        acceptance: ["产出和完成摘要可以在项目时间线中检查"],
        ownerRoleId: owner.id,
        reviewerRoleId: owner.id === coordinator.id ? null : coordinator.id,
        dependsOn: [],
      },
    ];
  }
}

export async function processProjectMessage(input: {
  projectId: string;
  text: string;
  context?: ProjectMessageRouteContext;
  emit?: (event: ProjectMessageProcessingEvent) => void;
}): Promise<void> {
  let route = routeProjectMessage(input.text, input.context);
  if (
    !input.context?.override &&
    !input.context?.workflowId &&
    !input.context?.decisionId &&
    !input.context?.reviewAction &&
    !isWorkflowStatusQuestion(input.text) &&
    isWorkflowFollowUp(input.text)
  ) {
    const workflows = await listProjectWorkflows(getPool(), input.projectId);
    const active = workflows.find((workflow) =>
      ["collaborating", "waiting_user", "verifying", "returned"].includes(workflow.status),
    );
    if (active) {
      route = {
        text: route.text,
        intent: { type: "workflow_input", workflowId: active.id },
        confidence: "high",
        reason: "消息是对进行中协作任务的补充要求。",
      };
    }
  }
  const emit = input.emit ?? (() => {});
  emit({ type: "route", route });

  if (route.intent.type === "conversation") {
    if (isWorkflowStatusQuestion(route.text)) {
      const workflows = await listProjectWorkflows(getPool(), input.projectId);
      const activeStatuses = new Set([
        "intake",
        "planning",
        "collaborating",
        "waiting_user",
        "verifying",
        "review",
        "applying",
        "returned",
      ]);
      const selected = workflows.find((workflow) => activeStatuses.has(workflow.status)) ?? workflows[0];
      if (selected) {
        const resumed = await resumeRecoverableWorkflowBlocks(selected.id);
        const view = await loadCollaborationWorkflow(selected.id);
        const roles = await readRoles();
        const roleId = view.workflow.coordinatorRoleId;
        const name = roles.find((role) => role.id === roleId)?.name ?? roleId;
        const answer = workflowStatusMessage({ ...view, resumed });
        await recordProjectEvent({
          projectId: input.projectId,
          workflowId: view.workflow.id,
          actorType: "boss",
          kind: "user_message",
          body: {
            text: route.text,
            route: { type: route.intent.type, confidence: route.confidence, reason: route.reason },
          },
        });
        emit({ type: "user", text: route.text });
        emit({ type: "start", roleId, name });
        emit({ type: "reply", roleId, delta: answer });
        await recordProjectEvent({
          projectId: input.projectId,
          workflowId: view.workflow.id,
          actorType: "agent",
          actorId: roleId,
          kind: "agent_message",
          body: { text: answer, statusAnswer: true },
        });
        if (resumed) enqueueCollaborationWorkflow(view.workflow.id);
        return;
      }
    }
    const coordinatorRoleId = await selectProjectCoordinator(input.projectId);
    await sayInProject(input.projectId, route.text, coordinatorRoleId, emit, {
      route: {
        type: route.intent.type,
        confidence: route.confidence,
        reason: route.reason,
      },
    });
    return;
  }

  if (route.intent.type === "new_workflow") {
    const coordinatorRoleId = await selectProjectCoordinator(input.projectId);
    const workItems = await planProjectWorkItems(input.projectId, route.text, coordinatorRoleId);
    const sourceEventId = await recordProjectEvent({
      projectId: input.projectId,
      actorType: "boss",
      kind: "user_message",
      body: {
        text: route.text,
        route: {
          type: route.intent.type,
          confidence: route.confidence,
          reason: route.reason,
        },
      },
    });
    const view = await createCollaborationWorkflow({
      projectId: input.projectId,
      sourceEventId,
      title: route.intent.title,
      requestText: route.text,
      coordinatorRoleId,
      workItems,
    });
    emit({
      type: "workflow",
      workflowId: view.workflow.id,
      title: view.workflow.title,
      status: view.workflow.status,
    });
    enqueueCollaborationWorkflow(view.workflow.id);
    return;
  }

  if (route.intent.type === "workflow_input") {
    const view = await loadCollaborationWorkflow(route.intent.workflowId);
    if (view.workflow.projectId !== input.projectId) throw new RuleError("协作任务不属于这个项目");
    await recordProjectEvent({
      projectId: input.projectId,
      workflowId: view.workflow.id,
      actorType: "boss",
      kind: "user_message",
      body: { text: route.text, route: { type: route.intent.type } },
    });
    emit({
      type: "workflow",
      workflowId: view.workflow.id,
      title: view.workflow.title,
      status: view.workflow.status,
    });
    if (view.workflow.status === "collaborating") enqueueCollaborationWorkflow(view.workflow.id);
    return;
  }

  throw new RuleError("这个群聊动作将在用户仲裁阶段接入");
}

