import { approveCollaborationWorkflow } from "@/lib/application/collaboration";
import { handle } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await context.params;
  const body = (await request.json()) as { decision?: string; record?: boolean };
  return handle(() => approveCollaborationWorkflow(workflowId, body.decision ?? "", body.record !== false));
}

