import { randomUUID } from "node:crypto";
import {
  transitionProjectRun,
  type ProjectRun,
  type ProjectRunFile,
  type ProjectRunStatus,
} from "../domain/project-run";
import {
  approveTask,
  dispatchTaskToRole,
  doingCount,
  returnTask,
  RuleError,
  submitTaskForReview,
  type Task,
} from "../domain/task";
import { shanghaiTime } from "../domain/time";
import { deepSeekToolModel, deepseekProvider } from "../employees/deepseek";
import { executeToolLoop } from "../employees/tool-loop";
import { createProjectFileTools } from "../employees/tools";
import { getPool, withTransaction } from "../infrastructure/db";
import {
  exportDecisions,
  exportTaskFile,
  readRoles,
  readSkillText,
} from "../infrastructure/files";
import { getProject, listMemberIds } from "../infrastructure/org-store";
import {
  appendProjectRunEvent,
  failInterruptedProjectRuns,
  findActiveTaskRun,
  getProjectRun,
  insertProjectRun,
  listProjectRunEvents,
  listProjectRunFiles,
  listProjectRuns,
  listExpiredProjectRunIds,
  listQueuedProjectRunIds,
  updateProjectRun,
  upsertProjectRunFile,
} from "../infrastructure/project-run-store";
import {
  getTask,
  insertDecision,
  listDecisions,
  listTasks,
  updateTask,
} from "../infrastructure/store";
import { projectWorkspace } from "../project-workspace";
import { removeRunWorkspace, runWorkspace } from "../project-workspace/run-workspace";
import { ensureReady } from "./board";
import { createProjectRunQueue, type ProjectRunQueue } from "./project-run-queue";

export type ProjectRunView = {
  run: ProjectRun;
  events: Awaited<ReturnType<typeof listProjectRunEvents>>;
  files: (ProjectRunFile & { diff: string })[];
};

declare global {
  var __opcProjectRunQueue: ProjectRunQueue | undefined;
  var __opcProjectRunRecovery: Promise<void> | undefined;
}

async function exportTaskSafely(task: Task): Promise<string | null> {
  try {
    await exportTaskFile(task);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "导出失败";
    return `数据库已写入，任务文件副本尚未刷新。${message}`;
  }
}

async function moveRun(
  runId: string,
  status: ProjectRunStatus,
  detail: { summary?: string; errorText?: string; returnReason?: string } = {},
  event?: { kind: "message" | "error"; body: unknown },
): Promise<ProjectRun> {
  const now = shanghaiTime().iso;
  return withTransaction(async (conn) => {
    const current = await getProjectRun(conn, runId, true);
    if (!current) throw new RuleError("找不到这次执行");
    const next = transitionProjectRun(current, status, now, detail);
    await updateProjectRun(conn, next);
    if (event) {
      await appendProjectRunEvent(conn, {
        runId,
        kind: event.kind,
        body: event.body,
        createdAt: now,
      });
    }
    return next;
  });
}

