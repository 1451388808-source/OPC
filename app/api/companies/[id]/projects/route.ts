import { createProject } from "@/lib/application/org";
import { handle } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { name?: string };
  return handle(async () => ({ id: await createProject(id, body.name ?? "") }));
}
