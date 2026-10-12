import { addProjectMember } from "@/lib/application/org";
import { handle } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { roleId?: string };
  return handle(async () => {
    await addProjectMember(id, body.roleId ?? "");
    return { ok: true };
  });
}
