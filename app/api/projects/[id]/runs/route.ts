import { createProjectRun, loadProjectRuns } from "@/lib/application/project-run";
import { handle } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handle(() => loadProjectRuns(id));
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { roleId?: string; requestText?: string };
  return handle(() =>
    createProjectRun({
      projectId: id,
      roleId: body.roleId ?? "",
      requestText: body.requestText ?? "",
    }),
  );
}
