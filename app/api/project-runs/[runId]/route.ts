import { loadProjectRun } from "@/lib/application/project-run";
import { handle } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  return handle(() => loadProjectRun(runId));
}
