"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { PanelMotion } from "../components/motion";
import { AddMemberForm, RemoveMemberButton } from "./forms";

export type CompanyListItem = { id: string; name: string };
export type ProjectListItem = { id: string; companyId: string; name: string };
export type StaffListItem = { projectId: string; id: string; name: string; thinking: string };
export type PersonListItem = { id: string; name: string };

export function CompanyFrame({
  companies,
  projects,
  staff,
  people,
  children,
}: {
  companies: CompanyListItem[];
  projects: ProjectListItem[];
  staff: StaffListItem[];
  people: PersonListItem[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(true);
  const companyId = pathname.match(/^\/company\/(c-\d{3})(?:\/|$)/)?.[1] ?? "";
  const projectId = pathname.match(/^\/company\/c-\d{3}\/p\/(p-\d{3})(?:\/|$)/)?.[1] ?? "";
  const visibleProjects = projects.filter((project) => project.companyId === companyId);

  return (
    <div className={open ? "module" : "module module-collapsed"}>
      <div className="module-side">
        <aside className="module-list">
          <h1>公司</h1>
          <p className="empty">先建公司，再在公司下建项目。一个项目是一段共用对话。</p>
          <div className="employee-add">
            <Link className={pathname === "/company/new" ? "send current" : "send"} href="/company/new">
              新建公司
            </Link>
          </div>
          {companies.length === 0 ? <p className="empty">还没有公司。</p> : null}
          {companies.map((company) => (
            <div key={company.id} className={company.id === companyId ? "module-card active" : "module-card"}>
              <Link href={`/company/${company.id}`}>
                <strong>{company.name}</strong>
                <span>{company.id}</span>
              </Link>
            </div>
          ))}
          {companyId ? (
            <div className="project-block">
              <h2>项目</h2>
              <Link
                className={pathname === `/company/${companyId}/new` ? "send current" : "send"}
                href={`/company/${companyId}/new`}
              >
                新建项目
              </Link>
              {visibleProjects.length === 0 ? <p className="empty">还没有项目。</p> : null}
              {visibleProjects.map((project) => (
                <div key={project.id} className={project.id === projectId ? "module-card active" : "module-card"}>
                  <Link href={`/company/${companyId}/p/${project.id}`}>
                    <strong>{project.name}</strong>
                    <span>{project.id} · 共用对话</span>
                  </Link>
                </div>
              ))}
            </div>
          ) : null}
          {projectId ? (
            <ProjectStaff
              projectId={projectId}
              staff={staff.filter((person) => person.projectId === projectId)}
              people={people}
            />
          ) : null}
        </aside>
        <button
          className="module-toggle"
          type="button"
          aria-expanded={open}
          aria-label={open ? "收起公司名单" : "展开公司名单"}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "‹" : "›"}
        </button>
      </div>
      <div className="module-main">
        <PanelMotion className="module-panel-motion" motionKey={pathname}>
          {children}
        </PanelMotion>
      </div>
    </div>
  );
}

function ProjectStaff({
  projectId,
  staff,
  people,
}: {
  projectId: string;
  staff: StaffListItem[];
  people: PersonListItem[];
}) {
  const taken = new Set(staff.map((person) => person.id));
  const candidates = people.filter((person) => !taken.has(person.id));

  return (
    <div className="project-block">
      <h2>员工</h2>
      {staff.length === 0 ? <p className="empty">还没有员工。</p> : null}
      {staff.map((person) => (
        <div key={person.id} className="staff">
          <div className="staff-line">
            <strong>{person.name}</strong>
            <RemoveMemberButton projectId={projectId} roleId={person.id} name={person.name} iconOnly />
          </div>
          <p className="project-thinking" title={person.thinking || undefined}>
            {person.thinking || "还没有对这个项目的思考。"}
          </p>
        </div>
      ))}
      <AddMemberForm key={candidates.map((person) => person.id).join(",")} projectId={projectId} candidates={candidates} />
      {candidates.length === 0 && staff.length > 0 ? <p className="empty">员工都在这个项目里。</p> : null}
      {people.length === 0 ? <Link href="/roles/new">去员工页新建</Link> : null}
    </div>
  );
}
