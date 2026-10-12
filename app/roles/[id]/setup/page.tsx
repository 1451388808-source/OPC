import Link from "next/link";
import { notFound } from "next/navigation";
import { readRoles, readSkill } from "@/lib/infrastructure/files";
import { ProfileForm } from "../../employee-forms";

export const dynamic = "force-dynamic";

export default async function EmployeeSetupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const roles = await readRoles();
  const employee = roles.find((role) => role.id === id);
  if (!employee) notFound();
  const skills = await Promise.all(
    employee.skills.map(async (skillId) => ({
      id: skillId,
      name: (await readSkill(skillId))?.name ?? "",
    })),
  );

  return (
    <article className="module-body">
      <div className="chat-head">
        <div>
          <h1>{employee.name}的背后</h1>
          <p className="quiet">roles/{employee.id}.md</p>
        </div>
        <Link className="ghost" href={`/roles/${employee.id}`}>
          回到对话
        </Link>
      </div>
      {skills.length === 0 ? <p className="empty">还没有技能。</p> : null}
      {skills.map((skill) => (
        <p key={skill.id} className="quiet">
          {skill.name || skill.id} · skills/{skill.id}.md
          {skill.name ? "" : " · 还没有这份文件"}
        </p>
      ))}
      <ProfileForm
        roleId={employee.id}
        prompt={employee.prompt}
        skills={employee.skills.join("\n")}
        provider={employee.model.provider}
        model={employee.model.model}
      />
    </article>
  );
}
