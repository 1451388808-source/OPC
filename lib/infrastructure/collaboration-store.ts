import type { RowDataPacket } from "mysql2/promise";
import {
  projectEventSchema,
  projectDecisionRequestSchema,
  projectWorkflowSchema,
  projectWorkItemSchema,
  workflowArtifactSchema,
  type ProjectEvent,
  type ProjectEventActorType,
  type ProjectEventKind,
  type ProjectDecisionRequest,
  type ProjectWorkflow,
  type ProjectWorkItem,
  type WorkflowArtifact,
  type WorkflowStatus,
  type WorkItemDependency,
  type WorkItemStatus,
} from "../domain/collaboration";
import { shanghaiTime, toIso, toSql } from "../domain/time";
import { queryRows, type Sql } from "./db";

type ProjectEventRow = RowDataPacket & {
  id: number;
  project_id: string;
  workflow_id: string | null;
  work_item_id: string | null;
  actor_type: ProjectEventActorType;
  actor_id: string | null;
  kind: ProjectEventKind;
  body: unknown;
  created_at: string;
};

type LegacyProjectMessageRow = RowDataPacket & {
  id: number;
  speaker: "boss" | "employee";
  role_id: string | null;
  body: string;
  created_at: string;
};

type LegacyProjectRunRow = RowDataPacket & {
  id: string;
  role_id: string;
  request_text: string;
  status: string;
  summary: string;
  error_text: string;
  return_reason: string;
  created_at: string;
};

type LegacyProjectRunEventRow = RowDataPacket & {
  id: number;
  run_id: string;
  role_id: string;
  kind: "reasoning" | "tool_call" | "tool_result" | "message" | "error";
  body: unknown;
  created_at: string;
};

type LegacyEventCandidate = {
  sourceType: "project_message" | "project_run" | "project_run_event";
  sourceId: string;
  event: Omit<ProjectEvent, "id">;
};

type ProjectEventBackfillStateRow = RowDataPacket & {
  project_id: string;
  last_message_id: number;
  last_run_event_id: number;
  last_run_created_at: string;
  last_run_id: string;
  updated_at: string;
};

type ProjectEventBackfillState = {
  projectId: string;
  lastMessageId: number;
  lastRunEventId: number;
  lastRunCreatedAt: string;
  lastRunId: string;
};

type ProjectWorkflowRow = RowDataPacket & {
  id: string;
  project_id: string;
  task_id: string | null;
  source_event_id: number | null;
  title: string;
  request_text: string;
  coordinator_role_id: string;
  status: WorkflowStatus;
  summary: string;
  error_text: string;
  return_reason: string;
  cancel_reason: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
};

type ProjectWorkItemRow = RowDataPacket & {
  id: string;
  workflow_id: string;
  position: number;
  title: string;
  objective: string;
  acceptance: unknown;
  owner_role_id: string;
  reviewer_role_id: string | null;
  status: WorkItemStatus;
  blocked_reason: string;
  summary: string;
  evidence: unknown;
  error_text: string;
  retry_count: number;
  created_at: string;
  updated_at: string;
};

type ProjectDecisionRequestRow = RowDataPacket & {
  id: string;
  workflow_id: string;
  work_item_id: string | null;
  asked_by_role_id: string;
  question: string;
  options: unknown;
  recommendation: string;
  reason: string;
  blocking_work_item_ids: unknown;
  status: "open" | "resolved" | "cancelled";
  answer: string;
  created_at: string;
  resolved_at: string | null;
};

type WorkflowArtifactRow = RowDataPacket & {
  id: string;
  workflow_id: string;
  work_item_id: string | null;
  created_by_role_id: string;
  kind: string;
  relative_ref: string;
  sha256: string | null;
  size_bytes: number | null;
  metadata: unknown;
  created_at: string;
};

function mapProjectEvent(row: ProjectEventRow): ProjectEvent {
  return projectEventSchema.parse({
    id: Number(row.id),
    projectId: row.project_id,
    workflowId: row.workflow_id,
    workItemId: row.work_item_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    kind: row.kind,
    body: typeof row.body === "string" ? JSON.parse(row.body) : row.body,
    createdAt: toIso(row.created_at),
  });
}

function parsedJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function mapProjectWorkflow(row: ProjectWorkflowRow): ProjectWorkflow {
  return projectWorkflowSchema.parse({
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    sourceEventId: row.source_event_id === null ? null : Number(row.source_event_id),
    title: row.title,
    requestText: row.request_text,
    coordinatorRoleId: row.coordinator_role_id,
    status: row.status,
    summary: row.summary,
    errorText: row.error_text,
    returnReason: row.return_reason,
    cancelReason: row.cancel_reason,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    approvedAt: row.approved_at ? toIso(row.approved_at) : null,
  });
}

function mapProjectWorkItem(row: ProjectWorkItemRow): ProjectWorkItem {
  return projectWorkItemSchema.parse({
    id: row.id,
    workflowId: row.workflow_id,
    position: Number(row.position),
    title: row.title,
    objective: row.objective,
    acceptance: parsedJson<string[]>(row.acceptance),
    ownerRoleId: row.owner_role_id,
    reviewerRoleId: row.reviewer_role_id,
    status: row.status,
    blockedReason: row.blocked_reason,
    summary: row.summary,
    evidence: parsedJson<string[]>(row.evidence),
    errorText: row.error_text,
    retryCount: Number(row.retry_count),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

function mapProjectDecisionRequest(row: ProjectDecisionRequestRow): ProjectDecisionRequest {
  return projectDecisionRequestSchema.parse({
    id: row.id,
    workflowId: row.workflow_id,
    workItemId: row.work_item_id,
    askedByRoleId: row.asked_by_role_id,
    question: row.question,
    options: parsedJson(row.options),
    recommendation: row.recommendation,
    reason: row.reason,
    blockingWorkItemIds: parsedJson(row.blocking_work_item_ids),
    status: row.status,
    answer: row.answer,
    createdAt: toIso(row.created_at),
    resolvedAt: row.resolved_at ? toIso(row.resolved_at) : null,
  });
}

function mapWorkflowArtifact(row: WorkflowArtifactRow): WorkflowArtifact {
  return workflowArtifactSchema.parse({
    id: row.id,
    workflowId: row.workflow_id,
    workItemId: row.work_item_id,
    createdByRoleId: row.created_by_role_id,
    kind: row.kind,
    relativeRef: row.relative_ref,
    sha256: row.sha256,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    metadata: parsedJson(row.metadata),
    createdAt: toIso(row.created_at),
  });
}

function checkedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("项目事件单次读取数量必须在 1 到 500 之间");
  }
  return limit;
}

export async function appendProjectEvent(
  sql: Sql,
  event: Omit<ProjectEvent, "id">,
): Promise<number> {
  const checked = projectEventSchema.parse({ ...event, id: 0 });
  const [result] = await sql.query(
    `INSERT INTO project_events
      (project_id, workflow_id, work_item_id, actor_type, actor_id, kind, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      checked.projectId,
      checked.workflowId,
      checked.workItemId,
      checked.actorType,
      checked.actorId,
      checked.kind,
      JSON.stringify(checked.body),
      toSql(checked.createdAt),
    ],
  );
  return Number((result as { insertId?: number }).insertId ?? 0);
}

export async function listProjectEvents(
  sql: Sql,
  projectId: string,
  afterId = 0,
  limit = 200,
): Promise<ProjectEvent[]> {
  const rows = await queryRows<ProjectEventRow>(
    sql,
    `SELECT id, project_id, workflow_id, work_item_id, actor_type, actor_id, kind, body, created_at
     FROM project_events
     WHERE project_id = ? AND id > ?
     ORDER BY id
     LIMIT ?`,
    [projectId, afterId, checkedLimit(limit)],
  );
  return rows.map(mapProjectEvent);
}

export async function listRecentProjectEvents(
  sql: Sql,
  projectId: string,
  limit = 200,
  includeHidden = true,
): Promise<ProjectEvent[]> {
  const rows = await queryRows<ProjectEventRow>(
    sql,
    `SELECT id, project_id, workflow_id, work_item_id, actor_type, actor_id, kind, body, created_at
     FROM project_events
     WHERE project_id = ?
       ${includeHidden ? "" : "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(body, '$.hidden')), 'false') <> 'true'"}
     ORDER BY id DESC
     LIMIT ?`,
    [projectId, checkedLimit(limit)],
  );
  return rows.reverse().map(mapProjectEvent);
}

export async function listWorkflowEvents(
  sql: Sql,
  workflowId: string,
  afterId = 0,
  limit = 200,
): Promise<ProjectEvent[]> {
  const rows = await queryRows<ProjectEventRow>(
    sql,
    `SELECT id, project_id, workflow_id, work_item_id, actor_type, actor_id, kind, body, created_at
     FROM project_events
     WHERE workflow_id = ? AND id > ?
     ORDER BY id
     LIMIT ?`,
    [workflowId, afterId, checkedLimit(limit)],
  );
  return rows.map(mapProjectEvent);
}

export async function linkProjectEventSource(
  sql: Sql,
  sourceType: LegacyEventCandidate["sourceType"],
  sourceId: string,
  projectEventId: number,
): Promise<void> {
  await sql.query(
    `INSERT INTO project_event_sources (source_type, source_id, project_event_id)
     VALUES (?, ?, ?)`,
    [sourceType, sourceId, projectEventId],
  );
}

export async function advanceProjectMessageBackfillState(
  sql: Sql,
  projectId: string,
  messageId: number,
  updatedAt: string,
): Promise<void> {
  await sql.query(
    `UPDATE project_event_backfill_state
     SET last_message_id = GREATEST(last_message_id, ?), updated_at = ?
     WHERE project_id = ?`,
    [messageId, toSql(updatedAt), projectId],
  );
}

function legacyRunEventKind(kind: LegacyProjectRunEventRow["kind"]): ProjectEventKind {
  if (kind === "tool_call" || kind === "tool_result" || kind === "error") return kind;
  return "agent_message";
}

function legacyRunEventActor(kind: LegacyProjectRunEventRow["kind"]): ProjectEventActorType {
  if (kind === "tool_call" || kind === "tool_result") return "tool";
  if (kind === "error") return "system";
  return "agent";
}

/**
 * The caller must wrap this operation in a transaction. The source table makes
 * repeated backfills idempotent and keeps old table identities auditable.
 */
export async function backfillLegacyProjectEvents(sql: Sql, projectId: string): Promise<number> {
  const stateRows = await queryRows<ProjectEventBackfillStateRow>(
    sql,
    "SELECT * FROM project_event_backfill_state WHERE project_id = ? FOR UPDATE",
    [projectId],
  );
  let state: ProjectEventBackfillState;
  if (stateRows[0]) {
    state = {
      projectId,
      lastMessageId: Number(stateRows[0].last_message_id),
      lastRunEventId: Number(stateRows[0].last_run_event_id),
      lastRunCreatedAt: toIso(stateRows[0].last_run_created_at),
      lastRunId: stateRows[0].last_run_id,
    };
  } else {
    const [messageCursorRows, eventCursorRows, runCursorRows] = await Promise.all([
      queryRows<RowDataPacket & { last_id: number }>(
        sql,
        `SELECT COALESCE(MAX(pm.id), 0) AS last_id
         FROM project_messages pm
         INNER JOIN project_event_sources source
           ON source.source_type = 'project_message'
          AND source.source_id = CONVERT(pm.id, CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
         WHERE pm.project_id = ?`,
        [projectId],
      ),
      queryRows<RowDataPacket & { last_id: number }>(
        sql,
        `SELECT COALESCE(MAX(pre.id), 0) AS last_id
         FROM project_run_events pre
         INNER JOIN project_runs pr ON pr.id = pre.run_id
         INNER JOIN project_event_sources source
           ON source.source_type = 'project_run_event'
          AND source.source_id = CONVERT(pre.id, CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
         WHERE pr.project_id = ?`,
        [projectId],
      ),
      queryRows<RowDataPacket & { id: string; created_at: string }>(
        sql,
        `SELECT pr.id, pr.created_at
         FROM project_runs pr
         INNER JOIN project_event_sources source
           ON source.source_type = 'project_run' AND source.source_id = pr.id
         WHERE pr.project_id = ?
         ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1`,
        [projectId],
      ),
    ]);
    state = {
      projectId,
      lastMessageId: Number(messageCursorRows[0]?.last_id ?? 0),
      lastRunEventId: Number(eventCursorRows[0]?.last_id ?? 0),
      lastRunCreatedAt: runCursorRows[0] ? toIso(runCursorRows[0].created_at) : "1970-01-01T00:00:00+08:00",
      lastRunId: runCursorRows[0]?.id ?? "",
    };
    await sql.query(
      `INSERT INTO project_event_backfill_state
        (project_id, last_message_id, last_run_event_id, last_run_created_at, last_run_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        state.lastMessageId,
        state.lastRunEventId,
        toSql(state.lastRunCreatedAt),
        state.lastRunId,
        toSql(state.lastRunCreatedAt),
      ],
    );
  }

  const [messages, runs, runEvents] = await Promise.all([
    queryRows<LegacyProjectMessageRow>(
      sql,
      `SELECT pm.id, pm.speaker, pm.role_id, pm.body, pm.created_at
       FROM project_messages pm
       WHERE pm.project_id = ? AND pm.id > ?
         AND NOT EXISTS (
           SELECT 1 FROM project_event_sources source
           WHERE source.source_type = 'project_message'
             AND source.source_id = CONVERT(pm.id, CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
         )
       ORDER BY pm.id`,
      [projectId, state.lastMessageId],
    ),
    queryRows<LegacyProjectRunRow>(
      sql,
      `SELECT pr.id, pr.role_id, pr.request_text, pr.status, pr.summary,
              pr.error_text, pr.return_reason, pr.created_at
       FROM project_runs pr
       WHERE pr.project_id = ?
         AND (pr.created_at > ? OR (pr.created_at = ? AND pr.id > ?))
         AND NOT EXISTS (
           SELECT 1 FROM project_event_sources source
           WHERE source.source_type = 'project_run' AND source.source_id = pr.id
         )
       ORDER BY pr.created_at, pr.id`,
      [projectId, toSql(state.lastRunCreatedAt), toSql(state.lastRunCreatedAt), state.lastRunId],
    ),
    queryRows<LegacyProjectRunEventRow>(
      sql,
      `SELECT pre.id, pre.run_id, pr.role_id, pre.kind, pre.body, pre.created_at
       FROM project_run_events pre
       INNER JOIN project_runs pr ON pr.id = pre.run_id
       WHERE pr.project_id = ? AND pre.id > ?
         AND NOT EXISTS (
           SELECT 1 FROM project_event_sources source
           WHERE source.source_type = 'project_run_event'
             AND source.source_id = CONVERT(pre.id, CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
         )
       ORDER BY pre.id`,
      [projectId, state.lastRunEventId],
    ),
  ]);

  const candidates: LegacyEventCandidate[] = [
    ...messages.map((row): LegacyEventCandidate => ({
      sourceType: "project_message",
      sourceId: String(row.id),
      event: {
        projectId,
        workflowId: null,
        workItemId: null,
        actorType: row.speaker === "boss" ? "boss" : "agent",
        actorId: row.speaker === "boss" ? null : row.role_id,
        kind: row.speaker === "boss" ? "user_message" : "agent_message",
        body: { text: row.body, legacy: { source: "project_messages", id: Number(row.id) } },
        createdAt: toIso(row.created_at),
      },
    })),
    ...runs.map((row): LegacyEventCandidate => ({
      sourceType: "project_run",
      sourceId: row.id,
      event: {
        projectId,
        workflowId: null,
        workItemId: null,
        actorType: "system",
        actorId: "legacy-project-run",
        kind: "workflow_created",
        body: {
          legacyRunId: row.id,
          roleId: row.role_id,
          requestText: row.request_text,
          status: row.status,
          summary: row.summary,
          errorText: row.error_text,
          returnReason: row.return_reason,
        },
        createdAt: toIso(row.created_at),
      },
    })),
    ...runEvents.map((row): LegacyEventCandidate => {
      const value = typeof row.body === "string" ? JSON.parse(row.body) : row.body;
      const record = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
      return {
        sourceType: "project_run_event",
        sourceId: String(row.id),
        event: {
          projectId,
          workflowId: null,
          workItemId: null,
          actorType: legacyRunEventActor(row.kind),
          actorId: row.kind === "reasoning" || row.kind === "message" ? row.role_id : "legacy-project-run",
          kind: legacyRunEventKind(row.kind),
          body: {
            legacyRunId: row.run_id,
            legacyKind: row.kind,
            hidden: row.kind === "reasoning",
            ...(row.kind === "message"
              ? { text: String(record.text ?? ""), delta: record.delta === true }
              : { value }),
          },
          createdAt: toIso(row.created_at),
        },
      };
    }),
  ].sort(
    (left, right) =>
      left.event.createdAt.localeCompare(right.event.createdAt) ||
      left.sourceType.localeCompare(right.sourceType) ||
      left.sourceId.localeCompare(right.sourceId),
  );

  for (const candidate of candidates) {
    const eventId = await appendProjectEvent(sql, candidate.event);
    await linkProjectEventSource(sql, candidate.sourceType, candidate.sourceId, eventId);
  }
  const lastRun = runs.at(-1);
  await sql.query(
    `UPDATE project_event_backfill_state SET
      last_message_id = ?, last_run_event_id = ?, last_run_created_at = ?, last_run_id = ?, updated_at = ?
     WHERE project_id = ?`,
    [
      messages.at(-1)?.id ?? state.lastMessageId,
      runEvents.at(-1)?.id ?? state.lastRunEventId,
      lastRun ? toSql(toIso(lastRun.created_at)) : toSql(state.lastRunCreatedAt),
      lastRun?.id ?? state.lastRunId,
      toSql(shanghaiTime().iso),
      projectId,
    ],
  );
  return candidates.length;
}

export async function insertProjectWorkflow(sql: Sql, workflow: ProjectWorkflow): Promise<void> {
  const checked = projectWorkflowSchema.parse(workflow);
  await sql.query(
    `INSERT INTO project_workflows
      (id, project_id, task_id, source_event_id, title, request_text, coordinator_role_id, status,
       summary, error_text, return_reason, cancel_reason, created_at, updated_at, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      checked.id,
      checked.projectId,
      checked.taskId,
      checked.sourceEventId,
      checked.title,
      checked.requestText,
      checked.coordinatorRoleId,
      checked.status,
      checked.summary,
      checked.errorText,
      checked.returnReason,
      checked.cancelReason,
      toSql(checked.createdAt),
      toSql(checked.updatedAt),
      checked.approvedAt ? toSql(checked.approvedAt) : null,
    ],
  );
}

export async function getProjectWorkflow(
  sql: Sql,
  id: string,
  lock = false,
): Promise<ProjectWorkflow | null> {
  const rows = await queryRows<ProjectWorkflowRow>(
    sql,
    `SELECT * FROM project_workflows WHERE id = ?${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] ? mapProjectWorkflow(rows[0]) : null;
}

export async function listProjectWorkflows(sql: Sql, projectId: string): Promise<ProjectWorkflow[]> {
  const rows = await queryRows<ProjectWorkflowRow>(
    sql,
    `SELECT * FROM project_workflows
     WHERE project_id = ? ORDER BY created_at DESC, id DESC`,
    [projectId],
  );
  return rows.map(mapProjectWorkflow);
}

export async function listTaskProjectWorkflows(sql: Sql): Promise<ProjectWorkflow[]> {
  const rows = await queryRows<ProjectWorkflowRow>(
    sql,
    `SELECT * FROM project_workflows
     WHERE task_id IS NOT NULL ORDER BY created_at DESC, id DESC`,
  );
  return rows.map(mapProjectWorkflow);
}

export async function findActiveTaskWorkflow(
  sql: Sql,
  taskId: string,
  lock = false,
): Promise<ProjectWorkflow | null> {
  const rows = await queryRows<ProjectWorkflowRow>(
    sql,
    `SELECT * FROM project_workflows
     WHERE task_id = ?
       AND status IN ('intake', 'planning', 'collaborating', 'waiting_user', 'verifying', 'review', 'applying', 'returned')
     ORDER BY created_at DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [taskId],
  );
  return rows[0] ? mapProjectWorkflow(rows[0]) : null;
}

export async function listResumableWorkflowIds(sql: Sql, onlyWorkflowId?: string): Promise<string[]> {
  const rows = await queryRows<RowDataPacket & { id: string }>(
    sql,
    `SELECT id FROM project_workflows
     WHERE status IN ('collaborating', 'verifying')
       ${onlyWorkflowId ? "AND id = ?" : ""}
     ORDER BY updated_at, id`,
    onlyWorkflowId ? [onlyWorkflowId] : [],
  );
  return rows.map((row) => row.id);
}

export async function resetInterruptedWorkItems(sql: Sql, updatedAt: string, onlyWorkflowId?: string): Promise<number> {
  const [result] = await sql.query(
    `UPDATE project_work_items item
     INNER JOIN project_workflows workflow ON workflow.id = item.workflow_id
     SET item.status = 'ready', item.updated_at = ?
     WHERE item.status = 'running' AND workflow.status = 'collaborating'
       ${onlyWorkflowId ? "AND workflow.id = ?" : ""}`,
    onlyWorkflowId ? [toSql(updatedAt), onlyWorkflowId] : [toSql(updatedAt)],
  );
  return Number((result as { affectedRows?: number }).affectedRows ?? 0);
}

export async function listExpiredWorkflowIds(sql: Sql, before: string): Promise<string[]> {
  const rows = await queryRows<RowDataPacket & { id: string }>(
    sql,
    `SELECT id FROM project_workflows
     WHERE status IN ('approved', 'failed', 'cancelled') AND updated_at < ?
     ORDER BY updated_at, id`,
    [toSql(before)],
  );
  return rows.map((row) => row.id);
}

export async function updateProjectWorkflow(sql: Sql, workflow: ProjectWorkflow): Promise<void> {
  const checked = projectWorkflowSchema.parse(workflow);
  await sql.query(
    `UPDATE project_workflows SET
      coordinator_role_id = ?, status = ?, summary = ?, error_text = ?, return_reason = ?,
      cancel_reason = ?, updated_at = ?, approved_at = ?
     WHERE id = ?`,
    [
      checked.coordinatorRoleId,
      checked.status,
      checked.summary,
      checked.errorText,
      checked.returnReason,
      checked.cancelReason,
      toSql(checked.updatedAt),
      checked.approvedAt ? toSql(checked.approvedAt) : null,
      checked.id,
    ],
  );
}

export async function insertProjectWorkItem(sql: Sql, item: ProjectWorkItem): Promise<void> {
  const checked = projectWorkItemSchema.parse(item);
  await sql.query(
    `INSERT INTO project_work_items
      (id, workflow_id, position, title, objective, acceptance, owner_role_id, reviewer_role_id, status,
       blocked_reason, summary, evidence, error_text, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      checked.id,
      checked.workflowId,
      checked.position,
      checked.title,
      checked.objective,
      JSON.stringify(checked.acceptance),
      checked.ownerRoleId,
      checked.reviewerRoleId,
      checked.status,
      checked.blockedReason,
      checked.summary,
      JSON.stringify(checked.evidence),
      checked.errorText,
      checked.retryCount,
      toSql(checked.createdAt),
      toSql(checked.updatedAt),
    ],
  );
}

export async function getProjectWorkItem(
  sql: Sql,
  id: string,
  lock = false,
): Promise<ProjectWorkItem | null> {
  const rows = await queryRows<ProjectWorkItemRow>(
    sql,
    `SELECT * FROM project_work_items WHERE id = ?${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] ? mapProjectWorkItem(rows[0]) : null;
}

export async function listProjectWorkItems(
  sql: Sql,
  workflowId: string,
  lock = false,
): Promise<ProjectWorkItem[]> {
  const rows = await queryRows<ProjectWorkItemRow>(
    sql,
    `SELECT * FROM project_work_items
     WHERE workflow_id = ? ORDER BY position, id${lock ? " FOR UPDATE" : ""}`,
    [workflowId],
  );
  return rows.map(mapProjectWorkItem);
}

export async function updateProjectWorkItem(sql: Sql, item: ProjectWorkItem): Promise<void> {
  const checked = projectWorkItemSchema.parse(item);
  await sql.query(
    `UPDATE project_work_items SET
      owner_role_id = ?, reviewer_role_id = ?, status = ?, blocked_reason = ?, summary = ?,
      evidence = ?, error_text = ?, retry_count = ?, updated_at = ?
     WHERE id = ?`,
    [
      checked.ownerRoleId,
      checked.reviewerRoleId,
      checked.status,
      checked.blockedReason,
      checked.summary,
      JSON.stringify(checked.evidence),
      checked.errorText,
      checked.retryCount,
      toSql(checked.updatedAt),
      checked.id,
    ],
  );
}

export async function insertWorkItemDependencies(
  sql: Sql,
  dependencies: WorkItemDependency[],
): Promise<void> {
  if (dependencies.length === 0) return;
  const placeholders = dependencies.map(() => "(?, ?)").join(", ");
  await sql.query(
    `INSERT INTO project_work_item_dependencies (work_item_id, depends_on_work_item_id)
     VALUES ${placeholders}`,
    dependencies.flatMap((dependency) => [dependency.workItemId, dependency.dependsOnWorkItemId]),
  );
}

export async function listWorkflowDependencies(
  sql: Sql,
  workflowId: string,
): Promise<WorkItemDependency[]> {
  const rows = await queryRows<RowDataPacket & { work_item_id: string; depends_on_work_item_id: string }>(
    sql,
    `SELECT dependency.work_item_id, dependency.depends_on_work_item_id
     FROM project_work_item_dependencies dependency
     INNER JOIN project_work_items item ON item.id = dependency.work_item_id
     WHERE item.workflow_id = ?
     ORDER BY dependency.work_item_id, dependency.depends_on_work_item_id`,
    [workflowId],
  );
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    dependsOnWorkItemId: row.depends_on_work_item_id,
  }));
}

export async function insertProjectDecisionRequest(
  sql: Sql,
  request: ProjectDecisionRequest,
): Promise<void> {
  const checked = projectDecisionRequestSchema.parse(request);
  await sql.query(
    `INSERT INTO project_decision_requests
      (id, workflow_id, work_item_id, asked_by_role_id, question, options, recommendation, reason,
       blocking_work_item_ids, status, answer, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      checked.id,
      checked.workflowId,
      checked.workItemId,
      checked.askedByRoleId,
      checked.question,
      JSON.stringify(checked.options),
      checked.recommendation,
      checked.reason,
      JSON.stringify(checked.blockingWorkItemIds),
      checked.status,
      checked.answer,
      toSql(checked.createdAt),
      checked.resolvedAt ? toSql(checked.resolvedAt) : null,
    ],
  );
}

export async function getProjectDecisionRequest(
  sql: Sql,
  id: string,
  lock = false,
): Promise<ProjectDecisionRequest | null> {
  const rows = await queryRows<ProjectDecisionRequestRow>(
    sql,
    `SELECT * FROM project_decision_requests WHERE id = ?${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] ? mapProjectDecisionRequest(rows[0]) : null;
}

export async function listOpenWorkflowDecisionRequests(
  sql: Sql,
  workflowId: string,
): Promise<ProjectDecisionRequest[]> {
  const rows = await queryRows<ProjectDecisionRequestRow>(
    sql,
    `SELECT * FROM project_decision_requests
     WHERE workflow_id = ? AND status = 'open'
     ORDER BY created_at, id`,
    [workflowId],
  );
  return rows.map(mapProjectDecisionRequest);
}

export async function updateProjectDecisionRequest(
  sql: Sql,
  request: ProjectDecisionRequest,
): Promise<void> {
  const checked = projectDecisionRequestSchema.parse(request);
  await sql.query(
    `UPDATE project_decision_requests SET status = ?, answer = ?, resolved_at = ? WHERE id = ?`,
    [
      checked.status,
      checked.answer,
      checked.resolvedAt ? toSql(checked.resolvedAt) : null,
      checked.id,
    ],
  );
}

export async function insertWorkflowArtifact(sql: Sql, artifact: WorkflowArtifact): Promise<void> {
  const checked = workflowArtifactSchema.parse(artifact);
  await sql.query(
    `INSERT INTO workflow_artifacts
      (id, workflow_id, work_item_id, created_by_role_id, kind, relative_ref, sha256, size_bytes,
       metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      checked.id,
      checked.workflowId,
      checked.workItemId,
      checked.createdByRoleId,
      checked.kind,
      checked.relativeRef,
      checked.sha256,
      checked.sizeBytes,
      JSON.stringify(checked.metadata),
      toSql(checked.createdAt),
    ],
  );
}

export async function listWorkflowArtifacts(sql: Sql, workflowId: string): Promise<WorkflowArtifact[]> {
  const rows = await queryRows<WorkflowArtifactRow>(
    sql,
    `SELECT * FROM workflow_artifacts WHERE workflow_id = ? ORDER BY created_at, id`,
    [workflowId],
  );
  return rows.map(mapWorkflowArtifact);
}

