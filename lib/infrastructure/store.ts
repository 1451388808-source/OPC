import type { RowDataPacket } from "mysql2/promise";
import { BLOCK_REASON, nextTaskId, type Task } from "../domain/task";
import { toIso, toSql } from "../domain/time";
import type { Sql } from "./db";
import { queryRows } from "./db";

type TaskRow = RowDataPacket & {
  id: string;
  title: string;
  brief: string;
  goal: string;
  acceptance: string[] | string;
  role: Task["role"];
  status: Task["status"];
  priority: Task["priority"];
  artifacts: string[] | string;
  notes: string;
  needs_approval: number;
  block_reason: string;
  decision: string | null;
  created_at: string;
  updated_at: string;
};

function jsonList(value: string[] | string): string[] {
  let current: unknown = value;
  if (typeof current === "string") current = JSON.parse(current);
  if (typeof current === "string") current = JSON.parse(current);
  return current as string[];
}

export function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    brief: row.brief,
    goal: row.goal,
    acceptance: jsonList(row.acceptance),
    role: row.role,
    status: row.status,
    priority: row.priority,
    artifacts: jsonList(row.artifacts),
    notes: row.notes,
    needsApproval: Boolean(row.needs_approval),
    blockReason: row.block_reason,
    decision: row.decision,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function listTasks(sql: Sql): Promise<Task[]> {
  const rows = await queryRows<TaskRow>(sql, "SELECT * FROM tasks ORDER BY id");
  return rows.map(mapTask);
}

export async function getTask(sql: Sql, id: string, lock = false): Promise<Task | null> {
  const rows = await queryRows<TaskRow>(
    sql,
    `SELECT * FROM tasks WHERE id = ?${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] ? mapTask(rows[0]) : null;
}

export async function insertTask(sql: Sql, task: Task): Promise<void> {
  await sql.query(
    `INSERT INTO tasks
      (id, title, brief, goal, acceptance, role, status, priority, artifacts, notes, needs_approval, block_reason, decision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      task.title,
      task.brief,
      task.goal,
      JSON.stringify(task.acceptance),
      task.role,
      task.status,
      task.priority,
      JSON.stringify(task.artifacts),
      task.notes,
      task.needsApproval ? 1 : 0,
      task.blockReason,
      task.decision,
      toSql(task.createdAt),
      toSql(task.updatedAt),
    ],
  );
}

export async function updateTask(sql: Sql, task: Task): Promise<void> {
  await sql.query(
    `UPDATE tasks SET
      title = ?, brief = ?, goal = ?, acceptance = ?, role = ?, status = ?, priority = ?,
      artifacts = ?, notes = ?, needs_approval = ?, block_reason = ?, decision = ?, updated_at = ?
     WHERE id = ?`,
    [
      task.title,
      task.brief,
      task.goal,
      JSON.stringify(task.acceptance),
      task.role,
      task.status,
      task.priority,
      JSON.stringify(task.artifacts),
      task.notes,
      task.needsApproval ? 1 : 0,
      task.blockReason,
      task.decision,
      toSql(task.updatedAt),
      task.id,
    ],
  );
}

export async function allocateTaskId(sql: Sql): Promise<string> {
  const rows = await queryRows<RowDataPacket & { value: number }>(
    sql,
    "SELECT value FROM counters WHERE name = 'task' FOR UPDATE",
  );
  const current = rows[0]?.value ?? 0;
  const id = nextTaskId([`t-${String(current).padStart(3, "0")}`]);
  const next = Number(id.slice(2));
  if (rows[0]) {
    await sql.query("UPDATE counters SET value = ? WHERE name = 'task'", [next]);
  } else {
    await sql.query("INSERT INTO counters (name, value) VALUES ('task', ?)", [next]);
  }
  return id;
}

export async function setTaskCounter(sql: Sql, value: number): Promise<void> {
  await sql.query(
    `INSERT INTO counters (name, value) VALUES ('task', ?) AS incoming
     ON DUPLICATE KEY UPDATE value = GREATEST(counters.value, incoming.value)`,
    [value],
  );
}

