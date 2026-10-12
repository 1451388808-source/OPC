import { returnToDoing } from "@/lib/application/board";
import { handle } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as { reason?: string };
  return handle(() => returnToDoing(id, body.reason ?? ""));
}
