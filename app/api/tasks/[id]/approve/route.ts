import { approve } from "@/lib/application/board";
import { handle } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { decision?: string; record?: boolean };
  return handle(() => approve(id, body.decision ?? "", body.record !== false));
}
