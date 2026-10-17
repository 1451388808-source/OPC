"use client";

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { CollaborationReviewView, ProjectWorkflowSummary } from "@/lib/application/collaboration";
import type { ProjectEvent } from "@/lib/domain/collaboration";

export type ChangeTotals = { files: number; additions: number; deletions: number };

const emptyTotals: ChangeTotals = { files: 0, additions: 0, deletions: 0 };

const statusLabels: Record<string, string> = {
  collaborating: "执行中",
  waiting_user: "等待决定",
  review: "待批准",
  approved: "已批准",
  failed: "失败",
  returned: "已退回",
};

function bodyOf(event: ProjectEvent): Record<string, unknown> {
  return event.body !== null && typeof event.body === "object" ? (event.body as Record<string, unknown>) : {};
}

function changedFileEvent(event: ProjectEvent): boolean {
  if (event.kind !== "tool_result") return false;
  const body = bodyOf(event);
  const value = body.value !== null && typeof body.value === "object"
    ? (body.value as Record<string, unknown>)
    : body;
  return value.ok !== false && ["write_file", "opc.project.stage_write"].includes(String(value.name ?? ""));
}

export function WorkflowChangesPanel({
  initialWorkflows,
  events,
  open,
  onClose,
  onTotalsChange,
}: {
  initialWorkflows: ProjectWorkflowSummary[];
  events: ProjectEvent[];
  open: boolean;
  onClose: () => void;
  onTotalsChange: Dispatch<SetStateAction<ChangeTotals>>;
}) {
  const [workflowId, setWorkflowId] = useState(initialWorkflows[0]?.id ?? "");
  const [selectedPath, setSelectedPath] = useState("");
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<CollaborationReviewView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);

  const latestCreatedId = [...events].reverse().find((event) => event.kind === "workflow_created")?.workflowId ?? "";
  const previousCreatedId = useRef(latestCreatedId);

  const workflows = useMemo(() => {
    const byId = new Map(initialWorkflows.map((workflow) => [workflow.id, { ...workflow }]));
    for (const event of events) {
      if (!event.workflowId) continue;
      const body = bodyOf(event);
      if (event.kind === "workflow_created" && !byId.has(event.workflowId)) {
        byId.set(event.workflowId, {
          id: event.workflowId,
          title: String(body.title ?? "协作任务"),
          status: "collaborating",
          createdAt: event.createdAt,
        });
      }
      if (event.kind === "workflow_status") {
        const workflow = byId.get(event.workflowId);
        if (workflow) workflow.status = String(body.status ?? workflow.status) as ProjectWorkflowSummary["status"];
      }
    }
    return [...byId.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [initialWorkflows, events]);

  useEffect(() => {
    if (!workflowId && workflows[0]) setWorkflowId(workflows[0].id);
  }, [workflowId, workflows]);

  useEffect(() => {
    if (latestCreatedId && latestCreatedId !== previousCreatedId.current) {
      setWorkflowId(latestCreatedId);
      setSelectedPath("");
      setFilter("");
      setView(null);
      onTotalsChange(emptyTotals);
    }
    previousCreatedId.current = latestCreatedId;
  }, [latestCreatedId, onTotalsChange]);

  const revision = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (event.workflowId === workflowId && (changedFileEvent(event) || event.kind === "workflow_status")) {
        return event.id;
      }
    }
    return 0;
  }, [events, workflowId]);

  useEffect(() => {
    if (!workflowId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      void fetch(`/api/workflows/${workflowId}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          const payload = (await response.json()) as CollaborationReviewView & { error?: string };
          if (!response.ok) throw new Error(payload.error || "没有读到文件变更");
          setView(payload);
          setSelectedPath((current) => payload.files.some((file) => file.path === current) ? current : (payload.files[0]?.path ?? ""));
          onTotalsChange(payload.files.reduce<ChangeTotals>((totals, file) => ({
            files: totals.files + 1,
            additions: totals.additions + file.additions,
            deletions: totals.deletions + file.deletions,
          }), emptyTotals));
          setError("");
        })
        .catch((caught: unknown) => {
          if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "没有读到文件变更");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, revision ? 350 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [workflowId, revision, refreshCount, open, onTotalsChange]);

  const files = view?.files ?? [];
  const visibleFiles = files.filter((file) => file.path.toLowerCase().includes(filter.trim().toLowerCase()));
  const selectedFile = files.find((file) => file.path === selectedPath) ?? null;
  const totals = files.reduce<ChangeTotals>((current, file) => ({
    files: current.files + 1,
    additions: current.additions + file.additions,
    deletions: current.deletions + file.deletions,
  }), emptyTotals);

  return (
    <aside className="workflow-changes-panel" aria-label="任务文件变更" aria-hidden={!open} inert={!open}>
      <header className="changes-head">
        <div>
          <strong>变更</strong>
          {view ? <small>{totals.files} 个文件 <span className="diff-add">+{totals.additions}</span> <span className="diff-remove">-{totals.deletions}</span></small> : null}
        </div>
        <div className="changes-head-actions">
          <button type="button" className="icon-button" title="刷新变更" aria-label="刷新变更" onClick={() => setRefreshCount((count) => count + 1)}>↻</button>
          <button type="button" className="icon-button" title="关闭变更" aria-label="关闭变更" onClick={onClose}>×</button>
        </div>
      </header>
      <div className="changes-controls">
        <select
          value={workflowId}
          aria-label="选择协作任务"
          onChange={(event) => {
            setWorkflowId(event.target.value);
            setSelectedPath("");
            setFilter("");
            setView(null);
            onTotalsChange(emptyTotals);
          }}
        >
          {workflows.length === 0 ? <option value="">还没有协作任务</option> : null}
          {workflows.map((workflow) => (
            <option value={workflow.id} key={workflow.id}>
              {workflow.title} · {statusLabels[workflow.status] ?? workflow.status}
            </option>
          ))}
        </select>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="筛选文件"
          aria-label="筛选文件"
          disabled={files.length === 0}
        />
      </div>
      {error ? <div className="changes-error" role="alert">{error}</div> : null}
      {loading ? <div className="changes-loading" role="status">正在更新变更...</div> : null}
      <div className="changes-body">
        <nav className="changes-files" aria-label="变更文件">
          {files.length === 0 ? <p className="changes-empty">{workflowId ? "尚无文件变更" : "选择任务查看变更"}</p> : null}
          {files.length > 0 && visibleFiles.length === 0 ? <p className="changes-empty">没有匹配的文件</p> : null}
          {visibleFiles.map((file) => (
            <button
              type="button"
              className={`changes-file${selectedPath === file.path ? " active" : ""}`}
              key={file.path}
              onClick={() => setSelectedPath(file.path)}
              title={file.path}
            >
              <span className={`changes-file-kind ${file.operation}`}>{file.operation === "create" ? "A" : "M"}</span>
              <span className="changes-file-path">{file.path}</span>
              <span className="changes-file-count"><span className="diff-add">+{file.additions}</span> <span className="diff-remove">-{file.deletions}</span></span>
            </button>
          ))}
        </nav>
        <section className="changes-diff" aria-label="文件差异">
          {selectedFile ? (
            <>
              <header className="changes-diff-head">
                <code title={selectedFile.path}>{selectedFile.path}</code>
                <span><span className="diff-add">+{selectedFile.additions}</span> <span className="diff-remove">-{selectedFile.deletions}</span></span>
              </header>
              <div className="changes-diff-scroll">
                {selectedFile.hunks.length === 0 ? <p className="changes-empty">没有逐行差异</p> : null}
                {selectedFile.hunks.map((hunk, hunkIndex) => (
                  <div className="diff-hunk" key={`${hunk.header}-${hunkIndex}`}>
                    <div className="diff-hunk-head">{hunk.header}</div>
                    {hunk.lines.map((line, lineIndex) => (
                      <div className={`diff-row diff-${line.kind}`} key={`${hunkIndex}-${lineIndex}`}>
                        <span className="diff-line-number">{line.oldLine ?? ""}</span>
                        <span className="diff-line-number">{line.newLine ?? ""}</span>
                        <span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}</span>
                        <code>{line.text || " "}</code>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          ) : <p className="changes-empty changes-diff-placeholder">选择文件查看具体改动</p>}
        </section>
      </div>
    </aside>
  );
}
