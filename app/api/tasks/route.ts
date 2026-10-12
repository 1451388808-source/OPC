import { createInbox } from "@/lib/application/board";
import { handle } from "@/lib/http";

export async function POST(request: Request) {
  const body = (await request.json()) as { brief?: string };
  return handle(() => createInbox(body.brief ?? ""));
}
