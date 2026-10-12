import { createEmployee } from "@/lib/application/employees";
import { handle } from "@/lib/http";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    name?: string;
    id?: string;
    prompt?: string;
    skills?: string;
    provider?: string;
    model?: string;
  };
  return handle(async () => ({
    id: await createEmployee({
      name: body.name ?? "",
      id: body.id ?? "",
      prompt: body.prompt ?? "",
      skills: body.skills ?? "",
      provider: body.provider ?? "",
      model: body.model ?? "",
    }),
  }));
}
