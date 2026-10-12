"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { BoardData } from "@/lib/application/board";
import type { Status, Task } from "@/lib/domain/task";
import { PanelMotion } from "./motion";

const labels: Record<Status, string> = {
  doing: "进行中",
  review: "待批准",
  blocked: "阻塞",
  inbox: "收件",
  done: "完成",
};

const groups: Status[] = ["doing", "review", "blocked", "inbox"];

async function postJson(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = (await response.json()) as { error?: string; exportWarning?: string | null; taskId?: string };
  if (!response.ok) throw new Error(payload.error || "操作没有完成");
  return payload;
}

export function BoardView({
  board,
  initialTaskId,
}: {
  board: BoardData;
  initialTaskId: string | null;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(initialTaskId);
  const [weekFocus, setWeekFocus] = useState(board.weekFocus);
  const [brief, setBrief] = useState("");
  const [decision, setDecision] = useState("");
  const [reason, setReason] = useState("");
  const [record, setRecord] = useState(true);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setWeekFocus(board.weekFocus);
  }, [board.weekFocus]);

  useEffect(() => {
    setSelectedId(initialTaskId);
    setDecision("");
    setReason("");
    setRecord(true);
  }, [initialTaskId]);

  const now = (status: Status) =>
    board.tasks.filter((task) => task.priority === "now" && task.status === status);
  const upcoming = board.tasks.filter((task) => task.priority === "next");
  const selected = board.tasks.find((task) => task.id === selectedId) ?? null;
  const roleName = (id: string) => board.roles.find((role) => role.id === id)?.name ?? id;

  function openTask(id: string) {
    setSelectedId(id);
    setError("");
    router.replace(`/?task=${id}`);
  }

  function scrollTo(status: Status) {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document
      .getElementById(`group-${status}`)
      ?.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  }

  async function run(action: () => Promise<{ exportWarning?: string | null; taskId?: string }>) {
    setPending(true);
    setError("");
    try {
      const result = await action();
      setWarning(result.exportWarning ?? "");
      if (result.taskId) openTask(result.taskId);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作没有完成");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="app">
      <section className="side">
        <div className="side-head">
          <div className="brand">
            <strong>OPC</strong>
            <span>一人团队</span>
          </div>
          <span className="quiet">本机</span>
        </div>
        <form
          className="focus-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => postJson("/api/goals/week", { weekFocus }));
          }}
        >
          <div className="kicker">本周唯一重点</div>
          <textarea
            value={weekFocus}
            onChange={(event) => setWeekFocus(event.target.value)}
            placeholder="先写下本周重点"
            aria-label="本周唯一重点"
          />
          {board.weekLabel ? <div className="quiet dates">{board.weekLabel}</div> : null}
          <button className="ghost" type="submit" disabled={pending}>
            保存重点
          </button>
        </form>
        <div className="stats">
          <button className="stat on" type="button" onClick={() => scrollTo("review")}>
            <b>{now("review").length}</b>
            <span>待批准</span>
          </button>
          <button className="stat" type="button" onClick={() => scrollTo("blocked")}>
            <b>{now("blocked").length}</b>
            <span>阻塞</span>
          </button>
        </div>
        <div className="scroll">
          <div className="kicker" style={{ padding: "4px 8px" }}>
            最近决定
          </div>
          <p className="empty">{board.latestDecision ?? "尚无已生效决定。"}</p>
        </div>
      </section>

      <section className="list">
        <div className="list-head">
          <strong>现在</strong>
          <span className="quiet">进行中最多 2 条</span>
        </div>
        <div className="scroll">
          {board.weekFocus.trim() ? null : <p className="hint">先写下本周重点。</p>}
          {groups.map((status) => {
            const items = now(status);
            return (
              <div className="group" id={`group-${status}`} key={status}>
                <h2>{labels[status]}</h2>
                {items.length === 0 ? <p className="empty">没有{labels[status]}的任务</p> : null}
                {items.map((task) => (
                  <TaskButton
                    key={task.id}
                    task={task}
                    roleName={roleName(task.role)}
                    selected={task.id === selectedId}
                    onOpen={openTask}
                  />
                ))}
              </div>
            );
          })}
          <div className="group" id="group-next">
            <h2>接下来</h2>
            {upcoming.length === 0 ? <p className="empty">没有接下来的任务</p> : null}
            {upcoming.map((task) => (
              <div className="next-row" key={task.id}>
                <button className="task" type="button" onClick={() => openTask(task.id)}>
                  <i className={`dot ${task.status}`} />
                  <span>
                    <b>{task.title}</b>
                    <span className="meta">
                      <span>{task.id}</span>
                      <span>{roleName(task.role)}</span>
                    </span>
                  </span>
                </button>
                <button
                  className="ghost"
                  type="button"
                  disabled={pending}
                  onClick={() => void run(() => postJson(`/api/tasks/${task.id}/promote`))}
                >
                  提为现在
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="composer">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const text = brief;
              void run(async () => {
                const result = await postJson("/api/tasks", { brief: text });
                setBrief("");
                return result;
              });
            }}
          >
            <textarea
              rows={2}
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder="丢进一句话。策划之后再收成任务。"
              aria-label="收件"
            />
            <button className="send" type="submit" disabled={pending}>
              收件
            </button>
          </form>
        </div>
      </section>

      <section className="detail">
        {warning ? <p className="banner">{warning}</p> : null}
        {error ? <p className="alert">{error}</p> : null}
        <PanelMotion className="detail-motion" motionKey={selected?.id ?? "empty"}>
          {selected ? (
            <Detail
              task={selected}
              roleName={roleName(selected.role)}
              decision={decision}
              reason={reason}
              record={record}
              pending={pending}
              onDecision={setDecision}
              onReason={setReason}
              onRecord={setRecord}
              onApprove={() =>
                void run(() => postJson(`/api/tasks/${selected.id}/approve`, { decision, record }))
              }
              onReturn={() => void run(() => postJson(`/api/tasks/${selected.id}/return`, { reason }))}
            />
          ) : (
            <p className="empty" style={{ padding: 16 }}>
              选一条任务
            </p>
          )}
        </PanelMotion>
      </section>
    </div>
  );
}

