import type { EmployeeToolDefinition, EmployeeToolset } from "./tools";
import { ToolExecutionError, toolFailureFromUnknown, type ToolFailure } from "../mcp/error.ts";

export type ToolModelCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ToolModelTurn = {
  text: string;
  reasoning: string;
  toolCalls: ToolModelCall[];
};

export type ToolModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; reasoning: string; toolCalls: ToolModelCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolCallingModel {
  complete(input: {
    model: string;
    messages: ToolModelMessage[];
    tools: EmployeeToolDefinition[];
    signal: AbortSignal;
    onReasoningDelta: (delta: string) => Promise<void>;
    onTextDelta: (delta: string) => Promise<void>;
  }): Promise<ToolModelTurn>;
}

export type ToolLoopEvent = {
  kind: "reasoning" | "tool_call" | "tool_result" | "message" | "error";
  body: unknown;
};

export type ToolLoopLimits = {
  maxRounds?: number;
  maxToolCalls?: number;
  maxRepeatedCalls?: number;
  maxEquivalentErrors?: number;
  maxDurationMs?: number;
};

export async function executeToolLoop(input: {
  model: ToolCallingModel;
  modelName: string;
  system: string;
  user: string;
  tools: EmployeeToolset;
  emit: (event: ToolLoopEvent) => Promise<void>;
  limits?: ToolLoopLimits;
}): Promise<{ summary: string; changedPaths: string[] }> {
  const maxRounds = input.limits?.maxRounds ?? 20;
  const maxToolCalls = input.limits?.maxToolCalls ?? 50;
  const maxRepeatedCalls = input.limits?.maxRepeatedCalls ?? 3;
  const maxEquivalentErrors = input.limits?.maxEquivalentErrors ?? 3;
  const maxDurationMs = input.limits?.maxDurationMs ?? 10 * 60_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("执行超时")), maxDurationMs);
  const messages: ToolModelMessage[] = [
    { role: "system", content: input.system },
    { role: "user", content: input.user },
  ];
  let toolCallCount = 0;
  let previousSignature = "";
  let repeatedCalls = 0;
  const equivalentErrors = new Map<string, number>();

  try {
    for (let round = 0; round < maxRounds; round += 1) {
      let streamedReasoning = false;
      let streamedText = false;
      const turn = await Promise.race([
        input.model.complete({
          model: input.modelName,
          messages: [...messages],
          tools: input.tools.definitions,
          signal: controller.signal,
          onReasoningDelta: async (delta) => {
            if (!delta) return;
            streamedReasoning = true;
            await input.emit({ kind: "reasoning", body: { text: delta, delta: true } });
          },
          onTextDelta: async (delta) => {
            if (!delta) return;
            streamedText = true;
            await input.emit({ kind: "message", body: { text: delta, delta: true } });
          },
        }),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(controller.signal.reason ?? new Error("执行超时")),
            { once: true },
          );
        }),
      ]);
      messages.push({
        role: "assistant",
        content: turn.text,
        reasoning: turn.reasoning,
        toolCalls: turn.toolCalls,
      });
      if (turn.reasoning && !streamedReasoning) {
        await input.emit({ kind: "reasoning", body: { text: turn.reasoning } });
      }

      if (turn.toolCalls.length === 0) {
        const summary = turn.text.trim();
        if (!summary) throw new Error("模型没有给出完成摘要");
        if (!streamedText) await input.emit({ kind: "message", body: { text: summary } });
        return { summary, changedPaths: await input.tools.changedPaths() };
      }

      for (const call of turn.toolCalls) {
        toolCallCount += 1;
        if (toolCallCount > maxToolCalls) throw new Error(`工具调用超过 ${maxToolCalls} 次`);
        const signature = `${call.name}:${call.arguments}`;
        if (signature === previousSignature) repeatedCalls += 1;
        else repeatedCalls = 1;
        previousSignature = signature;
        if (repeatedCalls >= maxRepeatedCalls) throw new Error("连续重复相同工具调用");

        await input.emit({
          kind: "tool_call",
          body: { id: call.id, name: call.name, arguments: call.arguments },
        });
        let response: { ok: true; result: unknown } | { ok: false; error: ToolFailure };
        try {
          const parsed = JSON.parse(call.arguments) as unknown;
          response = { ok: true, result: await input.tools.execute(call.name, parsed) };
        } catch (error) {
          response = { ok: false, error: toolFailureFromUnknown(error) };
        }
        const content = JSON.stringify(response);
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
        await input.emit({ kind: "tool_result", body: { id: call.id, name: call.name, ...response } });
        if (!response.ok) {
          if (!response.error.retryable) {
            throw new ToolExecutionError(response.error);
          }
          const key = `${call.name}:${response.error.code}:${response.error.message}`;
          const count = (equivalentErrors.get(key) ?? 0) + 1;
          equivalentErrors.set(key, count);
          if (count >= maxEquivalentErrors) {
            throw new Error(
              `同类工具错误达到 ${maxEquivalentErrors} 次 [${response.error.code}]：${response.error.message}`,
            );
          }
        }
      }
    }
    throw new Error(`模型调用超过 ${maxRounds} 轮`);
  } finally {
    clearTimeout(timeout);
  }
}
