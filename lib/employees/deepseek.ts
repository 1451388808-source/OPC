import type {
  ToolCallingModel,
  ToolModelMessage,
  ToolModelTurn,
} from "./tool-loop";

const endpoint = "https://api.deepseek.com/chat/completions";

export const deepseekProvider = "deepseek";
export const deepseekModel = "deepseek-flash";

type ChatResponse = {
  choices?: {
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  error?: { message?: string };
};

export type DeepSeekReply = {
  text: string;
  reasoning: string;
};

export type DeepSeekDelta = {
  text?: string;
  reasoning?: string;
};

export async function streamDeepSeek(
  input: { model: string; system: string; user: string },
  onDelta: (delta: DeepSeekDelta) => void,
): Promise<DeepSeekReply> {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new Error("还没有配置 DeepSeek 密钥");

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        thinking: { type: "enabled" },
        reasoning_effort: "high",
        stream: true,
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    throw new Error("DeepSeek 没有连上");
  }

  if (!response.ok || !response.body) {
    let detail = "";
    try {
      const payload = (await response.json()) as ChatResponse;
      detail = payload.error?.message?.trim() ?? "";
    } catch {
      detail = "";
    }
    throw new Error(detail ? `DeepSeek 拒绝了这次调用：${detail}` : "DeepSeek 拒绝了这次调用");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let payload: {
        choices?: { delta?: { content?: string | null; reasoning_content?: string | null } }[];
      };
      try {
        payload = JSON.parse(data) as typeof payload;
      } catch {
        continue;
      }
      const delta = payload.choices?.[0]?.delta;
      const nextReasoning = delta?.reasoning_content ?? "";
      const nextText = delta?.content ?? "";
      if (nextReasoning) {
        reasoning += nextReasoning;
        onDelta({ reasoning: nextReasoning });
      }
      if (nextText) {
        text += nextText;
        onDelta({ text: nextText });
      }
    }
  }
  return { text: text.trim(), reasoning: reasoning.trim() };
}

export async function callDeepSeek(input: { model: string; system: string; user: string }): Promise<DeepSeekReply> {
  const result = await streamDeepSeek(input, () => {});
  if (!result.text && !result.reasoning) throw new Error("DeepSeek 没有给出回复");
  return result;
}

function deepSeekMessage(message: ToolModelMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (!("toolCalls" in message)) return message;
  return {
    role: "assistant",
    content: message.content || null,
    reasoning_content: message.reasoning || null,
    tool_calls: message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    })),
  };
}

export async function completeDeepSeekToolTurn(input: {
  model: string;
  messages: ToolModelMessage[];
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  signal: AbortSignal;
  onReasoningDelta: (delta: string) => Promise<void>;
  onTextDelta: (delta: string) => Promise<void>;
}): Promise<ToolModelTurn> {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new Error("还没有配置 DeepSeek 密钥");
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages.map(deepSeekMessage),
        tools: input.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
        tool_choice: "auto",
        thinking: { type: "enabled" },
        reasoning_effort: "high",
        stream: true,
      }),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason ?? new Error("执行超时");
    throw new Error("DeepSeek 没有连上", { cause: error });
  }
  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => ({}))) as ChatResponse;
    const detail = payload.error?.message?.trim() ?? "";
    throw new Error(detail ? `DeepSeek 拒绝了这次调用：${detail}` : "DeepSeek 拒绝了这次调用");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  const reasoningBatch = deltaBatch(input.onReasoningDelta);
  const textBatch = deltaBatch(input.onTextDelta);
  let buffer = "";
  let text = "";
  let reasoning = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let payload: {
        choices?: {
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
        }[];
      };
      try {
        payload = JSON.parse(data) as typeof payload;
      } catch {
        continue;
      }
      const delta = payload.choices?.[0]?.delta;
      const nextReasoning = delta?.reasoning_content ?? "";
      const nextText = delta?.content ?? "";
      if (nextReasoning) {
        reasoning += nextReasoning;
        await reasoningBatch.push(nextReasoning);
      }
      if (nextText) {
        text += nextText;
        await textBatch.push(nextText);
      }
      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name = call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        toolCalls.set(index, current);
      }
    }
  }
  await reasoningBatch.flush();
  await textBatch.flush();
  if (!text && !reasoning && toolCalls.size === 0) throw new Error("DeepSeek 没有给出回复");
  return {
    text: text.trim(),
    reasoning: reasoning.trim(),
    toolCalls: [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, call]) => ({
        id: call.id || `tool-${index + 1}`,
        name: call.name,
        arguments: call.arguments || "{}",
      })),
  };
}

export const deepSeekToolModel: ToolCallingModel = {
  complete: completeDeepSeekToolTurn,
};

function deltaBatch(emit: (delta: string) => Promise<void>) {
  let pending = "";
  return {
    async push(delta: string) {
      pending += delta;
      if (pending.length >= 32 || /[\n。！？.!?]$/.test(pending)) await this.flush();
    },
    async flush() {
      if (!pending) return;
      const current = pending;
      pending = "";
      await emit(current);
    },
  };
}
