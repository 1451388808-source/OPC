import { handle } from "@/lib/http";
import { loadBoard } from "@/lib/application/board";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const task = new URL(request.url).searchParams.get("task");
  return handle(async () => ({ ...(await loadBoard()), selectedId: task }));
}