export async function performProjectRun(runId: string): Promise<void> {
  try {
    const running = await moveRun(
      runId,
      "running",
      {},
      { kind: "message", body: { text: "本机执行器已接手。" } },
    );
    const projectRow = await getProject(getPool(), running.projectId);
    if (!projectRow) throw new RuleError("找不到这个项目");
    const roles = await readRoles();
    const employee = roles.find((role) => role.id === running.roleId);
    if (!employee) throw new RuleError("找不到这个员工");
    if (employee.model.provider !== deepseekProvider || !employee.model.model) {
      throw new RuleError(`${employee.name} 还没有接入可执行文件工具的模型`);
    }
    const skillText = (
      await Promise.all(employee.skills.map((skillId) => readSkillText(skillId)))
    )
      .filter(Boolean)
      .join("\n\n");
    const ref = { companyId: projectRow.companyId, projectId: projectRow.id };
    const project = projectWorkspace(ref);
    const staged = runWorkspace({ ...ref, runId });
    const tools = createProjectFileTools({ project, run: staged });
    const system = [
      employee.prompt.trim() || `你是 OPC 的${employee.name}。`,
      skillText ? `按这些技能做：\n${skillText}` : "",
      "你正在受限的项目工作区中执行任务。",
      "文件事实只来自 list_files 和 read_file；修改只能使用 write_file，并且只会进入等待批准的暂存区。",
      "先查看需要的文件，再写完整文件内容。没有工具结果时，不得声称看过或修改过文件。",
      "本次执行必须产生至少一个有效文件修改。最后用中文简要列出修改路径和完成情况。",
    ]
      .filter(Boolean)
      .join("\n\n");
    const result = await executeToolLoop({
      model: deepSeekToolModel,
      modelName: employee.model.model,
      system,
      user: running.requestText,
      tools,
      emit: async (event) => {
        await appendProjectRunEvent(getPool(), {
          runId,
          kind: event.kind,
          body: event.body,
          createdAt: shanghaiTime().iso,
        });
      },
    });
    const changes = await staged.changes();
    if (changes.length === 0) throw new Error("执行没有产生文件修改");
    let completedTask: Task | null = null;
    await withTransaction(async (conn) => {
      const task = running.taskId ? await getTask(conn, running.taskId, true) : null;
      const current = await getProjectRun(conn, runId, true);
      if (!current) throw new RuleError("找不到这次执行");
      const now = shanghaiTime();
      const next = transitionProjectRun(current, "review", now.iso, {
        summary: result.summary,
      });
      for (const change of changes) {
        await upsertProjectRunFile(conn, {
          runId,
          path: change.path,
          operation: change.operation,
          beforeSha256: change.beforeSha256,
          afterSha256: change.afterSha256,
          beforeSize: change.beforeSize,
          afterSize: change.afterSize,
        });
      }
      if (current.taskId) {
        if (!task) throw new RuleError("找不到关联任务");
        completedTask = submitTaskForReview(
          task,
          changes.map(
            (change) =>
              `workspaces/${projectRow.companyId}/${projectRow.id}/${change.path}`,
          ),
          result.summary,
          now.noteStamp,
          now.iso,
        );
        await updateTask(conn, completedTask);
      }
      await updateProjectRun(conn, next);
    });
    if (completedTask) {
      const warning = await exportTaskSafely(completedTask);
      if (warning) {
        await appendProjectRunEvent(getPool(), {
          runId,
          kind: "error",
          body: { message: warning },
          createdAt: shanghaiTime().iso,
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "执行失败";
    try {
      const current = await getProjectRun(getPool(), runId);
      if (current?.status === "queued" || current?.status === "running" || current?.status === "applying") {
        await moveRun(runId, "failed", { errorText: message }, { kind: "error", body: { message } });
      }
    } catch (recoveryError) {
      console.error("记录项目执行失败状态时出错", recoveryError);
    }
    throw error;
  }
}

function projectRunQueue(): ProjectRunQueue {
  if (!globalThis.__opcProjectRunQueue) {
    globalThis.__opcProjectRunQueue = createProjectRunQueue(performProjectRun, (runId, error) => {
      console.error(`项目执行 ${runId} 失败`, error);
    });
  }
  return globalThis.__opcProjectRunQueue;
}

export function enqueueProjectRun(runId: string): void {
  projectRunQueue().enqueue(runId);
}

export async function recoverInterruptedRuns(
  enqueue: (runId: string) => void = enqueueProjectRun,
): Promise<string[]> {
  await ensureReady();
  const now = shanghaiTime().iso;
  await failInterruptedProjectRuns(getPool(), now, "服务重启，执行中断");
  const retentionDays = Number(process.env.PROJECT_RUN_RETENTION_DAYS ?? 30);
  const before = new Date(Date.now() - Math.max(1, retentionDays) * 86_400_000).toISOString();
  await cleanupRunWorkspacesBefore(before);
  const queued = await listQueuedProjectRunIds(getPool());
  for (const runId of queued) enqueue(runId);
  return queued;
}

async function cleanupRunWorkspacesBefore(before: string): Promise<string[]> {
  const ids = await listExpiredProjectRunIds(getPool(), before);
  for (const id of ids) await removeRunWorkspace(id);
  return ids;
}

export async function cleanupExpiredProjectRuns(retentionDays = 30): Promise<string[]> {
  if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new RuleError("保留天数必须大于 0");
  await ensureReady();
  const before = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  return cleanupRunWorkspacesBefore(before);
}

export function ensureProjectRunRuntime(): Promise<void> {
  if (!globalThis.__opcProjectRunRecovery) {
    globalThis.__opcProjectRunRecovery = recoverInterruptedRuns()
      .then(() => {})
      .catch((error) => {
        globalThis.__opcProjectRunRecovery = undefined;
        throw error;
      });
  }
  return globalThis.__opcProjectRunRecovery!;
}

export async function createProjectRun(input: {
  projectId: string;
  roleId: string;
  requestText: string;
}): Promise<{ runId: string }> {
  const requestText = input.requestText.trim();
  const roleId = input.roleId.trim();
  if (!requestText) throw new RuleError("先写执行要求");
  if (requestText.length > 20_000) throw new RuleError("执行要求太长");
  if (!roleId) throw new RuleError("先选择员工");
  await ensureProjectRunRuntime();
  const now = shanghaiTime().iso;
  const run = await withTransaction(async (conn) => {
    const project = await getProject(conn, input.projectId);
    if (!project) throw new RuleError("找不到这个项目");
    const members = await listMemberIds(conn, input.projectId);
    if (!members.includes(roleId)) throw new RuleError("先把这个员工加进项目");
    const created: ProjectRun = {
      id: `r-${randomUUID()}`,
      projectId: input.projectId,
      taskId: null,
      roleId,
      requestText,
      status: "queued",
      summary: "",
      errorText: "",
      returnReason: "",
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
    };
    await insertProjectRun(conn, created);
    return created;
  });
  enqueueProjectRun(run.id);
  return { runId: run.id };
}

export async function dispatchTask(input: {
  taskId: string;
  projectId: string;
  roleId: string;
}, enqueue: (runId: string) => void = enqueueProjectRun): Promise<{ runId: string; exportWarning: string | null }> {
  const roleId = input.roleId.trim();
  if (!roleId) throw new RuleError("先选择员工");
  await ensureProjectRunRuntime();
  const now = shanghaiTime();
  const result = await withTransaction(async (conn) => {
    const tasks = await listTasks(conn);
    const task = await getTask(conn, input.taskId, true);
    if (!task) throw new RuleError("找不到这条任务");
    const project = await getProject(conn, input.projectId);
    if (!project) throw new RuleError("找不到这个项目");
    const members = await listMemberIds(conn, input.projectId);
    if (!members.includes(roleId)) throw new RuleError("先把这个员工加进项目");
    if (await findActiveTaskRun(conn, input.taskId, true)) {
      throw new RuleError("这条任务已经有正在进行的执行");
    }
    const dispatched = dispatchTaskToRole(
      task,
      roleId,
      doingCount(tasks),
      now.noteStamp,
      now.iso,
    );
    const run: ProjectRun = {
      id: `r-${randomUUID()}`,
      projectId: input.projectId,
      taskId: input.taskId,
      roleId,
      requestText: [
        `任务：${dispatched.title}`,
        `原话：${dispatched.brief}`,
        `目标：${dispatched.goal}`,
        "验收：",
        ...dispatched.acceptance.map((item, index) => `${index + 1}. ${item}`),
      ].join("\n"),
      status: "queued",
      summary: "",
      errorText: "",
      returnReason: "",
      createdAt: now.iso,
      updatedAt: now.iso,
      approvedAt: null,
    };
    await updateTask(conn, dispatched);
    await insertProjectRun(conn, run);
    return { task: dispatched, run };
  });
  enqueue(result.run.id);
  return {
    runId: result.run.id,
    exportWarning: await exportTaskSafely(result.task),
  };
}

export async function loadProjectRun(runId: string): Promise<ProjectRunView> {
  await ensureProjectRunRuntime();
  const run = await getProjectRun(getPool(), runId);
  if (!run) throw new RuleError("找不到这次执行");
  const [events, storedFiles, projectRow] = await Promise.all([
    listProjectRunEvents(getPool(), runId),
    listProjectRunFiles(getPool(), runId),
    getProject(getPool(), run.projectId),
  ]);
  if (!projectRow) throw new RuleError("找不到这个项目");
  const staged = runWorkspace({
    companyId: projectRow.companyId,
    projectId: projectRow.id,
    runId,
  });
  const files = await Promise.all(
    storedFiles.map(async (file) => {
      try {
        return { ...file, diff: await staged.diff(file.path) };
      } catch (error) {
        if (["approved", "returned", "failed"].includes(run.status)) return { ...file, diff: "" };
        throw error;
      }
    }),
  );
  return { run, events, files };
}

export async function pollProjectRun(
  runId: string,
  afterEventId: number,
): Promise<{ run: ProjectRun; events: ProjectRunView["events"] }> {
  await ensureProjectRunRuntime();
  const run = await getProjectRun(getPool(), runId);
  if (!run) throw new RuleError("找不到这次执行");
  const events = await listProjectRunEvents(getPool(), runId, afterEventId);
  return { run, events };
}

export async function loadProjectRuns(projectId: string): Promise<ProjectRun[]> {
  await ensureProjectRunRuntime();
  if (!(await getProject(getPool(), projectId))) throw new RuleError("找不到这个项目");
  return listProjectRuns(getPool(), projectId);
}

export async function approveProjectRun(runId: string): Promise<{ paths: string[] }> {
  await ensureProjectRunRuntime();
  const applying = await withTransaction(async (conn) => {
    const current = await getProjectRun(conn, runId, true);
    if (!current) throw new RuleError("找不到这次执行");
    if (current.taskId) throw new RuleError("请在任务详情中批准这次执行");
    if (current.status !== "review") throw new RuleError("只有待批准的执行可以批准");
    const next = transitionProjectRun(current, "applying", shanghaiTime().iso);
    await updateProjectRun(conn, next);
    await appendProjectRunEvent(conn, {
      runId,
      kind: "message",
      body: { text: "正在检查冲突并应用文件。" },
      createdAt: next.updatedAt,
    });
    return next;
  });
  try {
    const projectRow = await getProject(getPool(), applying.projectId);
    if (!projectRow) throw new RuleError("找不到这个项目");
    const staged = runWorkspace({
      companyId: projectRow.companyId,
      projectId: projectRow.id,
      runId,
    });
    return await staged.apply(async () => {
      await withTransaction(async (conn) => {
        const current = await getProjectRun(conn, runId, true);
        if (!current) throw new RuleError("找不到这次执行");
        if (current.status !== "applying") throw new RuleError("执行状态已经变化，不能完成批准");
        const next = transitionProjectRun(current, "approved", shanghaiTime().iso);
        await updateProjectRun(conn, next);
        await appendProjectRunEvent(conn, {
          runId,
          kind: "message",
          body: { text: "文件已应用，执行已批准。" },
          createdAt: next.updatedAt,
        });
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "应用文件失败";
    const current = await getProjectRun(getPool(), runId);
    if (current?.status === "applying") {
      if (message.includes("恢复未完成")) {
        await moveRun(runId, "failed", { errorText: message }, { kind: "error", body: { message } });
        throw error;
      }
      await moveRun(
        runId,
        "review",
        { summary: current.summary },
        { kind: "error", body: { message } },
      );
    }
    throw new RuleError(message);
  }
}

export async function returnProjectRun(runId: string, reason: string): Promise<void> {
  const returnReason = reason.trim();
  if (!returnReason) throw new RuleError("先写退回原因");
  await ensureProjectRunRuntime();
  await withTransaction(async (conn) => {
    const current = await getProjectRun(conn, runId, true);
    if (!current) throw new RuleError("找不到这次执行");
    if (current.status !== "review") throw new RuleError("只有待批准的执行可以退回");
    const next = transitionProjectRun(current, "returned", shanghaiTime().iso, { returnReason });
    await updateProjectRun(conn, next);
    await appendProjectRunEvent(conn, {
      runId,
      kind: "message",
      body: { text: `你退回了这次执行：${returnReason}` },
      createdAt: next.updatedAt,
    });
  });
}

export async function approveTaskProjectRun(
  taskId: string,
  decision: string,
  record: boolean,
): Promise<{ handled: boolean; exportWarning: string | null }> {
  await ensureProjectRunRuntime();
  const active = await findActiveTaskRun(getPool(), taskId);
  if (!active) return { handled: false, exportWarning: null };
  if (active.status !== "review") throw new RuleError("员工执行尚未完成，不能批准任务");
  const applying = await withTransaction(async (conn) => {
    const task = await getTask(conn, taskId, true);
    const run = await getProjectRun(conn, active.id, true);
    if (!run || !task) throw new RuleError("找不到任务或执行");
    if (run.status !== "review" || task.status !== "review") {
      throw new RuleError("任务或执行状态已经变化");
    }
    const next = transitionProjectRun(run, "applying", shanghaiTime().iso);
    await updateProjectRun(conn, next);
    return next;
  });
  const projectRow = await getProject(getPool(), applying.projectId);
  if (!projectRow) throw new RuleError("找不到这个项目");
  const staged = runWorkspace({
    companyId: projectRow.companyId,
    projectId: projectRow.id,
    runId: applying.id,
  });
  let approvedTask: Task | null = null;
  try {
    await staged.apply(async () => {
      await withTransaction(async (conn) => {
        const task = await getTask(conn, taskId, true);
        const run = await getProjectRun(conn, applying.id, true);
        if (!run || !task) throw new RuleError("找不到任务或执行");
        if (run.status !== "applying" || task.status !== "review") {
          throw new RuleError("任务或执行状态已经变化");
        }
        const now = shanghaiTime();
        const nextRun = transitionProjectRun(run, "approved", now.iso);
        approvedTask = approveTask(task, decision, now.noteStamp, now.iso);
        await updateProjectRun(conn, nextRun);
        await updateTask(conn, approvedTask);
        if (record) {
          await insertDecision(
            conn,
            {
              day: now.day,
              title: approvedTask.decision ?? decision.trim(),
              decision: approvedTask.decision ?? decision.trim(),
              reason: `你批准了任务 ${taskId} 的员工执行。`,
              taskId,
            },
            now.iso,
          );
        }
        await appendProjectRunEvent(conn, {
          runId: run.id,
          kind: "message",
          body: { text: "文件已应用，关联任务已批准。" },
          createdAt: now.iso,
        });
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "应用文件失败";
    const current = await getProjectRun(getPool(), applying.id);
    if (current?.status === "applying") {
      if (message.includes("恢复未完成")) {
        await moveRun(applying.id, "failed", { errorText: message }, { kind: "error", body: { message } });
        throw error;
      }
      await moveRun(
        applying.id,
        "review",
        { summary: current.summary },
        { kind: "error", body: { message } },
      );
    }
    throw new RuleError(message);
  }
  const taskWarning = approvedTask ? await exportTaskSafely(approvedTask) : null;
  let decisionWarning: string | null = null;
  if (record) {
    try {
      await exportDecisions(await listDecisions(getPool()));
    } catch (error) {
      decisionWarning = `数据库已写入，决策文件副本尚未刷新。${
        error instanceof Error ? error.message : "导出失败"
      }`;
    }
  }
  return {
    handled: true,
    exportWarning: [taskWarning, decisionWarning].filter(Boolean).join(" ") || null,
  };
}

export async function returnTaskProjectRun(
  taskId: string,
  reason: string,
): Promise<{ handled: boolean; exportWarning: string | null }> {
  const returnReason = reason.trim();
  if (!returnReason) throw new RuleError("退回原因不能为空");
  await ensureProjectRunRuntime();
  const active = await findActiveTaskRun(getPool(), taskId);
  if (!active) return { handled: false, exportWarning: null };
  if (active.status !== "review") throw new RuleError("员工执行尚未完成，不能退回任务");
  const now = shanghaiTime();
  const task = await withTransaction(async (conn) => {
    const tasks = await listTasks(conn);
    const currentTask = await getTask(conn, taskId, true);
    const run = await getProjectRun(conn, active.id, true);
    if (!run || !currentTask) throw new RuleError("找不到任务或执行");
    if (run.status !== "review" || currentTask.status !== "review") {
      throw new RuleError("任务或执行状态已经变化");
    }
    const nextRun = transitionProjectRun(run, "returned", now.iso, { returnReason });
    const nextTask = returnTask(
      currentTask,
      returnReason,
      doingCount(tasks),
      now.noteStamp,
      now.iso,
    );
    await updateProjectRun(conn, nextRun);
    await updateTask(conn, nextTask);
    await appendProjectRunEvent(conn, {
      runId: run.id,
      kind: "message",
      body: { text: `你退回了任务执行：${returnReason}` },
      createdAt: now.iso,
    });
    return nextTask;
  });
  return { handled: true, exportWarning: await exportTaskSafely(task) };
}
