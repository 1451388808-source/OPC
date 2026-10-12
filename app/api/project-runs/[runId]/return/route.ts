import { returnProjectRun } from "@/lib/application/project-run";
import { handle } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  const body = (await request.json()) as { reason?: string };
  return handle(() => returnProjectRun(runId, body.reason ?? ""));
}
