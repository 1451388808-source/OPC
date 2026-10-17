import { resolveWorkflowDecision } from "@/lib/application/collaboration";
import { enqueueCollaborationWorkflow } from "@/lib/collaboration/agent-runner";
import { handle } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ decisionId: string }> }) {
  const { decisionId } = await context.params;
  const body = (await request.json()) as { answer?: string };
  return handle(async () => {
    const result = await resolveWorkflowDecision({ decisionId, answer: body.answer ?? "" });
    enqueueCollaborationWorkflow(result.workflowId);
    return result;
  });
}

