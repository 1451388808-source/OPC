import { promote } from "@/lib/application/board";
import { handle } from "@/lib/http";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handle(() => promote(id));
}
