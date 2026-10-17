import { approve } from "@/lib/application/board";
import { approveTaskProjectRun } from "@/lib/application/project-run";
import { handle } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { decision?: string; record?: boolean };
  return handle(async () => {
    const result = await approveTaskProjectRun(id, body.decision ?? "", body.record !== false);
    if (result.handled) return { exportWarning: result.exportWarning };
    return approve(id, body.decision ?? "", body.record !== false);
  });
}
