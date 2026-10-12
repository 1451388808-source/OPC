import { loadOrg } from "@/lib/application/org";
import { readRoles } from "@/lib/infrastructure/files";
import { CompanyFrame } from "./company-frame";

export const dynamic = "force-dynamic";

export default async function CompanyLayout({ children }: { children: React.ReactNode }) {
  const [{ companies, projects, staff }, roles] = await Promise.all([loadOrg(), readRoles()]);
  return (
    <CompanyFrame
      companies={companies}
      projects={projects}
      staff={staff}
      people={roles.map((role) => ({ id: role.id, name: role.name }))}
    >
      {children}
    </CompanyFrame>
  );
}
