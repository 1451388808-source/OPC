import { dispatchTaskToTeam } from "@/lib/application/task-workflow";
import { handle } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { projectId?: string };
  return handle(() => dispatchTaskToTeam({ taskId: id, projectId: body.projectId ?? "" }));
}