export async function blockOpenNowTasks(sql: Sql, updatedAt: string): Promise<string[]> {
  const rows = await queryRows<RowDataPacket & { id: string }>(
    sql,
    "SELECT id FROM tasks WHERE priority = 'now' AND status <> 'done' FOR UPDATE",
  );
  if (rows.length === 0) return [];
  await sql.query(
    `UPDATE tasks SET status = 'blocked', block_reason = ?, updated_at = ?
     WHERE priority = 'now' AND status <> 'done'`,
    [BLOCK_REASON, toSql(updatedAt)],
  );
  return rows.map((row) => row.id);
}

export type GoalRow = {
  quarterText: string;
  weekFocus: string;
  weekStart: string | null;
  weekEnd: string | null;
  outOfScope: string;
};

export async function getGoal(sql: Sql): Promise<GoalRow | null> {
  const rows = await queryRows<RowDataPacket & GoalRow>(
    sql,
    `SELECT quarter_text AS quarterText, week_focus AS weekFocus, week_start AS weekStart,
            week_end AS weekEnd, out_of_scope AS outOfScope
     FROM goals WHERE id = 1`,
  );
  return rows[0] ?? null;
}

export async function insertGoal(sql: Sql, goal: GoalRow, updatedAt: string): Promise<void> {
  await sql.query(
    `INSERT INTO goals (id, quarter_text, week_focus, week_start, week_end, out_of_scope, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)`,
    [goal.quarterText, goal.weekFocus, goal.weekStart, goal.weekEnd, goal.outOfScope, toSql(updatedAt)],
  );
}

export async function updateWeekFocus(sql: Sql, weekFocus: string, updatedAt: string): Promise<void> {
  await sql.query("UPDATE goals SET week_focus = ?, updated_at = ? WHERE id = 1", [
    weekFocus,
    toSql(updatedAt),
  ]);
}

export type DecisionRow = {
  day: string;
  title: string;
  decision: string;
  reason: string;
  taskId: string;
};

export async function listDecisions(sql: Sql): Promise<DecisionRow[]> {
  const rows = await queryRows<
    RowDataPacket & { decided_on: string; title: string; decision: string; reason: string; task_id: string }
  >(sql, "SELECT decided_on, title, decision, reason, task_id FROM decisions ORDER BY id");
  return rows.map((row) => ({
    day: String(row.decided_on).slice(0, 10),
    title: row.title,
    decision: row.decision,
    reason: row.reason,
    taskId: row.task_id,
  }));
}

export async function latestDecision(sql: Sql): Promise<string | null> {
  const rows = await queryRows<RowDataPacket & { decision: string }>(
    sql,
    "SELECT decision FROM decisions ORDER BY id DESC LIMIT 1",
  );
  return rows[0]?.decision ?? null;
}

export async function insertDecision(
  sql: Sql,
  row: DecisionRow,
  createdAt: string,
): Promise<void> {
  await sql.query(
    `INSERT INTO decisions (decided_on, title, decision, reason, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.day, row.title.slice(0, 200), row.decision, row.reason, row.taskId, toSql(createdAt)],
  );
}

export type ChatMessage = {
  id: number;
  speaker: "boss" | "employee";
  body: string;
  createdAt: string;
};

export async function listMessages(sql: Sql, roleId: string): Promise<ChatMessage[]> {
  const rows = await queryRows<RowDataPacket & { id: number; speaker: "boss" | "employee"; body: string; created_at: string }>(
    sql,
    "SELECT id, speaker, body, created_at FROM messages WHERE role_id = ? ORDER BY id",
    [roleId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    speaker: row.speaker,
    body: row.body,
    createdAt: String(row.created_at),
  }));
}

export async function insertMessage(
  sql: Sql,
  roleId: string,
  speaker: "boss" | "employee",
  body: string,
  createdAt: string,
): Promise<void> {
  await sql.query(
    "INSERT INTO messages (role_id, speaker, body, created_at) VALUES (?, ?, ?, ?)",
    [roleId, speaker, body, toSql(createdAt)],
  );
}

export async function deleteMessages(sql: Sql, roleId: string): Promise<void> {
  await sql.query("DELETE FROM messages WHERE role_id = ?", [roleId]);
}

export async function countTasksForRole(sql: Sql, roleId: string): Promise<number> {
  const rows = await queryRows<RowDataPacket & { n: number }>(
    sql,
    "SELECT COUNT(*) AS n FROM tasks WHERE role = ?",
    [roleId],
  );
  return Number(rows[0]?.n ?? 0);
}
