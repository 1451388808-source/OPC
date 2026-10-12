"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ChatEvent } from "@/lib/application/employees";
import { MessageBody } from "../components/message-body";

type SavedMessage = { id: number; speaker: "boss" | "employee"; body: string };
type LiveReply = { thinking: string; reply: string };

export function EmployeeChat({
  roleId,
  name,
  messages,
}: {
  roleId: string;
  name: string;
  messages: SavedMessage[];
}) {
  const router = useRouter();
  const logRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [mine, setMine] = useState<string | null>(null);
  const [live, setLive] = useState<LiveReply | null>(null);
  const [seen, setSeen] = useState(messages.length);

  if (messages.length > seen) {
    setSeen(messages.length);
    setMine(null);
    setLive(null);
  }

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, mine, live]);

  function apply(event: ChatEvent) {
    if (event.type === "thinking") {
      setLive((current) => ({ thinking: (current?.thinking ?? "") + event.delta, reply: current?.reply ?? "" }));
    } else if (event.type === "reply") {
      setLive((current) => ({ thinking: current?.thinking ?? "", reply: (current?.reply ?? "") + event.delta }));
    } else if (event.type === "error") {
      setError(event.message);
    }
  }

  return (
    <div className="chat-live">
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && !mine ? <p className="empty">还没有对话。下面写一句话。</p> : null}
        {messages.map((message) => (
          <div key={message.id} className={message.speaker === "boss" ? "bubble boss" : "bubble employee"}>
            <span className="quiet">{message.speaker === "boss" ? "你" : name}</span>
            <MessageBody body={message.body} />
          </div>
        ))}
        {mine ? (
          <div className="bubble bubble-enter boss">
            <span className="quiet">你</span>
            <p>{mine}</p>
          </div>
        ) : null}
        {live ? <LiveBubble name={name} thinking={live.thinking} reply={live.reply} /> : null}
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
          setLive({ thinking: "", reply: "" });
          setText("");
          let failed = false;
          void fetch(`/api/roles/${roleId}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: message }),
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
                  const next = JSON.parse(line.slice(5).trim()) as ChatEvent;
                  if (next.type === "error") failed = true;
                  apply(next);
                }
              }
              await router.refresh();
              if (failed) {
                setMine(null);
                setLive(null);
              }
            })
            .catch((caught: unknown) => {
              setMine(null);
              setLive(null);
              setText(message);
              setError(caught instanceof Error ? caught.message : "没有完成");
            })
            .finally(() => setPending(false));
        }}
      >
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
            placeholder="跟这位员工说一句话"
            aria-label="对话"
          />
          <button className="send" type="submit" disabled={pending}>
            {pending ? "正在回复" : "发送"}
          </button>
        </div>
        {error ? <p className="alert">{error}</p> : null}
      </form>
    </div>
  );
}

function LiveBubble({ name, thinking, reply }: { name: string; thinking: string; reply: string }) {
  const thinkingNow = !reply;
  return (
    <div className="bubble bubble-enter employee">
      <span className="quiet">{name}</span>
      {thinking || thinkingNow ? (
        <details className="thinking" open>
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
          <span className="caret" />
        </p>
      ) : null}
    </div>
  );
}
