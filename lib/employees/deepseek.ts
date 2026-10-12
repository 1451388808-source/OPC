const endpoint = "https://api.deepseek.com/chat/completions";

export const deepseekProvider = "deepseek";
export const deepseekModel = "deepseek-flash";

type ChatResponse = {
  choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
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
