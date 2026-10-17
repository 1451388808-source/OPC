import Link from "next/link";
import type { ReactNode } from "react";

export function ProjectHeader({
  companyId,
  companyName,
  projectId,
  projectName,
  view,
  changesToggle,
}: {
  companyId: string;
  companyName: string;
  projectId: string;
  projectName: string;
  view: "chat" | "runs";
  changesToggle?: ReactNode;
}) {
  const base = `/company/${companyId}/p/${projectId}`;

  return (
    <header className="chat-head project-header">
      <div>
        <h1>{projectName}</h1>
        <p className="quiet">{companyName} · 在场员工看的是同一段对话</p>
      </div>
      <div className="project-head-actions">
        {changesToggle}
        <nav className="project-tabs" aria-label="项目视图">
          <Link className={view === "chat" ? "project-tab active" : "project-tab"} href={base}>
            对话
          </Link>
          <Link className={view === "runs" ? "project-tab active" : "project-tab"} href={`${base}?view=runs`}>
            执行
          </Link>
        </nav>
        <Link className="ghost" href={`/company/${companyId}`}>
          返回
        </Link>
      </div>
    </header>
  );
}
