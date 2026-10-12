import { approveProjectRun } from "@/lib/application/project-run";
import { handle } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  return handle(() => approveProjectRun(runId));
}
