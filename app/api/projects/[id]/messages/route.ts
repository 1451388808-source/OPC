import { sayInProject, type ProjectEvent } from "@/lib/application/org";
import { RuleError } from "@/lib/domain/task";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { text?: string; roleId?: string };
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ProjectEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        await sayInProject(id, body.text ?? "", body.roleId ?? "", send);
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
