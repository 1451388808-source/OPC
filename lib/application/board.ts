import { pickInboxRole, type RoleDefinition } from "../domain/role";
import {
  approveTask,
  doingCount,
  inboxPriority,
  promoteTask,
  returnTask,
  RuleError,
  titleFromBrief,
  type Task,
} from "../domain/task";
import { shanghaiTime } from "../domain/time";
import { getPool, migrate, queryRows, withTransaction } from "../infrastructure/db";
import {
  exportDecisions,
  exportTaskFile,
  exportWeekFocus,
  readGoalFile,
  readRoles,
  readTasksFromFiles,
} from "../infrastructure/files";
import {
  allocateTaskId,
  blockOpenNowTasks,
  getGoal,
  getTask,
  insertDecision,
  insertGoal,
  insertTask,
  latestDecision,
  listDecisions,
  listTasks,
  setTaskCounter,
  updateTask,
  updateWeekFocus,
} from "../infrastructure/store";

export type BoardData = {
  weekFocus: string;
  weekLabel: string;
  latestDecision: string | null;
  tasks: Task[];
  roles: RoleDefinition[];
};

let ready: Promise<void> | null = null;

export function ensureReady(): Promise<void> {
  if (!ready) {
    ready = bootstrap().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

async function bootstrap(): Promise<void> {
  await migrate();
  const pool = getPool();
  const countRows = await queryRows<{ n: number } & import("mysql2/promise").RowDataPacket>(
    pool,
    "SELECT COUNT(*) AS n FROM tasks",
  );
  if (Number(countRows[0]?.n ?? 0) === 0) {
    const tasks = await readTasksFromFiles();
    if (tasks.length > 0) {
      await withTransaction(async (conn) => {
        for (const task of tasks) await insertTask(conn, task);
        const max = tasks.reduce((highest, task) => Math.max(highest, Number(task.id.slice(2))), 0);
        await setTaskCounter(conn, max);
      });
    }
  }
  const goal = await getGoal(pool);
  if (!goal) {
    const parsed = await readGoalFile();
    await insertGoal(pool, parsed, shanghaiTime().iso);
  }
}

async function exportChanged(tasks: Task[], decisionsToo: boolean): Promise<string | null> {
  try {
    for (const task of tasks) await exportTaskFile(task);
    if (decisionsToo) await exportDecisions(await listDecisions(getPool()));
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "导出失败";
    return `数据库已写入，文件副本尚未刷新。${message}`;
  }
}

export async function loadBoard(): Promise<BoardData> {
  await ensureReady();
  const pool = getPool();
  const [tasks, goal, decision, roles] = await Promise.all([
    listTasks(pool),
    getGoal(pool),
    latestDecision(pool),
    readRoles(),
  ]);
  const weekLabel =
    goal?.weekStart && goal.weekEnd ? `${goal.weekStart} 至 ${goal.weekEnd}` : "";
  return {
    weekFocus: goal?.weekFocus ?? "",
    weekLabel,
    latestDecision: decision,
    tasks,
    roles,
  };
}

export async function createInbox(brief: string): Promise<{ taskId: string; exportWarning: string | null }> {
  const text = brief.trim();
  if (!text) throw new RuleError("先写一句话");
  await ensureReady();
  const now = shanghaiTime();
  const task = await withTransaction(async (conn) => {
    const tasks = await listTasks(conn);
    const id = await allocateTaskId(conn);
    const role = pickInboxRole(await readRoles());
    if (!role) throw new RuleError("还没有角色。在 roles/ 里加一份手册。");
    const created: Task = {
      id,
      title: titleFromBrief(text),
      brief: text,
      goal: `待${role.name}收成可检查的验收。`,
      acceptance: [`${role.name}补上可检查的验收`],
      role: role.id,
      status: "inbox",
      priority: inboxPriority(doingCount(tasks)),
      artifacts: [],
      notes: "",
      needsApproval: true,
      blockReason: "",
      decision: null,
      createdAt: now.iso,
      updatedAt: now.iso,
    };
    await insertTask(conn, created);
    return created;
  });
  return { taskId: task.id, exportWarning: await exportChanged([task], false) };
}

export async function approve(
  id: string,
  decision: string,
  record: boolean,
): Promise<{ exportWarning: string | null }> {
  await ensureReady();
  const now = shanghaiTime();
  const task = await withTransaction(async (conn) => {
    const current = await getTask(conn, id, true);
    if (!current) throw new RuleError("找不到这条任务");
    const next = approveTask(current, decision, now.noteStamp, now.iso);
    await updateTask(conn, next);
    if (record) {
      await insertDecision(
        conn,
        {
          day: now.day,
          title: next.decision ?? decision.trim(),
          decision: next.decision ?? decision.trim(),
          reason: `你在看板上批准 ${id}。`,
          taskId: id,
        },
        now.iso,
      );
    }
    return next;
  });
  return { exportWarning: await exportChanged([task], record) };
}

export async function returnToDoing(
  id: string,
  reason: string,
): Promise<{ exportWarning: string | null }> {
  await ensureReady();
  const now = shanghaiTime();
  const task = await withTransaction(async (conn) => {
    const tasks = await listTasks(conn);
    const current = tasks.find((item) => item.id === id);
    if (!current) throw new RuleError("找不到这条任务");
    const locked = await getTask(conn, id, true);
    if (!locked) throw new RuleError("找不到这条任务");
    const next = returnTask(locked, reason, doingCount(tasks), now.noteStamp, now.iso);
    await updateTask(conn, next);
    return next;
  });
  return { exportWarning: await exportChanged([task], false) };
}

export async function promote(id: string): Promise<{ exportWarning: string | null }> {
  await ensureReady();
  const now = shanghaiTime();
  const task = await withTransaction(async (conn) => {
    const tasks = await listTasks(conn);
    const locked = await getTask(conn, id, true);
    if (!locked) throw new RuleError("找不到这条任务");
    const next = promoteTask(locked, doingCount(tasks), now.iso);
    await updateTask(conn, next);
    return next;
  });
  return { exportWarning: await exportChanged([task], false) };
}

export async function saveWeekFocus(
  weekFocus: string,
): Promise<{ exportWarning: string | null }> {
  await ensureReady();
  const now = shanghaiTime();
  const changed = await withTransaction(async (conn) => {
    await updateWeekFocus(conn, weekFocus.trim(), now.iso);
    const ids = await blockOpenNowTasks(conn, now.iso);
    const tasks = await listTasks(conn);
    return tasks.filter((task) => ids.includes(task.id));
  });
  try {
    await exportWeekFocus(weekFocus.trim());
    const warning = await exportChanged(changed, false);
    return { exportWarning: warning };
  } catch (error) {
    const message = error instanceof Error ? error.message : "导出失败";
    return { exportWarning: `数据库已写入，文件副本尚未刷新。${message}` };
  }
}
