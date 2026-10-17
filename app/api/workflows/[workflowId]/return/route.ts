import { returnCollaborationWorkflow } from "@/lib/application/collaboration";
import { enqueueCollaborationWorkflow } from "@/lib/collaboration/agent-runner";
import { handle } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await context.params;
  const body = (await request.json()) as { reason?: string };
  return handle(async () => {
    const result = await returnCollaborationWorkflow(workflowId, body.reason ?? "");
    enqueueCollaborationWorkflow(workflowId);
    return result;
  });
}

