import { returnToDoing } from "@/lib/application/board";
import { returnTaskProjectRun } from "@/lib/application/project-run";
import { handle } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { reason?: string };
  return handle(async () => {
    const result = await returnTaskProjectRun(id, body.reason ?? "");
    if (result.handled) return { exportWarning: result.exportWarning };
    return returnToDoing(id, body.reason ?? "");
  });
}
