import type { RowDataPacket } from "mysql2/promise";
import {
  type ProjectRun,
  type ProjectRunEvent,
  type ProjectRunEventKind,
  type ProjectRunFile,
  type ProjectRunStatus,
} from "../domain/project-run";
import { toIso, toSql } from "../domain/time";
import type { Sql } from "./db";
import { queryRows } from "./db";

type ProjectRunRow = RowDataPacket & {
  id: string;
  project_id: string;
  task_id: string | null;
  role_id: string;
  request_text: string;
  status: ProjectRunStatus;
  summary: string;
  error_text: string;
  return_reason: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
};

function mapRun(row: ProjectRunRow): ProjectRun {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    roleId: row.role_id,
    requestText: row.request_text,
    status: row.status,
    summary: row.summary,
    errorText: row.error_text,
    returnReason: row.return_reason,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    approvedAt: row.approved_at ? toIso(row.approved_at) : null,
  };
}

export async function insertProjectRun(sql: Sql, run: ProjectRun): Promise<void> {
  await sql.query(
    `INSERT INTO project_runs
      (id, project_id, task_id, role_id, request_text, status, summary, error_text, return_reason,
       created_at, updated_at, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id,
      run.projectId,
      run.taskId,
      run.roleId,
      run.requestText,
      run.status,
      run.summary,
      run.errorText,
      run.returnReason,
      toSql(run.createdAt),
      toSql(run.updatedAt),
      run.approvedAt ? toSql(run.approvedAt) : null,
    ],
  );
}

export async function getProjectRun(sql: Sql, id: string, lock = false): Promise<ProjectRun | null> {
  const rows = await queryRows<ProjectRunRow>(
    sql,
    `SELECT * FROM project_runs WHERE id = ?${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function listProjectRuns(sql: Sql, projectId: string): Promise<ProjectRun[]> {
  const rows = await queryRows<ProjectRunRow>(
    sql,
    "SELECT * FROM project_runs WHERE project_id = ? ORDER BY created_at DESC, id DESC",
    [projectId],
  );
  return rows.map(mapRun);
}

export async function updateProjectRun(sql: Sql, run: ProjectRun): Promise<void> {
  await sql.query(
    `UPDATE project_runs SET
      status = ?, summary = ?, error_text = ?, return_reason = ?, updated_at = ?, approved_at = ?
     WHERE id = ?`,
    [
      run.status,
      run.summary,
      run.errorText,
      run.returnReason,
      toSql(run.updatedAt),
      run.approvedAt ? toSql(run.approvedAt) : null,
      run.id,
    ],
  );
}

export async function findActiveTaskRun(sql: Sql, taskId: string): Promise<ProjectRun | null> {
  const rows = await queryRows<ProjectRunRow>(
    sql,
    `SELECT * FROM project_runs
     WHERE task_id = ? AND status IN ('queued', 'running', 'review', 'applying')
     ORDER BY created_at DESC LIMIT 1`,
    [taskId],
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function listQueuedProjectRunIds(sql: Sql): Promise<string[]> {
  const rows = await queryRows<RowDataPacket & { id: string }>(
    sql,
    "SELECT id FROM project_runs WHERE status = 'queued' ORDER BY created_at, id",
  );
  return rows.map((row) => row.id);
}

export async function failInterruptedProjectRuns(sql: Sql, updatedAt: string, message: string): Promise<number> {
  const [result] = await sql.query(
    `UPDATE project_runs
     SET status = 'failed', error_text = ?, updated_at = ?
     WHERE status = 'running'`,
    [message, toSql(updatedAt)],
  );
  return Number((result as { affectedRows?: number }).affectedRows ?? 0);
}

export async function appendProjectRunEvent(
  sql: Sql,
  event: Omit<ProjectRunEvent, "id">,
): Promise<number> {
  const [result] = await sql.query(
    "INSERT INTO project_run_events (run_id, kind, body, created_at) VALUES (?, ?, ?, ?)",
    [event.runId, event.kind, JSON.stringify(event.body), toSql(event.createdAt)],
  );
  return Number((result as { insertId?: number }).insertId ?? 0);
}

export async function listProjectRunEvents(sql: Sql, runId: string, afterId = 0): Promise<ProjectRunEvent[]> {
  const rows = await queryRows<
    RowDataPacket & { id: number; run_id: string; kind: ProjectRunEventKind; body: unknown; created_at: string }
  >(
    sql,
    `SELECT id, run_id, kind, body, created_at
     FROM project_run_events WHERE run_id = ? AND id > ? ORDER BY id`,
    [runId, afterId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    runId: row.run_id,
    kind: row.kind,
    body: typeof row.body === "string" ? JSON.parse(row.body) : row.body,
    createdAt: toIso(row.created_at),
  }));
}

export async function upsertProjectRunFile(sql: Sql, file: ProjectRunFile): Promise<void> {
  await sql.query(
    `INSERT INTO project_run_files
      (run_id, path, operation, before_sha256, after_sha256, before_size, after_size)
     VALUES (?, ?, ?, ?, ?, ?, ?) AS incoming
     ON DUPLICATE KEY UPDATE
      operation = incoming.operation,
      before_sha256 = incoming.before_sha256,
      after_sha256 = incoming.after_sha256,
      before_size = incoming.before_size,
      after_size = incoming.after_size`,
    [
      file.runId,
      file.path,
      file.operation,
      file.beforeSha256,
      file.afterSha256,
      file.beforeSize,
      file.afterSize,
    ],
  );
}

export async function listProjectRunFiles(sql: Sql, runId: string): Promise<ProjectRunFile[]> {
  const rows = await queryRows<
    RowDataPacket & {
      run_id: string;
      path: string;
      operation: "create" | "update";
      before_sha256: string | null;
      after_sha256: string;
      before_size: number;
      after_size: number;
    }
  >(
    sql,
    `SELECT run_id, path, operation, before_sha256, after_sha256, before_size, after_size
     FROM project_run_files WHERE run_id = ? ORDER BY path`,
    [runId],
  );
  return rows.map((row) => ({
    runId: row.run_id,
    path: row.path,
    operation: row.operation,
    beforeSha256: row.before_sha256,
    afterSha256: row.after_sha256,
    beforeSize: Number(row.before_size),
    afterSize: Number(row.after_size),
  }));
}
