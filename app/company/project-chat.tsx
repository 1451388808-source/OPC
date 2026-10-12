"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ProjectEvent } from "@/lib/application/org";
import { splitReply } from "@/lib/employees/message-text";

type SavedMessage = { id: number; name: string; body: string; you: boolean };
type LiveTurn = { roleId: string; name: string; thinking: string; reply: string; done: boolean };

export function ProjectChat({
  projectId,
  members,
  messages,
}: {
  projectId: string;
  members: { id: string; name: string }[];
  messages: SavedMessage[];
}) {
  const router = useRouter();
  const threadRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [roleId, setRoleId] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [mine, setMine] = useState<string | null>(null);
  const [lives, setLives] = useState<LiveTurn[]>([]);

  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [messages, mine, lives]);

  function apply(event: ProjectEvent) {
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
        current.map((turn) => (turn.roleId === event.roleId ? { ...turn, reply: turn.reply + event.delta } : turn)),
      );
    } else if (event.type === "error") {
      setError(event.message);
    }
  }

  return (
    <div className="chat-live">
      <div className="thread" ref={threadRef}>
        {messages.length === 0 && !mine ? <p className="empty">还没有对话。写一句话，项目里的员工都从这里接着看。</p> : null}
        {messages.map((message) => {
          const parts = splitReply(message.body);
          const reply = parts.answer || (parts.reasoning ? "" : message.body);
          return <Turn key={message.id} name={message.name} you={message.you} thinking={parts.reasoning} reply={reply} />;
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
          const message = text.trim();
          if (!message || pending) return;
          setPending(true);
          setError("");
          setMine(message);
          setLives([]);
          setText("");
          const asked = roleId;
          void fetch(`/api/projects/${projectId}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: message, roleId: asked }),
          })
            .then(async (response) => {
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
                  if (!line) continue;
                  apply(JSON.parse(line.slice(5).trim()) as ProjectEvent);
                }
              }
              setLives((current) => current.map((turn) => ({ ...turn, done: true })));
              await router.refresh();
            })
            .catch((caught: unknown) => {
              setMine(null);
              setLives([]);
              setError(caught instanceof Error ? caught.message : "没有完成");
            })
            .finally(() => setPending(false));
        }}
      >
        <label className="ask">
          谁来接话
          <select aria-label="谁来接话" value={roleId} onChange={(event) => setRoleId(event.target.value)}>
            <option value="">在场的人都接话</option>
            {members.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <div className="composer-box">
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
            aria-label="项目对话"
          />
          <button className="send" type="submit" disabled={pending}>
            {pending ? "正在接话" : "发送"}
          </button>
        </div>
        {error ? <p className="alert">{error}</p> : null}
      </form>
    </div>
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
}: {
  name: string;
  you: boolean;
  thinking: string;
  reply: string;
  live?: boolean;
  done?: boolean;
  animate?: boolean;
}) {
  const streaming = live && !done;
  const thinkingNow = streaming && !reply;
  return (
    <article className={`${you ? "turn turn-you" : "turn"}${animate ? " turn-enter" : ""}`}>
      <div className="turn-name">{name}</div>
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
        <p>
          {reply}
          {streaming ? <span className="caret" /> : null}
        </p>
      ) : null}
    </article>
  );
}
