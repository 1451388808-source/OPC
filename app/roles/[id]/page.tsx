import Link from "next/link";
import { notFound } from "next/navigation";
import { loadChat } from "@/lib/application/employees";
import { readRoles } from "@/lib/infrastructure/files";
import { EmployeeChat } from "../employee-chat";

export const dynamic = "force-dynamic";

export default async function EmployeeChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const roles = await readRoles();
  const employee = roles.find((role) => role.id === id);
  if (!employee) notFound();
  const messages = await loadChat(id);

  return (
    <div className="chat">
      <header className="chat-head">
        <div>
          <h1>{employee.name}</h1>
          <p className="quiet">你是老板。{employee.inboxDefault ? "新收件默认交给他。" : ""}</p>
        </div>
        <Link className="ghost" href={`/roles/${employee.id}/setup`}>
          背后
        </Link>
      </header>
      <EmployeeChat
        key={employee.id}
        roleId={employee.id}
        name={employee.name}
        messages={messages.map((message) => ({ id: message.id, speaker: message.speaker, body: message.body }))}
      />
    </div>
  );
}
