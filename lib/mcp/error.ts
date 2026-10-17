import { z } from "zod";
import { ReferenceResolutionError } from "../collaboration/reference-resolver.ts";

export const TOOL_FAILURE_CODES = [
  "invalid_input",
  "invalid_reference",
  "permission_denied",
  "stale_version",
  "lease_conflict",
  "missing_configuration",
  "validation_failed",
  "provider_timeout",
  "provider_rejected",
  "budget_exceeded",
  "server_unavailable",
  "internal_error",
] as const;

export type ToolFailureCode = (typeof TOOL_FAILURE_CODES)[number];

export type ToolFailure = {
  ok: false;
  code: ToolFailureCode;
  message: string;
  retryable: boolean;
  correction?: {
    allowedValues?: string[];
    expectedSchema?: unknown;
    currentSha256?: string;
  };
};

export class ToolExecutionError extends Error {
  readonly failure: ToolFailure;

  constructor(failure: Omit<ToolFailure, "ok"> | ToolFailure) {
    const normalized: ToolFailure = { ...failure, ok: false };
    super(normalized.message);
    this.name = "ToolExecutionError";
    this.failure = normalized;
  }
}

export function toolFailureFromUnknown(error: unknown): ToolFailure {
  if (error instanceof ToolExecutionError) return error.failure;
  if (error instanceof ReferenceResolutionError) {
    return {
      ok: false,
      code: "invalid_reference",
      message: error.message,
      retryable: true,
      correction: { allowedValues: error.allowedValues },
    };
  }
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      code: "invalid_input",
      message: z.prettifyError(error),
      retryable: true,
    };
  }

  const message = error instanceof Error ? error.message : "工具调用失败";
  const unknownProfile = message.match(/找不到验证配置：[^。]+。可用 profile：(.+)$/i);
  if (unknownProfile) {
    return {
      ok: false,
      code: "invalid_input",
      message,
      retryable: true,
      correction: {
        allowedValues: unknownProfile[1]!
          .split(/[、,，\s]+/)
          .map((value) => value.trim())
          .filter(Boolean),
      },
    };
  }
  if (/权限|无权|未获授权|permission|denied/i.test(message)) {
    return { ok: false, code: "permission_denied", message, retryable: false };
  }
  if (/预算|budget/i.test(message)) {
    return { ok: false, code: "budget_exceeded", message, retryable: false };
  }
  if (/配置|profile|configuration/i.test(message)) {
    return { ok: false, code: "missing_configuration", message, retryable: false };
  }
  if (/租约|lease|正在由工作项/i.test(message)) {
    return { ok: false, code: "lease_conflict", message, retryable: true };
  }
  if (/SHA|版本|stale|重新读取/i.test(message)) {
    return { ok: false, code: "stale_version", message, retryable: true };
  }
  if (/验证失败|validation failed/i.test(message)) {
    return { ok: false, code: "validation_failed", message, retryable: true };
  }
  if (/超时|timeout/i.test(message)) {
    return { ok: false, code: "provider_timeout", message, retryable: true };
  }
  if (/连接|server|MCP.*失败|ECONN/i.test(message)) {
    return { ok: false, code: "server_unavailable", message, retryable: true };
  }
  if (/参数|输入|JSON|路径|path|找不到|未知工具|outside|越界/i.test(message)) {
    return { ok: false, code: "invalid_input", message, retryable: true };
  }
  return { ok: false, code: "internal_error", message, retryable: false };
}

