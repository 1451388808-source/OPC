import { saveEmployeeProfile } from "@/lib/application/employees";
import { handle } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as {
    prompt?: string;
    skills?: string;
    provider?: string;
    model?: string;
  };
  return handle(async () => {
    await saveEmployeeProfile(id, {
      prompt: body.prompt ?? "",
      skills: body.skills ?? "",
      provider: body.provider ?? "",
      model: body.model ?? "",
    });
    return { ok: true };
  });
}
