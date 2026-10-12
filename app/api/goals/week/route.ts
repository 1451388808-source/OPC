import { saveWeekFocus } from "@/lib/application/board";
import { handle } from "@/lib/http";

export async function POST(request: Request) {
  const body = (await request.json()) as { weekFocus?: string };
  return handle(() => saveWeekFocus(body.weekFocus ?? ""));
}
