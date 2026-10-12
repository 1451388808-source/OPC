import Link from "next/link";
import { notFound } from "next/navigation";
import { openProject } from "@/lib/application/org";
import { loadProjectRuns } from "@/lib/application/project-run";
import { ProjectChat } from "../../../project-chat";
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
  const runs = await loadProjectRuns(projectId);
  const base = `/company/${room.company.id}/p/${room.project.id}`;

  return (
    <div className="chat">
      <header className="chat-head">
        <div>
          <h1>{room.project.name}</h1>
          <p className="quiet">
            {room.company.name} · 在场员工看的是同一段对话
          </p>
        </div>
        <div className="project-head-actions">
          <nav className="project-tabs" aria-label="项目视图">
            <Link className={view === "chat" ? "project-tab active" : "project-tab"} href={base}>
              对话
            </Link>
            <Link
              className={view === "runs" ? "project-tab active" : "project-tab"}
              href={`${base}?view=runs`}
            >
              执行
            </Link>
          </nav>
          <Link className="ghost" href={`/company/${room.company.id}`}>
            返回
          </Link>
        </div>
      </header>
      {view === "chat" ? (
        <ProjectChat
          projectId={room.project.id}
          members={room.members.map((member) => ({ id: member.id, name: member.name }))}
          messages={room.messages.map((message) => ({
            id: message.id,
            name: message.name,
            body: message.body,
            you: message.speaker === "boss",
          }))}
          initialRuns={[...runs].reverse().slice(-10)}
        />
      ) : (
        <ProjectRuns
          projectId={room.project.id}
          companyId={room.company.id}
          members={room.members.map((member) => ({ id: member.id, name: member.name }))}
          initialRuns={runs}
          initialRunId={query.run ?? null}
        />
      )}
    </div>
  );
}
