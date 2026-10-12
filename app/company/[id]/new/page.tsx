import Link from "next/link";
import { notFound } from "next/navigation";
import { findCompany } from "@/lib/application/org";
import { CreateProjectForm } from "../../forms";

export const dynamic = "force-dynamic";

export default async function NewProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const company = await findCompany(id);
  if (!company) notFound();

  return (
    <article className="module-body">
      <div className="chat-head">
        <div>
          <h1>新建项目</h1>
          <p className="quiet">{company.name} · 建好后是一个对话框</p>
        </div>
        <Link className="ghost" href={`/company/${company.id}`}>
          返回
        </Link>
      </div>
      <CreateProjectForm companyId={company.id} />
    </article>
  );
}
