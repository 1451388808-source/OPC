import { removeProjectMember } from "@/lib/application/org";
import { handle } from "@/lib/http";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string; roleId: string }> }) {
  const { id, roleId } = await context.params;
  return handle(async () => {
    await removeProjectMember(id, roleId);
    return { ok: true };
  });
}
