import { removeCompany } from "@/lib/application/org";
import { handle } from "@/lib/http";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handle(async () => {
    await removeCompany(id);
    return { ok: true };
  });
}
