import { loadCollaborationReview } from "@/lib/application/collaboration";
import { handle } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await context.params;
  return handle(() => loadCollaborationReview(workflowId));
}

