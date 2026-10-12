import type { RowDataPacket } from "mysql2/promise";
import { toIso, toSql } from "../domain/time";
import type { Sql } from "./db";
import { queryRows } from "./db";

export type CompanyRow = {
  id: string;
  name: string;
  createdAt: string;
};

export type ProjectRow = {
  id: string;
  companyId: string;
  name: string;
  createdAt: string;
};

export type ProjectMessageRow = {
  id: number;
  speaker: "boss" | "employee";
  roleId: string;
  body: string;
  createdAt: string;
};

export async function allocateSerial(sql: Sql, counter: "company" | "project"): Promise<number> {
  const rows = await queryRows<RowDataPacket & { value: number }>(
    sql,
    "SELECT value FROM counters WHERE name = ? FOR UPDATE",
    [counter],
  );
  const next = Number(rows[0]?.value ?? 0) + 1;
  if (rows[0]) {
    await sql.query("UPDATE counters SET value = ? WHERE name = ?", [next, counter]);
  } else {
    await sql.query("INSERT INTO counters (name, value) VALUES (?, ?)", [counter, next]);
  }
  return next;
}

export function serialId(prefix: "c" | "p", value: number): string {
  return `${prefix}-${String(value).padStart(3, "0")}`;
}

export async function listCompanies(sql: Sql): Promise<CompanyRow[]> {
  const rows = await queryRows<RowDataPacket & { id: string; name: string; created_at: string }>(
    sql,
    "SELECT id, name, created_at FROM companies ORDER BY id",
  );
  return rows.map((row) => ({ id: row.id, name: row.name, createdAt: toIso(String(row.created_at)) }));
}

export async function getCompany(sql: Sql, id: string): Promise<CompanyRow | null> {
  const rows = await queryRows<RowDataPacket & { id: string; name: string; created_at: string }>(
    sql,
    "SELECT id, name, created_at FROM companies WHERE id = ?",
    [id],
  );
  const row = rows[0];
  return row ? { id: row.id, name: row.name, createdAt: toIso(String(row.created_at)) } : null;
}

export async function insertCompany(sql: Sql, row: CompanyRow): Promise<void> {
  await sql.query("INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)", [
    row.id,
    row.name,
    toSql(row.createdAt),
  ]);
}

export async function listProjects(sql: Sql): Promise<ProjectRow[]> {
  const rows = await queryRows<RowDataPacket & { id: string; company_id: string; name: string; created_at: string }>(
    sql,
    "SELECT id, company_id, name, created_at FROM projects ORDER BY id",
  );
  return rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    createdAt: toIso(String(row.created_at)),
  }));
}

export async function getProject(sql: Sql, id: string): Promise<ProjectRow | null> {
  const rows = await queryRows<RowDataPacket & { id: string; company_id: string; name: string; created_at: string }>(
    sql,
    "SELECT id, company_id, name, created_at FROM projects WHERE id = ?",
    [id],
  );
  const row = rows[0];
  return row
    ? { id: row.id, companyId: row.company_id, name: row.name, createdAt: toIso(String(row.created_at)) }
    : null;
}

export async function insertProject(sql: Sql, row: ProjectRow): Promise<void> {
  await sql.query("INSERT INTO projects (id, name, company_id, created_at) VALUES (?, ?, ?, ?)", [
    row.id,
    row.name,
    row.companyId,
    toSql(row.createdAt),
  ]);
}

export async function listMemberIds(sql: Sql, projectId: string): Promise<string[]> {
  const rows = await queryRows<RowDataPacket & { role_id: string }>(
    sql,
    "SELECT role_id FROM project_members WHERE project_id = ? ORDER BY created_at, role_id",
    [projectId],
  );
  return rows.map((row) => row.role_id);
}

export async function insertMember(sql: Sql, projectId: string, roleId: string, createdAt: string): Promise<void> {
  await sql.query("INSERT INTO project_members (project_id, role_id, created_at) VALUES (?, ?, ?)", [
    projectId,
    roleId,
    toSql(createdAt),
  ]);
}

export async function deleteMember(sql: Sql, projectId: string, roleId: string): Promise<void> {
  await sql.query("DELETE FROM project_members WHERE project_id = ? AND role_id = ?", [projectId, roleId]);
  await sql.query("DELETE FROM project_thinking WHERE project_id = ? AND role_id = ?", [projectId, roleId]);
}

export async function listStaff(
  sql: Sql,
): Promise<{ projectId: string; roleId: string; thinking: string }[]> {
  const rows = await queryRows<RowDataPacket & { project_id: string; role_id: string; thinking: string | null }>(
    sql,
    `SELECT m.project_id, m.role_id, t.body AS thinking
     FROM project_members m
     LEFT JOIN project_thinking t ON t.project_id = m.project_id AND t.role_id = m.role_id
     ORDER BY m.created_at, m.role_id`,
  );
  return rows.map((row) => ({ projectId: row.project_id, roleId: row.role_id, thinking: row.thinking ?? "" }));
}

export async function saveProjectThinking(
  sql: Sql,
  projectId: string,
  roleId: string,
  body: string,
  updatedAt: string,
): Promise<void> {
  await sql.query(
    `INSERT INTO project_thinking (project_id, role_id, body, updated_at)
     VALUES (?, ?, ?, ?) AS incoming
     ON DUPLICATE KEY UPDATE body = incoming.body, updated_at = incoming.updated_at`,
    [projectId, roleId, body, toSql(updatedAt)],
  );
}

export async function listProjectMessages(sql: Sql, projectId: string): Promise<ProjectMessageRow[]> {
  const rows = await queryRows<
    RowDataPacket & { id: number; speaker: "boss" | "employee"; role_id: string | null; body: string; created_at: string }
  >(sql, "SELECT id, speaker, role_id, body, created_at FROM project_messages WHERE project_id = ? ORDER BY id", [
    projectId,
  ]);
  return rows.map((row) => ({
    id: Number(row.id),
    speaker: row.speaker,
    roleId: row.role_id ?? "",
    body: row.body,
    createdAt: toIso(String(row.created_at)),
  }));
}

export async function insertProjectMessage(
  sql: Sql,
  projectId: string,
  speaker: "boss" | "employee",
  roleId: string,
  body: string,
  createdAt: string,
): Promise<void> {
  await sql.query(
    "INSERT INTO project_messages (project_id, speaker, role_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
    [projectId, speaker, roleId || null, body, toSql(createdAt)],
  );
}
