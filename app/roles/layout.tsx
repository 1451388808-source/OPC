import { readRoles, readSkill } from "@/lib/infrastructure/files";
import { EmployeeFrame } from "./employee-frame";

export const dynamic = "force-dynamic";

export default async function RolesLayout({ children }: { children: React.ReactNode }) {
  const roles = await readRoles();
  const people = await Promise.all(
    roles.map(async (role) => ({
      id: role.id,
      name: role.name,
      inboxDefault: role.inboxDefault,
      skills: (await Promise.all(role.skills.map(async (id) => (await readSkill(id))?.name ?? id))).join("、"),
      skillIds: role.skills.join(" "),
    })),
  );

  return <EmployeeFrame people={people}>{children}</EmployeeFrame>;
}
