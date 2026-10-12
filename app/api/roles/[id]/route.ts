import { removeEmployee } from "@/lib/application/employees";
import { handle } from "@/lib/http";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handle(async () => {
    await removeEmployee(id);
    return { ok: true };
  });
}
