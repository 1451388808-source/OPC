"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ProjectRun, ProjectRunEvent, ProjectRunFile, ProjectRunStatus } from "@/lib/domain/project-run";
import {
  groupProjectRunEvents,
  type ProjectRunEventGroup,
} from "@/lib/domain/project-run-events";

export type RunView = {
  run: ProjectRun;
  events: ProjectRunEvent[];
  files: (ProjectRunFile & { diff: string })[];
};

export const runStatusLabel: Record<ProjectRunStatus, string> = {
  queued: "等待执行",
  running: "执行中",
  review: "待批准",
  applying: "正在应用",
  approved: "已批准",
  returned: "已退回",
  failed: "失败",
};

const terminal = new Set<ProjectRunStatus>(["review", "approved", "returned", "failed"]);

export function ProjectRunActivity({
  run,
  roleName,
  detailHref,
}: {
  run: ProjectRun;
  roleName: string;
  detailHref: string;
}) {
  const [view, setView] = useState<RunView | null>(null);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const current = view?.run ?? run;
  const hasStreamedSummary =
    view?.events.some(
      (event) =>
        event.kind === "message" &&
        event.body !== null &&
        typeof event.body === "object" &&
        (event.body as Record<string, unknown>).delta === true,
    ) ?? false;

  useEffect(() => {
    let active = true;
    let source: EventSource | null = null;
    const load = async () => {
      try {
        const response = await fetch(`/api/project-runs/${run.id}`, { cache: "no-store" });
        const payload = (await response.json()) as RunView & { error?: string };
        if (!response.ok) throw new Error(payload.error || "没有读到执行记录");
        if (!active) return;
        setView(payload);
        if (!terminal.has(payload.run.status)) {
          source = new EventSource(`/api/project-runs/${run.id}/events`);
          source.onmessage = (event) => {
            const update = JSON.parse(event.data) as
              | { type: "event"; event: ProjectRunEvent }
              | { type: "status"; status: ProjectRunStatus }
              | { type: "error"; message: string };
            if (update.type === "event") {
              setView((value) =>
                value
                  ? {
                      ...value,
                      events: value.events.some((item) => item.id === update.event.id)
                        ? value.events
                        : [...value.events, update.event],
                    }
                  : value,
              );
            } else if (update.type === "status") {
              setView((value) =>
                value ? { ...value, run: { ...value.run, status: update.status } } : value,
              );
              if (terminal.has(update.status)) {
                source?.close();
                void load();
              }
            } else {
              setError(update.message);
            }
          };
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "没有读到执行记录");
      }
    };
    void load();
    return () => {
      active = false;
      source?.close();
    };
  }, [run.id]);

  useEffect(() => {
    if (current.status === "queued" || current.status === "running") {
      rootRef.current?.scrollIntoView({ block: "end" });
    }
  }, [current.status, view?.events.length]);

  return (
    <div className="run-chat-block" ref={rootRef}>
      <article className="turn turn-you run-chat-request">
        <div className="turn-name">你 · 执行任务</div>
        <p>{run.requestText}</p>
      </article>
      <article className="turn run-chat-turn">
        <div className="run-chat-heading">
          <div className="turn-name">{roleName}</div>
          <span className={`pill run-pill ${current.status}`}>{runStatusLabel[current.status]}</span>
        </div>
        {error ? <p className="run-event error">{error}</p> : null}
        {!view ? <p className="run-event">正在读取执行记录。</p> : null}
        {view ? <ProjectRunEventList events={view.events} active={current.status === "running"} /> : null}
        {view?.run.summary && !hasStreamedSummary ? (
          <div className="run-chat-summary">
            <strong>完成摘要</strong>
            <p>{view.run.summary}</p>
          </div>
        ) : null}
        {view?.files.length ? (
          <div className="run-chat-files">
            <strong>文件修改</strong>
            {view.files.map((file) => (
              <code key={file.path}>
                {file.operation === "create" ? "新建" : "修改"} {file.path}
              </code>
            ))}
          </div>
        ) : null}
        {current.status === "review" ? (
          <Link className="primary run-chat-link" href={detailHref}>
            查看文件并审批
          </Link>
        ) : null}
        {current.status === "approved" || current.status === "returned" || current.status === "failed" ? (
          <Link className="ghost run-chat-link" href={detailHref}>
            查看执行详情
          </Link>
        ) : null}
      </article>
    </div>
  );
}

export function ProjectRunEventList({
  events,
  active = false,
}: {
  events: ProjectRunEvent[];
  active?: boolean;
}) {
  const groups = groupProjectRunEvents(events);
  return groups.map((group, index) => (
    <ProjectRunEventLine
      key={group.id}
      group={group}
      active={
        active &&
        index === groups.length - 1 &&
        (group.kind === "reasoning" || group.kind === "message")
      }
    />
  ));
}

function ProjectRunEventLine({
  group,
  active,
}: {
  group: ProjectRunEventGroup;
  active: boolean;
}) {
  if (group.kind === "reasoning") {
    return (
      <details className="run-event reasoning" open={active || undefined}>
        <summary>思考</summary>
        <p>
          {group.text}
          {active ? <span className="caret" /> : null}
        </p>
      </details>
    );
  }
  if (group.kind === "tool_call") {
    return <p className="run-event tool">调用工具：{group.name}</p>;
  }
  if (group.kind === "tool_result") {
    return (
      <p className={group.ok === false ? "run-event tool error" : "run-event tool"}>
        工具结果：{group.name}
        {group.ok === false ? ` · ${group.error || "失败"}` : " · 完成"}
      </p>
    );
  }
  if (group.kind === "message") {
    if (!group.streamed) return <p className="run-event">{group.text}</p>;
    return (
      <div className="run-event streamed-message">
        <strong>完成回复</strong>
        <p>
          {group.text}
          {active ? <span className="caret" /> : null}
        </p>
      </div>
    );
  }
  return (
    <p className="run-event error">{group.text}</p>
  );
}
