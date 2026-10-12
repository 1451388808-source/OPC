import Link from "next/link";
import { notFound } from "next/navigation";
import { findCompany, loadOrg } from "@/lib/application/org";

export const dynamic = "force-dynamic";

export default async function CompanyHomePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const company = await findCompany(id);
  if (!company) notFound();
  const { projects } = await loadOrg();
  const own = projects.filter((project) => project.companyId === company.id);

  return (
    <article className="module-body">
      <h1>{company.name}</h1>
      <p className="quiet">{company.id}</p>
      <p className="empty">每个项目是一个对话框。员工加进项目之后，都在这一段对话里工作。</p>
      {own.length === 0 ? <p className="empty">还没有项目。</p> : null}
      {own.map((project) => (
        <div key={project.id} className="module-card">
          <Link href={`/company/${company.id}/p/${project.id}`}>
            <strong>{project.name}</strong>
            <span>{project.id} · 共用对话</span>
          </Link>
        </div>
      ))}
      <div className="employee-add">
        <Link className="send" href={`/company/${company.id}/new`}>
          新建项目
        </Link>
      </div>
    </article>
  );
}
