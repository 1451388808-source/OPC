import { notFound } from "next/navigation";
import { openProject } from "@/lib/application/org";
import { loadProjectTimeline } from "@/lib/application/project-event";
import { loadProjectRuns } from "@/lib/application/project-run";
import { loadProjectWorkflowSummaries } from "@/lib/application/collaboration";
import { ProjectChat } from "../../../project-chat";
import { ProjectHeader } from "../../../project-header";
import { ProjectRuns } from "../../../project-runs";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; projectId: string }>;
  searchParams: Promise<{ view?: string; run?: string }>;
}) {
  const { id, projectId } = await params;
  const query = await searchParams;
  const room = await openProject(id, projectId);
  if (!room) notFound();
  const view = query.view === "runs" ? "runs" : "chat";
  const events = view === "chat" ? await loadProjectTimeline(projectId, 0, 500) : [];
  const workflows = view === "chat" ? await loadProjectWorkflowSummaries(projectId) : [];
  const runs = view === "runs" ? await loadProjectRuns(projectId) : [];
  if (view === "chat") {
    return (
      <ProjectChat
        companyId={room.company.id}
        companyName={room.company.name}
        projectId={room.project.id}
        projectName={room.project.name}
        members={room.members.map((member) => ({ id: member.id, name: member.name }))}
        initialEvents={events}
        initialWorkflows={workflows}
      />
    );
  }

  return (
    <div className="chat">
      <ProjectHeader
        companyId={room.company.id}
        companyName={room.company.name}
        projectId={room.project.id}
        projectName={room.project.name}
        view="runs"
      />
      <ProjectRuns
        projectId={room.project.id}
        companyId={room.company.id}
        members={room.members.map((member) => ({ id: member.id, name: member.name }))}
        initialRuns={runs}
        initialRunId={query.run ?? null}
      />
    </div>
  );
}
