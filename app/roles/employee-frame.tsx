"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { PanelMotion } from "../components/motion";
import { RemoveEmployee } from "./employee-forms";

export type EmployeeListItem = {
  id: string;
  name: string;
  inboxDefault: boolean;
  skills: string;
  skillIds: string;
};

export function EmployeeFrame({
  people,
  children,
}: {
  people: EmployeeListItem[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? people.filter((person) =>
        [person.name, person.id, person.skills, person.skillIds].join("\n").toLowerCase().includes(needle),
      )
    : people;

  return (
    <div className={open ? "module" : "module module-collapsed"}>
      <div className="module-side">
        <aside className="module-list">
          <h1>员工</h1>
          <p className="empty">点一个人就和他对话。搜索名字、id 或技能。</p>
          <div className="employee-add">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索员工"
              aria-label="搜索员工"
            />
            <Link className={pathname === "/roles/new" ? "send current" : "send"} href="/roles/new">
              添加
            </Link>
          </div>
          {people.length === 0 ? <p className="empty">还没有员工。</p> : null}
          {people.length > 0 && visible.length === 0 ? <p className="empty">没有匹配的员工。</p> : null}
          {visible.map((person) => {
            const active = pathname === `/roles/${person.id}` || pathname.startsWith(`/roles/${person.id}/`);
            return (
              <div key={person.id} className={active ? "module-card active" : "module-card"}>
                <Link href={`/roles/${person.id}`}>
                  <strong>{person.name}</strong>
                  <span>
                    {person.id}
                    {person.inboxDefault ? " · 收件默认" : ""}
                    {person.skills ? ` · ${person.skills}` : ""}
                  </span>
                </Link>
                <div className="card-actions">
                  <Link
                    className="icon-btn"
                    href={`/roles/${person.id}/setup`}
                    aria-label={`编辑${person.name}`}
                    title={`编辑${person.name}`}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
                      <path d="M8.4 2.3 11.7 5.6" strokeLinecap="round" />
                      <path d="M2.2 11.8 2.7 9.1 9.2 2.6a.9.9 0 0 1 1.3 0l.9.9a.9.9 0 0 1 0 1.3L4.9 11.3 2.2 11.8Z" />
                    </svg>
                  </Link>
                  <RemoveEmployee id={person.id} name={person.name} />
                </div>
              </div>
            );
          })}
        </aside>
        <button
          className="module-toggle"
          type="button"
          aria-expanded={open}
          aria-label={open ? "收起员工名单" : "展开员工名单"}
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
