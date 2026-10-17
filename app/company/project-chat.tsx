"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ProjectEvent as SavedProjectEvent } from "@/lib/domain/collaboration";
import type { ProjectWorkflowSummary } from "@/lib/application/collaboration";
import type { ProjectEvent as LiveProjectEvent } from "@/lib/application/org";
import type { ProjectMessageProcessingEvent } from "@/lib/application/project-message";
import { splitReply } from "@/lib/employees/message-text";
import { groupProjectTimeline } from "@/lib/domain/project-timeline";
import { projectEventCursor } from "@/lib/domain/project-chat-state";
import { gsap, useGSAP } from "../components/gsap";
import { ProjectHeader } from "./project-header";
import { WorkflowChangesPanel, type ChangeTotals } from "./workflow-changes";

type LiveTurn = { roleId: string; name: string; thinking: string; reply: string; done: boolean };

export function ProjectChat({
  companyId,
  companyName,
  projectId,
  projectName,
  members,
  initialEvents,
  initialWorkflows,
}: {
  companyId: string;
  companyName: string;
  projectId: string;
  projectName: string;
  members: { id: string; name: string }[];
  initialEvents: SavedProjectEvent[];
  initialWorkflows: ProjectWorkflowSummary[];
}) {
  const router = useRouter();
  const layoutRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const lastEventId = useRef(projectEventCursor(initialEvents));
  const [events, setEvents] = useState(initialEvents);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"auto" | "conversation" | "task">("auto");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [mine, setMine] = useState<string | null>(null);
  const [lives, setLives] = useState<LiveTurn[]>([]);
  const [routeNotice, setRouteNotice] = useState("");
  const [changesOpen, setChangesOpen] = useState(false);
  const [panelSize, setPanelSize] = useState(50);
  const [stacked, setStacked] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [changeTotals, setChangeTotals] = useState<ChangeTotals>({ files: 0, additions: 0, deletions: 0 });
  const timelineItems = useMemo(() => groupProjectTimeline(events), [events]);
  const resolvedDecisionIds = useMemo(
    () =>
      new Set(
        events
          .filter((event) => event.kind === "decision_resolved")
          .map((event) => eventBody(event).decisionId)
          .filter((id): id is string => typeof id === "string"),
      ),
    [events],
  );
  const latestWorkflowStatusEventIds = useMemo(() => {
    const latest = new Map<string, number>();
    for (const event of events) {
      if (event.kind === "workflow_status" && event.workflowId) latest.set(event.workflowId, event.id);
    }
    return latest;
  }, [events]);
  const latestWorkItemStatusEventIds = useMemo(() => {
    const latest = new Map<string, number>();
    for (const event of events) {
      if (event.kind === "work_item_status" && event.workItemId) latest.set(event.workItemId, event.id);
    }
    return latest;
  }, [events]);

  useEffect(() => {
    setEvents(initialEvents);
    lastEventId.current = projectEventCursor(initialEvents);
  }, [projectId, initialEvents]);

  useEffect(() => {
    const stored = Number(window.localStorage.getItem(`project-changes-size:${projectId}`));
    setPanelSize(stored >= 30 && stored <= 70 ? stored : 50);
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(`project-changes-size:${projectId}`, String(panelSize));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [panelSize, projectId]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1250px)");
    const update = () => setStacked(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const source = new EventSource(`/api/projects/${projectId}/stream?after=${lastEventId.current}`);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as SavedProjectEvent | { type: "error"; message: string };
      if ("type" in event && event.type === "error") {
        setError(event.message);
        return;
      }
      const saved = event as SavedProjectEvent;
      lastEventId.current = Math.max(lastEventId.current, saved.id);
      setEvents((current) =>
        current.some((item) => item.id === saved.id) ? current : [...current, saved],
      );
    };
    return () => source.close();
  }, [projectId]);

  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [events, mine, lives]);

  function applyLive(event: ProjectMessageProcessingEvent) {
    if (event.type === "route") {
      const label =
        event.route.intent.type === "new_workflow"
          ? "识别为任务"
          : event.route.intent.type === "workflow_input"
            ? "补充到进行中任务"
            : "识别为交流";
      setRouteNotice(`${label} · ${event.route.reason}`);
    } else if (event.type === "workflow") {
      setRouteNotice(`协作任务已创建 · ${event.title}`);
    } else {
      applyEmployeeEvent(event);
    }
  }

  function applyEmployeeEvent(event: LiveProjectEvent) {
    if (event.type === "start") {
      setLives((current) => [
        ...current.map((turn) => ({ ...turn, done: true })),
        { roleId: event.roleId, name: event.name, thinking: "", reply: "", done: false },
      ]);
    } else if (event.type === "thinking") {
      setLives((current) =>
        current.map((turn) =>
          turn.roleId === event.roleId ? { ...turn, thinking: turn.thinking + event.delta } : turn,
        ),
      );
    } else if (event.type === "reply") {
      setLives((current) =>
        current.map((turn) =>
          turn.roleId === event.roleId ? { ...turn, reply: turn.reply + event.delta } : turn,
        ),
      );
    } else if (event.type === "error") {
      setError(event.message);
    }
  }

  async function refreshTimeline() {
    const response = await fetch(`/api/projects/${projectId}/events?limit=500`, { cache: "no-store" });
    const payload = (await response.json()) as SavedProjectEvent[] & { error?: string };
    if (!response.ok) throw new Error(payload.error || "没有读到项目事件");
    setEvents(payload);
    lastEventId.current = projectEventCursor(payload);
  }

  async function send() {
    const message = text.trim();
    if (!message || pending) return;
    setPending(true);
    setError("");
    setRouteNotice("");
    setMine(message);
    setLives([]);
    setText("");
    try {
      const response = await fetch(`/api/projects/${projectId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: message, override: mode === "auto" ? undefined : mode }),
      });
      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || "没有完成");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((item) => item.startsWith("data:"));
          if (line) applyLive(JSON.parse(line.slice(5).trim()) as ProjectMessageProcessingEvent);
        }
      }
      setLives((current) => current.map((turn) => ({ ...turn, done: true })));
      await refreshTimeline();
      setMine(null);
      setLives([]);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "没有完成");
    } finally {
      setPending(false);
    }
  }

  function resizeAt(clientX: number, clientY: number) {
    const bounds = layoutRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const value = stacked
      ? ((bounds.bottom - clientY) / bounds.height) * 100
      : ((bounds.right - clientX) / bounds.width) * 100;
    setPanelSize(Math.round(Math.max(30, Math.min(70, value))));
  }

  function resizeWithKey(key: string): boolean {
    const grow = stacked ? key === "ArrowUp" : key === "ArrowLeft";
    const shrink = stacked ? key === "ArrowDown" : key === "ArrowRight";
    if (key === "Home") setPanelSize(30);
    else if (key === "End") setPanelSize(70);
    else if (grow) setPanelSize((size) => Math.min(70, size + 5));
    else if (shrink) setPanelSize((size) => Math.max(30, size - 5));
    else return false;
    return true;
  }

  return (
    <div className="chat">
      <ProjectHeader
        companyId={companyId}
        companyName={companyName}
        projectId={projectId}
        projectName={projectName}
        view="chat"
        changesToggle={
          <button
            type="button"
            className={`changes-toggle${changesOpen ? " active" : ""}`}
            onClick={() => setChangesOpen((open) => !open)}
            aria-expanded={changesOpen}
            aria-label={`${changeTotals.files} 个文件变更，${changesOpen ? "隐藏变更" : "查看变更"}`}
          >
            {changeTotals.files} 个文件变更 <span className="diff-add">+{changeTotals.additions}</span> <span className="diff-remove">-{changeTotals.deletions}</span>
          </button>
        }
      />
      <div
        ref={layoutRef}
        className={`project-chat-layout${changesOpen ? " changes-open" : ""}${resizing ? " resizing" : ""}`}
        style={{ "--changes-pane-size": `${panelSize}%` } as CSSProperties}
      >
      <div className="chat-live">
      <div className="thread" ref={threadRef}>
        {events.length === 0 && !mine ? <p className="empty">还没有项目事件。下面写一句话。</p> : null}
        {timelineItems.map((item) => {
          if (item.type === "tools") {
            return <ToolActivity key={`tools-${item.id}`} events={item.events} members={members} />;
          }
          const event = item.event;
          const body = eventBody(event);
          const decisionId = typeof body.decisionId === "string" ? body.decisionId : "";
          const resolved = decisionId ? resolvedDecisionIds.has(decisionId) : false;
          const isCurrentWorkflowStatus = Boolean(
            event.workflowId && latestWorkflowStatusEventIds.get(event.workflowId) === event.id,
          );
          const isCurrentWorkItemStatus = Boolean(
            event.workItemId && latestWorkItemStatusEventIds.get(event.workItemId) === event.id,
          );
          return (
            <TimelineEvent
              key={event.id}
              event={event}
              members={members}
              decisionResolved={resolved}
              isCurrentWorkflowStatus={isCurrentWorkflowStatus}
              isCurrentWorkItemStatus={isCurrentWorkItemStatus}
            />
          );
        })}
        {mine ? <Turn name="你" you thinking="" reply={mine} animate /> : null}
        {lives.map((turn) => (
          <Turn
            key={turn.roleId}
            name={turn.name}
            you={false}
            thinking={turn.thinking}
            reply={turn.reply}
            live
            done={turn.done}
            animate
          />
        ))}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="composer-box">
          <select
            className="message-mode"
            aria-label="消息类型"
            value={mode}
            onChange={(event) => setMode(event.target.value as typeof mode)}
            disabled={pending}
          >
            <option value="auto">自动</option>
            <option value="conversation">交流</option>
            <option value="task">任务</option>
          </select>
          <textarea
            rows={2}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (!pending && text.trim()) event.currentTarget.form?.requestSubmit();
            }}
            placeholder="写给这个项目"
            aria-label="项目群聊"
          />
          <button className="send" type="submit" disabled={pending || !text.trim()}>
            {pending ? "处理中" : "发送"}
          </button>
        </div>
        {routeNotice ? <p className="route-notice">{routeNotice}</p> : null}
        {error ? <p className="alert">{error}</p> : null}
      </form>
      </div>
      <div
        className="changes-resizer"
        role="separator"
        tabIndex={changesOpen ? 0 : -1}
        aria-hidden={!changesOpen}
        inert={!changesOpen}
        aria-label="调整变更区域大小"
        aria-orientation={stacked ? "horizontal" : "vertical"}
        aria-valuemin={30}
        aria-valuemax={70}
        aria-valuenow={panelSize}
        aria-valuetext={`变更区域 ${panelSize}%`}
        title="拖动调整区域大小，双击恢复一半"
        onPointerDown={(event) => {
          if (!changesOpen || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setResizing(true);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeAt(event.clientX, event.clientY);
        }}
        onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        onLostPointerCapture={() => setResizing(false)}
        onDoubleClick={() => setPanelSize(50)}
        onKeyDown={(event) => {
          if (changesOpen && resizeWithKey(event.key)) event.preventDefault();
        }}
      />
      <WorkflowChangesPanel
        initialWorkflows={initialWorkflows}
        events={events}
        open={changesOpen}
        onClose={() => setChangesOpen(false)}
        onTotalsChange={setChangeTotals}
      />
      </div>
    </div>
  );
}
function eventBody(event: SavedProjectEvent): Record<string, unknown> {
  return event.body !== null && typeof event.body === "object" ? (event.body as Record<string, unknown>) : {};
}

const timelineStatusLabels: Record<string, string> = {
  intake: "正在接收任务",
  planning: "正在拆分工作",
  collaborating: "团队正在执行",
  waiting_user: "等待你的决定",
  verifying: "正在汇总验证",
  review: "等待验收",
  applying: "正在应用修改",
  approved: "已经批准",
  returned: "已退回修改",
  failed: "执行失败",
  cancelled: "已取消",
  queued: "等待执行",
  ready: "准备执行",
  running: "正在执行",
  blocked: "执行受阻",
  done: "已经完成",
};

const toolLabels: Record<string, string> = {
  list_files: "查看项目文件",
  read_file: "读取文件",
  write_file: "暂存文件修改",
  run_validation: "运行验证",
  request_decision: "请求决策",
};

function TimelineEvent({
  event,
  members,
  decisionResolved,
  isCurrentWorkflowStatus,
  isCurrentWorkItemStatus,
}: {
  event: SavedProjectEvent;
  members: { id: string; name: string }[];
  decisionResolved: boolean;
  isCurrentWorkflowStatus: boolean;
  isCurrentWorkItemStatus: boolean;
}) {
  const body = eventBody(event);
  if (body.hidden === true) return null;
  const memberName = members.find((member) => member.id === event.actorId)?.name;
  const name = memberName ?? event.actorId ?? "系统";
  if (event.kind === "user_message" || event.kind === "agent_message") {
    const raw = typeof body.text === "string" ? body.text : "";
    const parts = splitReply(raw);
    const reply = parts.answer || (parts.reasoning ? "" : raw);
    const route = body.route !== null && typeof body.route === "object" ? (body.route as Record<string, unknown>) : null;
    return (
      <Turn
        name={event.kind === "user_message" ? "你" : name}
        you={event.kind === "user_message"}
        thinking=""
        reply={reply}
        badge={
          route?.type === "new_workflow"
            ? "任务"
            : route?.type === "workflow_input"
              ? "补充"
              : route?.type === "conversation"
                ? "交流"
                : undefined
        }
      />
    );
  }
  if (event.kind === "workflow_created") {
    const legacyRunId = typeof body.legacyRunId === "string" ? body.legacyRunId : "";
    return (
      <SystemLine
        title={legacyRunId ? "旧执行任务" : "协作任务已创建"}
        text={String(body.title ?? body.requestText ?? "等待协调员工拆分工作")}
      />
    );
  }
  if (event.kind === "work_item_created") {
    const ownerId = String(body.ownerRoleId ?? "");
    const reviewerId = String(body.reviewerRoleId ?? "");
    const owner = members.find((member) => member.id === ownerId)?.name ?? (ownerId || "待分配");
    const reviewer = members.find((member) => member.id === reviewerId)?.name ?? reviewerId;
    return (
      <SystemLine
        title={`${owner} · 工作安排`}
        text={`${String(body.title ?? "未命名")}${reviewer ? ` · ${reviewer}复核` : ""}`}
      />
    );
  }
  if (event.kind === "work_item_status" || event.kind === "workflow_status") {
    const status = String(body.status ?? "");
    if (event.kind === "workflow_status" && status === "failed" && isCurrentWorkflowStatus && event.workflowId) {
      return <WorkflowRetryCard workflowId={event.workflowId} />;
    }
    const detail = typeof body.detail === "string" ? body.detail : timelineStatusLabels[status] ?? (status || "已更新");
    const title = event.kind === "workflow_status" ? "协作状态" : memberName ? `${memberName} · 工作进度` : "工作项状态";
    return (
      <SystemLine
        title={title}
        text={detail}
        active={event.kind === "work_item_status" && isCurrentWorkItemStatus && status === "running"}
      />
    );
  }
  if (event.kind === "tool_call" || event.kind === "tool_result") {
    const value = body.value !== null && typeof body.value === "object" ? (body.value as Record<string, unknown>) : body;
    const failed = event.kind === "tool_result" && value.ok === false;
    return (
      <SystemLine
        title={event.kind === "tool_call" ? "使用工具" : failed ? "工具失败" : "工具完成"}
        text={String(value.name ?? "工具")}
        tone={failed ? "error" : "tool"}
      />
    );
  }
  if (event.kind === "handoff") {
    const fromId = String(body.fromRoleId ?? "");
    const toId = String(body.toRoleId ?? "");
    const from = members.find((member) => member.id === fromId)?.name ?? fromId;
    const to = members.find((member) => member.id === toId)?.name ?? toId;
    return <SystemLine title={`${from} · 工作交接`} text={`${from} → ${to}`} />;
  }
  if (event.kind === "review_submitted") {
    if (event.workItemId === null && event.workflowId) {
      return <WorkflowReviewCard workflowId={event.workflowId} />;
    }
    return <SystemLine title={`${name} · 提交验收`} text={String(body.summary ?? "等待验收")} />;
  }
  if (event.kind === "decision_requested") {
    return <DecisionCard body={body} resolved={decisionResolved} />;
  }
  if (event.kind === "decision_resolved") {
    return <SystemLine title="老板已决定" text={String(body.answer ?? "已解决")} />;
  }
  if (event.kind === "error") return <p className="alert">{String(body.message ?? "发生错误")}</p>;
  return <SystemLine title="项目更新" text={event.kind} />;
}

type WorkflowReviewView = {
  workflow: { id: string; taskId: string | null; status: string; title: string; summary: string };
  items: {
    id: string;
    title: string;
    objective: string;
    acceptance: string[];
    status: string;
    summary: string;
    evidence: string[];
  }[];
  files: { path: string; operation: "create" | "update"; diff: string; afterSize: number }[];
};

const workflowStatusLabels: Record<string, string> = {
  review: "待验收",
  approved: "已批准",
  returned: "已退回",
  failed: "失败",
};

const workItemStatusLabels: Record<string, string> = {
  review: "待复核",
  done: "已完成",
  running: "执行中",
  blocked: "已阻塞",
  failed: "失败",
};

function WorkflowReviewCard({ workflowId }: { workflowId: string }) {
  const router = useRouter();
  const [view, setView] = useState<WorkflowReviewView | null>(null);
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState("");
  const [record, setRecord] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch(`/api/workflows/${workflowId}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as WorkflowReviewView & { error?: string };
        if (!response.ok) throw new Error(payload.error || "没有读到验收详情");
        if (active) setView(payload);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "没有读到验收详情");
      });
    return () => {
      active = false;
    };
  }, [workflowId]);

  async function action(kind: "approve" | "return") {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/workflows/${workflowId}/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(kind === "return" ? { reason } : { decision, record }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "没有完成验收动作");
      const refreshed = await fetch(`/api/workflows/${workflowId}`, { cache: "no-store" });
      if (refreshed.ok) setView((await refreshed.json()) as WorkflowReviewView);
      setReason("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "没有完成验收动作");
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="workflow-review-card">
      <header className="workflow-review-head">
        <div>
          <span className="workflow-review-kicker">工作验收</span>
          <h3>{view?.workflow.title ?? "读取验收内容"}</h3>
          {view ? <small>{view.items.length} 个工作项 · {view.files.length} 个文件改动</small> : null}
        </div>
        <span className={`workflow-review-status status-${view?.workflow.status ?? "loading"}`}>
          {view ? workflowStatusLabels[view.workflow.status] ?? view.workflow.status : "读取中"}
        </span>
      </header>
      {view ? (
        <>
          <details className="workflow-review-section workflow-review-summary" open>
            <summary>
              <strong>完成摘要</strong>
              <span>{view.workflow.summary.length} 字</span>
            </summary>
            <div className="workflow-review-summary-scroll">
              <MarkdownContent text={view.workflow.summary} />
            </div>
          </details>

          <details className="workflow-review-section">
            <summary>
              <strong>工作项</strong>
              <span>{view.items.length} 项</span>
            </summary>
            <div className="workflow-review-items">
              {view.items.map((item) => (
                <details className="workflow-review-item" key={item.id}>
                  <summary>
                    <span>{item.title}</span>
                    <small>{workItemStatusLabels[item.status] ?? item.status}</small>
                  </summary>
                  <div className="workflow-review-item-body">
                    <p>{item.objective}</p>
                    <div className="workflow-review-checks">
                      <div>
                        <strong>验收标准</strong>
                        <ul>{item.acceptance.map((entry) => <li key={entry}>{entry}</li>)}</ul>
                      </div>
                      <div>
                        <strong>实际证据</strong>
                        {item.evidence.length ? (
                          <ul>{item.evidence.map((entry) => <li key={entry}>{entry}</li>)}</ul>
                        ) : (
                          <p>暂无证据</p>
                        )}
                      </div>
                    </div>
                  </div>
                </details>
              ))}
            </div>
          </details>

          <details className="workflow-review-section">
            <summary>
              <strong>文件改动</strong>
              <span>{view.files.length} 个</span>
            </summary>
            <div className="workflow-review-files">
              {view.files.length === 0 ? <p>没有文件修改</p> : null}
              {view.files.map((file) => (
                <details key={file.path}>
                  <summary>
                    <span>{file.operation === "create" ? "新建" : "修改"}</span>
                    <code>{file.path}</code>
                    <small>{file.afterSize} B</small>
                  </summary>
                  <pre>{file.diff}</pre>
                </details>
              ))}
            </div>
          </details>

          {view.workflow.status === "review" ? (
            <div className="workflow-review-actions">
              <div className="workflow-review-approve">
                {view.workflow.taskId ? (
                  <div className="workflow-review-decision">
                    <input
                      value={decision}
                      onChange={(event) => setDecision(event.target.value)}
                      placeholder="批准结论"
                      aria-label="协作任务批准结论"
                      disabled={pending}
                    />
                    <label className="check">
                      <input type="checkbox" checked={record} onChange={(event) => setRecord(event.target.checked)} />
                      记入决策
                    </label>
                  </div>
                ) : null}
                <button
                  className="primary"
                  type="button"
                  disabled={pending || Boolean(view.workflow.taskId && !decision.trim())}
                  onClick={() => void action("approve")}
                >
                  {pending ? "处理中" : `批准并应用 ${view.files.length} 个文件`}
                </button>
              </div>
              <div className="workflow-review-return">
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="填写原因后退回修改"
                  aria-label="协作任务退回原因"
                  disabled={pending}
                />
                <button className="ghost" type="button" disabled={pending || !reason.trim()} onClick={() => void action("return")}>
                  退回
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {error ? <p className="alert">{error}</p> : null}
    </article>
  );
}

function DecisionCard({ body, resolved }: { body: Record<string, unknown>; resolved: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const decisionId = String(body.decisionId ?? "");
  const options = Array.isArray(body.options)
    ? (body.options as { id?: unknown; label?: unknown; impact?: unknown }[])
    : [];
  const recommendationId = String(body.recommendation ?? "");
  const recommendation = options.find((option) => String(option.id) === recommendationId);

  async function resolve(answer: string) {
    if (pending || resolved) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/decisions/${decisionId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "没有解决待决问题");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "没有解决待决问题");
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="decision-card">
      <div className="decision-head">
        <strong>{resolved ? "待决问题已解决" : "需要你决定"}</strong>
        {recommendation ? <span>团队推荐：{String(recommendation.label)}</span> : null}
      </div>
      <p>{String(body.question ?? "")}</p>
      {body.reason ? <small>{String(body.reason)}</small> : null}
      <div className="decision-options">
        {options.map((option) => (
          <button
            className="ghost"
            type="button"
            key={String(option.id)}
            disabled={pending || resolved}
            onClick={() => void resolve(`${String(option.id)}：${String(option.label)}`)}
          >
            <strong>{String(option.label)}</strong>
            <span>{String(option.impact)}</span>
          </button>
        ))}
      </div>
      {error ? <p className="alert">{error}</p> : null}
    </article>
  );
}

function WorkflowRetryCard({ workflowId }: { workflowId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function retry() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/workflows/${workflowId}/retry`, { method: "POST" });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "没有重新启动协作任务");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "没有重新启动协作任务");
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="workflow-retry-card">
      <div>
        <strong>协作已停止</strong>
        <p>可以重试失败工作项，已完成的工作不会重做。</p>
      </div>
      <button className="primary" type="button" disabled={pending} onClick={() => void retry()}>
        {pending ? "正在重试" : "重试协作"}
      </button>
      {error ? <p className="alert">{error}</p> : null}
    </article>
  );
}
function SystemLine({
  title,
  text,
  tone = "default",
  active = false,
}: {
  title: string;
  text: string;
  tone?: "default" | "tool" | "error";
  active?: boolean;
}) {
  const lineRef = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (!active || !lineRef.current) return;
      const media = gsap.matchMedia();
      media.add(
        { reduceMotion: "(prefers-reduced-motion: reduce)" },
        (context) => {
          if (context.conditions?.reduceMotion) {
            gsap.set(".timeline-mark, .timeline-thinking-dot", { autoAlpha: 1, scale: 1, y: 0 });
            return;
          }
          gsap.to(".timeline-mark", {
            autoAlpha: 0.35,
            scale: 1.7,
            duration: 0.72,
            ease: "sine.inOut",
            repeat: -1,
            yoyo: true,
          });
          gsap.fromTo(
            ".timeline-thinking-dot",
            { autoAlpha: 0.25, y: 0 },
            {
              autoAlpha: 1,
              y: -2,
              duration: 0.42,
              ease: "sine.inOut",
              stagger: 0.12,
              repeat: -1,
              yoyo: true,
            },
          );
        },
      );
      return () => media.revert();
    },
    { dependencies: [active], scope: lineRef, revertOnUpdate: true },
  );

  return (
    <article className={`timeline-system timeline-${tone}${active ? " timeline-active" : ""}`} ref={lineRef}>
      <span className="timeline-mark" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>
          {text}
          {active ? (
            <span className="timeline-thinking" aria-label="员工仍在工作">
              思考中
              <i className="timeline-thinking-dot" />
              <i className="timeline-thinking-dot" />
              <i className="timeline-thinking-dot" />
            </span>
          ) : null}
        </p>
      </div>
    </article>
  );
}

function ToolActivity({
  events,
  members,
}: {
  events: SavedProjectEvent[];
  members: { id: string; name: string }[];
}) {
  const rows: { id: number; callId: string; name: string; status: "running" | "done" | "failed" }[] = [];
  for (const event of events) {
    const body = eventBody(event);
    const value = body.value !== null && typeof body.value === "object" ? (body.value as Record<string, unknown>) : body;
    const name = String(value.name ?? "工具");
    const callId = String(value.id ?? "");
    if (event.kind === "tool_call") {
      rows.push({ id: event.id, callId, name, status: "running" });
      continue;
    }
    const pending = [...rows]
      .reverse()
      .find((row) => row.status === "running" && (callId ? row.callId === callId : row.name === name));
    if (pending) pending.status = value.ok === false ? "failed" : "done";
    else rows.push({ id: event.id, callId, name, status: value.ok === false ? "failed" : "done" });
  }
  const failed = rows.filter((row) => row.status === "failed").length;
  const running = rows.some((row) => row.status === "running");
  const actorId = events[0]?.actorId ?? "";
  const actorName = members.find((member) => member.id === actorId)?.name ?? (actorId || "员工");
  return (
    <details className={`tool-activity${failed ? " tool-activity-failed" : ""}`} open={running || undefined}>
      <summary>
        <span className="tool-chevron" aria-hidden="true">›</span>
        <strong>{actorName} · 工具活动</strong>
        <span>{rows.length} 次</span>
        {failed ? <span className="tool-failed-count">{failed} 次失败</span> : null}
      </summary>
      <div className="tool-activity-list">
        {rows.map((row) => (
          <div key={row.id}>
            <span className={`tool-status tool-status-${row.status}`} aria-hidden="true" />
            <span className="tool-name" title={row.name}>{toolLabels[row.name] ?? row.name}</span>
            <span>{row.status === "failed" ? "失败" : row.status === "done" ? "完成" : "运行中"}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
function Turn({
  name,
  you,
  thinking,
  reply,
  live = false,
  done = false,
  animate = false,
  badge,
}: {
  name: string;
  you: boolean;
  thinking: string;
  reply: string;
  live?: boolean;
  done?: boolean;
  animate?: boolean;
  badge?: string;
}) {
  const streaming = live && !done;
  const thinkingNow = streaming && !reply;
  return (
    <article className={`${you ? "turn turn-you" : "turn turn-agent"}${animate ? " turn-enter" : ""}`}>
      <div className="turn-name">
        {name}
        {badge ? <span className="intent-badge">{badge}</span> : null}
      </div>
      <div className="turn-content">
        {thinking || thinkingNow ? (
          <details className="thinking" key={streaming ? "streaming" : "settled"} open={streaming || undefined}>
            <summary>{thinkingNow ? "正在思考" : "思考"}</summary>
            <p>
              {thinking}
              {thinkingNow ? <span className="caret" /> : null}
            </p>
          </details>
        ) : null}
        {reply ? (
          <div>
            <MarkdownContent text={reply} />
            {streaming ? <span className="caret" /> : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children }) => (
            <div className="markdown-table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
