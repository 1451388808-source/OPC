import { pollProjectRun } from "@/lib/application/project-run";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const terminal = new Set(["review", "approved", "returned", "failed"]);

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let afterId = 0;
      try {
        while (!request.signal.aborted) {
          const { run, events } = await pollProjectRun(runId, afterId);
          for (const event of events) {
            afterId = event.id;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "event", event })}\n\n`));
          }
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "status", status: run.status })}\n\n`),
          );
          if (terminal.has(run.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取执行失败";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message })}\n\n`));
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
