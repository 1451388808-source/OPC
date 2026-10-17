import { retryFailedWorkflow } from "@/lib/application/collaboration";
import { enqueueCollaborationWorkflow } from "@/lib/collaboration/agent-runner";
import { handle } from "@/lib/http";

export async function POST(_request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await context.params;
  return handle(async () => {
    await retryFailedWorkflow(workflowId);
    enqueueCollaborationWorkflow(workflowId);
    return { retried: true };
  });
}