function TaskButton({
  task,
  roleName,
  selected,
  onOpen,
}: {
  task: Task;
  roleName: string;
  selected: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <button className={selected ? "task selected" : "task"} type="button" onClick={() => onOpen(task.id)}>
      <i className={`dot ${task.status}`} />
      <span>
        <b>{task.title}</b>
        <span className="meta">
          <span>{task.id}</span>
          <span>{roleName}</span>
        </span>
      </span>
    </button>
  );
}

function Detail({
  task,
  roleName,
  decision,
  reason,
  record,
  pending,
  onDecision,
  onReason,
  onRecord,
  onApprove,
  onReturn,
}: {
  task: Task;
  roleName: string;
  decision: string;
  reason: string;
  record: boolean;
  pending: boolean;
  onDecision: (value: string) => void;
  onReason: (value: string) => void;
  onRecord: (value: boolean) => void;
  onApprove: () => void;
  onReturn: () => void;
}) {
  const canReview = task.status === "review";
  return (
    <>
      <div className="detail-head">
        <div>
          <div className="quiet">
            {task.id} · {roleName}
          </div>
          <h1>{task.title}</h1>
        </div>
        <span className="pill">{labels[task.status]}</span>
      </div>
      <div className="detail-body">
        <div className="section">
          <h3>目标</h3>
          <p>{task.goal}</p>
        </div>
        <div className="section">
          <h3>验收</h3>
          <ul>
            {task.acceptance.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="section">
          <h3>产出</h3>
          {task.artifacts.length === 0 ? <p className="empty">还没有产出</p> : null}
          {task.artifacts.map((item) => (
            <code className="path" key={item}>
              {item}
            </code>
          ))}
        </div>
        <div className="section">
          <h3>记录</h3>
          <p className="notes">{task.notes || "还没有记录"}</p>
          {task.blockReason ? <p>阻塞：{task.blockReason}</p> : null}
          {task.decision ? <p>结论：{task.decision}</p> : null}
          {canReview ? (
            <>
              <input
                className="field"
                value={decision}
                onChange={(event) => onDecision(event.target.value)}
                placeholder="批准时写一句结论"
                aria-label="批准时写一句结论"
              />
              <label className="check">
                <input type="checkbox" checked={record} onChange={(event) => onRecord(event.target.checked)} />
                记入决策
              </label>
              <input
                className="field"
                value={reason}
                onChange={(event) => onReason(event.target.value)}
                placeholder="退回时写原因"
                aria-label="退回原因"
              />
            </>
          ) : null}
        </div>
      </div>
      <div className="actions">
        <button className="primary" type="button" disabled={!canReview || pending} onClick={onApprove}>
          批准
        </button>
        <button className="ghost" type="button" disabled={!canReview || pending} onClick={onReturn}>
          退回
        </button>
      </div>
    </>
  );
}
