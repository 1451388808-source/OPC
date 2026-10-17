import { RuleError } from "../domain/task";
import { shanghaiTime } from "../domain/time";
import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "../infrastructure/db";
import {
  appendProjectEvent,
  backfillLegacyProjectEvents,
  listProjectEvents,
  listRecentProjectEvents,
} from "../infrastructure/collaboration-store";
import { getProject } from "../infrastructure/org-store";
import type {
  ProjectEvent,
  ProjectEventActorType,
  ProjectEventKind,
} from "../domain/collaboration";
import { normalizeProjectTimeline } from "../domain/project-timeline";
import { ensureReady } from "./board";

async function requireProject(projectId: string): Promise<void> {
  if (!/^p-\d{3}$/.test(projectId)) throw new RuleError("找不到这个项目");
  const project = await getProject(getPool(), projectId);
  if (!project) throw new RuleError("找不到这个项目");
}

export async function ensureProjectEventHistory(projectId: string): Promise<number> {
  await ensureReady();
  await requireProject(projectId);
  const connection = await getPool().getConnection();
  const lockName = `opc:project-events:${projectId}`;
  let locked = false;
  try {
    const [rows] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK(?, 10) AS acquired", [lockName]);
    locked = Number(rows[0]?.acquired ?? 0) === 1;
    if (!locked) throw new RuleError("项目事件历史正在迁移，请稍后重试");
    await connection.beginTransaction();
    try {
      const count = await backfillLegacyProjectEvents(connection, projectId);
      await connection.commit();
      return count;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
    connection.release();
  }
}

export async function loadProjectTimeline(
  projectId: string,
  afterId = 0,
  limit = 200,
): Promise<ProjectEvent[]> {
  if (!Number.isInteger(afterId) || afterId < 0) throw new RuleError("事件游标无效");
  if (afterId === 0) await ensureProjectEventHistory(projectId);
  if (afterId > 0) return listProjectEvents(getPool(), projectId, afterId, limit);
  return normalizeProjectTimeline(await listRecentProjectEvents(getPool(), projectId, limit, false));
}

export async function pollProjectTimeline(
  projectId: string,
  afterId: number,
  limit = 200,
): Promise<ProjectEvent[]> {
  if (!/^p-\d{3}$/.test(projectId)) throw new RuleError("找不到这个项目");
  if (!Number.isInteger(afterId) || afterId < 0) throw new RuleError("事件游标无效");
  return listProjectEvents(getPool(), projectId, afterId, limit);
}

export async function recordProjectEvent(input: {
  projectId: string;
  workflowId?: string | null;
  workItemId?: string | null;
  actorType: ProjectEventActorType;
  actorId?: string | null;
  kind: ProjectEventKind;
  body: unknown;
}): Promise<number> {
  await ensureProjectEventHistory(input.projectId);
  return appendProjectEvent(getPool(), {
    projectId: input.projectId,
    workflowId: input.workflowId ?? null,
    workItemId: input.workItemId ?? null,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    kind: input.kind,
    body: input.body,
    createdAt: shanghaiTime().iso,
  });
}

