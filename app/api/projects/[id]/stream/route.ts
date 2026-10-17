import { ensureProjectEventHistory, pollProjectTimeline } from "@/lib/application/project-event";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let afterId = Number(new URL(request.url).searchParams.get("after") ?? 0);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        await ensureProjectEventHistory(id);
        while (!request.signal.aborted) {
          const events = await pollProjectTimeline(id, afterId, 200);
          for (const event of events) {
            afterId = event.id;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取项目事件失败";
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

