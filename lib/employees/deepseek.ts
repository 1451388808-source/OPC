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
        stream: false,
      }),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason ?? new Error("执行超时");
    throw new Error("DeepSeek 没有连上", { cause: error });
  }
  const payload = (await response.json().catch(() => ({}))) as ChatResponse;
  if (!response.ok) {
    const detail = payload.error?.message?.trim() ?? "";
    throw new Error(detail ? `DeepSeek 拒绝了这次调用：${detail}` : "DeepSeek 拒绝了这次调用");
  }
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error("DeepSeek 没有给出回复");
  return {
    text: message.content?.trim() ?? "",
    reasoning: message.reasoning_content?.trim() ?? "",
    toolCalls: (message.tool_calls ?? []).map((call, index) => ({
      id: call.id || `tool-${index + 1}`,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    })),
  };
}

export const deepSeekToolModel: ToolCallingModel = {
  complete: completeDeepSeekToolTurn,
};
