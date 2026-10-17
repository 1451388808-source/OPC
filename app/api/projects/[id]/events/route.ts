import { loadProjectTimeline } from "@/lib/application/project-event";
import { processProjectMessage, type ProjectMessageProcessingEvent } from "@/lib/application/project-message";
import { RuleError } from "@/lib/domain/task";
import { handle } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const query = new URL(request.url).searchParams;
  const afterId = Number(query.get("after") ?? 0);
  const limit = Number(query.get("limit") ?? 200);
  return handle(() => loadProjectTimeline(id, afterId, limit));
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as {
    text?: string;
    override?: "conversation" | "task";
    workflowId?: string;
  };
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ProjectMessageProcessingEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        await processProjectMessage({
          projectId: id,
          text: body.text ?? "",
          context: { override: body.override, workflowId: body.workflowId },
          emit: send,
        });
      } catch (error) {
        const message = error instanceof RuleError ? error.message : error instanceof Error ? error.message : "没有完成";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}


