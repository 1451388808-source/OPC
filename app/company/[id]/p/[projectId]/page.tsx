import Link from "next/link";
import { notFound } from "next/navigation";
import { openProject } from "@/lib/application/org";
import { ProjectChat } from "../../../project-chat";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string; projectId: string }>;
}) {
  const { id, projectId } = await params;
  const room = await openProject(id, projectId);
  if (!room) notFound();

  return (
    <div className="chat">
      <header className="chat-head">
        <div>
          <h1>{room.project.name}</h1>
          <p className="quiet">
            {room.company.name} · 在场员工看的是同一段对话
          </p>
        </div>
        <Link className="ghost" href={`/company/${room.company.id}`}>
          返回
        </Link>
      </header>
      <ProjectChat
        projectId={room.project.id}
        members={room.members.map((member) => ({ id: member.id, name: member.name }))}
        messages={room.messages.map((message) => ({
          id: message.id,
          name: message.name,
          body: message.body,
          you: message.speaker === "boss",
        }))}
      />
    </div>
  );
}
