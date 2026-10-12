import { createCompany } from "@/lib/application/org";
import { handle } from "@/lib/http";

export async function POST(request: Request) {
  const body = (await request.json()) as { name?: string };
  return handle(async () => ({ id: await createCompany(body.name ?? "") }));
}
