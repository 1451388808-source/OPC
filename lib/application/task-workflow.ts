import { createCollaborationWorkflow } from "./collaboration";
import { enqueueCollaborationWorkflow } from "../collaboration/agent-runner";
import { RuleError } from "../domain/task";
import { getPool } from "../infrastructure/db";
import { getTask } from "../infrastructure/store";
import { ensureReady } from "./board";
import { planProjectWorkItems, selectProjectCoordinator } from "./project-message";

export async function dispatchTaskToTeam(input: {
  taskId: string;
  projectId: string;
}): Promise<{ workflowId: string }> {
  await ensureReady();
  const task = await getTask(getPool(), input.taskId);
  if (!task) throw new RuleError("找不到这条任务");
  const coordinatorRoleId = await selectProjectCoordinator(input.projectId);
  const requestText = [
    `任务：${task.title}`,
    `原话：${task.brief}`,
    `目标：${task.goal}`,
    "验收：",
    ...task.acceptance.map((item, index) => `${index + 1}. ${item}`),
  ].join("\n");
  const workItems = await planProjectWorkItems(input.projectId, requestText, coordinatorRoleId);
  const view = await createCollaborationWorkflow({
    projectId: input.projectId,
    taskId: task.id,
    title: task.title,
    requestText,
    coordinatorRoleId,
    workItems,
  });
  enqueueCollaborationWorkflow(view.workflow.id);
  return { workflowId: view.workflow.id };
}

