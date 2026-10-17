"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ProjectRun, ProjectRunEvent, ProjectRunFile, ProjectRunStatus } from "@/lib/domain/project-run";
import { ProjectRunEventList, runStatusLabel } from "./project-run-activity";

type RunView = {
  run: ProjectRun;
  events: ProjectRunEvent[];
  files: (ProjectRunFile & { diff: string })[];
};

const terminal = new Set<ProjectRunStatus>(["review", "approved", "returned", "failed"]);

async function json<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "没有完成");
  return payload;
}

export function ProjectRuns({
  projectId,
  companyId,
  members,
  initialRuns,
  initialRunId,
}: {
  projectId: string;
  companyId: string;
  members: { id: string; name: string }[];
  initialRuns: ProjectRun[];
  initialRunId: string | null;
}) {
  const router = useRouter();
  const [runs, setRuns] = useState(initialRuns);
  const [selectedId, setSelectedId] = useState(initialRunId ?? initialRuns[0]?.id ?? null);
  const [selected, setSelected] = useState<RunView | null>(null);
  const [roleId, setRoleId] = useState(members[0]?.id ?? "");
  const [requestText, setRequestText] = useState("");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const [revision, setRevision] = useState(0);
  const base = `/company/${companyId}/p/${projectId}?view=runs`;

  useEffect(() => {
    setRuns(initialRuns);
  }, [initialRuns]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    setSelected(null);
    let active = true;
    let source: EventSource | null = null;
    const load = async () => {
      setLoading(true);
      try {
        const next = await json<RunView>(await fetch(`/api/project-runs/${selectedId}`, { cache: "no-store" }));
        if (!active) return;
        setSelected(next);
        setRuns((current) => upsertRun(current, next.run));
        if (!terminal.has(next.run.status)) {
          source = new EventSource(`/api/project-runs/${selectedId}/events`);
          source.onmessage = (event) => {
            const payload = JSON.parse(event.data) as
              | { type: "event"; event: ProjectRunEvent }
              | { type: "status"; status: ProjectRunStatus }
              | { type: "error"; message: string };
            if (payload.type === "event") {
              setSelected((current) =>
                current
                  ? {
                      ...current,
                      events: current.events.some((item) => item.id === payload.event.id)
                        ? current.events
                        : [...current.events, payload.event],
                    }
                  : current,
              );
            } else if (payload.type === "status") {
              setSelected((current) =>
                current ? { ...current, run: { ...current.run, status: payload.status } } : current,
              );
              setRuns((current) =>
                current.map((run) => (run.id === selectedId ? { ...run, status: payload.status } : run)),
              );
              if (terminal.has(payload.status)) {
                source?.close();
                void load().then(() => router.refresh());
              }
            } else {
              setError(payload.message);
            }
          };
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "没有完成");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
      source?.close();
    };
  }, [revision, router, selectedId]);

  const selectedRole = useMemo(
    () => members.find((member) => member.id === selected?.run.roleId)?.name ?? selected?.run.roleId,
    [members, selected],
  );
  const hasStreamedSummary =
    selected?.events.some(
      (event) =>
        event.kind === "message" &&
        event.body !== null &&
        typeof event.body === "object" &&
        (event.body as Record<string, unknown>).delta === true,
    ) ?? false;

  function openRun(runId: string) {
    setError("");
    setSelectedId(runId);
    router.replace(`${base}&run=${runId}`);
  }

  async function reviewAction(url: string, body?: unknown) {
    if (!selected || pending) return;
    setPending(true);
    setError("");
    try {
      await json(
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        }),
      );
      setReturnReason("");
      setRevision((value) => value + 1);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "没有完成");
      setRevision((value) => value + 1);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="project-runs">
      <aside className="run-list">
        <form
          className="run-create"
          onSubmit={(event) => {
            event.preventDefault();
            const text = requestText.trim();
            if (!text || !roleId || pending) return;
            setPending(true);
            setError("");
            void fetch(`/api/projects/${projectId}/runs`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ roleId, requestText: text }),
            })
              .then((response) => json<{ runId: string }>(response))
              .then(({ runId }) => {
                setRequestText("");
                openRun(runId);
              })
              .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "没有完成"))
              .finally(() => setPending(false));
          }}
        >
          <label>
            员工
            <select value={roleId} onChange={(event) => setRoleId(event.target.value)} disabled={pending}>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            执行要求
            <textarea
              rows={4}
              value={requestText}
              onChange={(event) => setRequestText(event.target.value)}
              placeholder="写清要查看、创建或修改什么文件"
            />
          </label>
          <button className="send" type="submit" disabled={pending || !roleId || !requestText.trim()}>
            {pending ? "正在创建" : "执行"}
          </button>
        </form>
        {members.length === 0 ? <p className="empty">先把员工加入项目。</p> : null}
        <div className="run-list-scroll">
          {runs.length === 0 ? <p className="empty">还没有执行记录。</p> : null}
          {runs.map((run) => (
            <button
              className={run.id === selectedId ? "run-row active" : "run-row"}
              type="button"
              key={run.id}
              onClick={() => openRun(run.id)}
            >
              <span className={`run-status ${run.status}`} />
              <span>
                <strong>{run.requestText}</strong>
                <small>
                  {runStatusLabel[run.status]} · {members.find((member) => member.id === run.roleId)?.name ?? run.roleId}
                </small>
              </span>
            </button>
          ))}
        </div>
      </aside>
      <section className="run-detail">
        {error ? <p className="alert">{error}</p> : null}
        {!selectedId ? <p className="empty run-empty">创建或选择一次执行。</p> : null}
        {selectedId && loading && !selected ? <p className="empty run-empty">正在读取执行记录。</p> : null}
        {selected ? (
          <>
            <header className="run-detail-head">
              <div>
                <span className="quiet">
                  {selectedRole} · {selected.run.id}
                </span>
                <h2>{selected.run.requestText}</h2>
              </div>
              <span className={`pill run-pill ${selected.run.status}`}>{runStatusLabel[selected.run.status]}</span>
            </header>
            <div className="run-detail-scroll">
              {selected.run.summary && !hasStreamedSummary ? (
                <section className="run-section">
                  <h3>结果摘要</h3>
                  <p className="run-summary">{selected.run.summary}</p>
                </section>
              ) : null}
              {selected.run.errorText ? <p className="alert">{selected.run.errorText}</p> : null}
              <section className="run-section">
                <h3>执行记录</h3>
                {selected.events.length === 0 ? <p className="empty">等待执行器。</p> : null}
                <div className="run-events">
                  <ProjectRunEventList events={selected.events} active={selected.run.status === "running"} />
                </div>
              </section>
              <section className="run-section">
                <h3>文件修改</h3>
                {selected.files.length === 0 ? <p className="empty">还没有文件修改。</p> : null}
                {selected.files.map((file) => (
                  <details className="run-file" key={file.path} open>
                    <summary>
                      <code>{file.path}</code>
                      <span>{file.operation === "create" ? "新建" : "修改"}</span>
                    </summary>
                    {file.diff ? (
                      <pre className="run-diff">{file.diff}</pre>
                    ) : (
                      <p className="empty">暂存内容已按保留策略清理。</p>
                    )}
                  </details>
                ))}
              </section>
              {selected.run.status === "review" ? (
                <section className="run-review">
                  <p className="banner">修改仍在暂存区。批准后才会写入项目工作区。</p>
                  <div className="run-review-actions">
                    <button
                      className="primary"
                      type="button"
                      disabled={pending}
                      onClick={() => void reviewAction(`/api/project-runs/${selected.run.id}/approve`)}
                    >
                      {pending ? "正在处理" : `批准应用 ${selected.files.length} 个文件`}
                    </button>
                    <input
                      value={returnReason}
                      onChange={(event) => setReturnReason(event.target.value)}
                      placeholder="退回原因"
                      aria-label="退回原因"
                      disabled={pending}
                    />
                    <button
                      className="ghost"
                      type="button"
                      disabled={pending || !returnReason.trim()}
                      onClick={() =>
                        void reviewAction(`/api/project-runs/${selected.run.id}/return`, {
                          reason: returnReason,
                        })
                      }
                    >
                      退回
                    </button>
                  </div>
                </section>
              ) : null}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}

function upsertRun(runs: ProjectRun[], run: ProjectRun): ProjectRun[] {
  return [run, ...runs.filter((item) => item.id !== run.id)].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}
