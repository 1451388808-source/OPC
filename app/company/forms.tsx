"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

async function postJson(url: string, body?: unknown, method = "POST") {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = (await response.json()) as { error?: string; id?: string };
  if (!response.ok) throw new Error(payload.error || "没有完成");
  return payload;
}

export function CreateCompanyForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  return (
    <form
      className="profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError("");
        void postJson("/api/companies", { name })
          .then((result) => {
            router.push(`/company/${result.id}`);
            router.refresh();
          })
          .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "没有完成"))
          .finally(() => setPending(false));
      }}
    >
      <label>
        公司名字
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="这家公司叫什么" />
      </label>
      <button className="send" type="submit" disabled={pending}>
        新建
      </button>
      {error ? <p className="alert">{error}</p> : null}
    </form>
  );
}

export function RemoveCompanyButton({ companyId, name }: { companyId: string; name: string }) {
  const router = useRouter();
  const [error, setError] = useState("");

  return (
    <div className="remove-employee">
      <button
        className="trash"
        type="button"
        aria-label={`删除${name}`}
        title={`删除${name}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!window.confirm(`删除公司"${name}"？公司下的项目、对话和协作记录都会一起删除，不能恢复。`)) return;
          setError("");
          void postJson(`/api/companies/${companyId}`, {}, "DELETE")
            .then(() => {
              router.push("/company");
              router.refresh();
            })
            .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "没有完成"));
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M2.5 3.5h9" strokeLinecap="round" />
          <path d="M5 3.5V2.5h4v1" />
          <path d="M3.5 3.5l.5 8h6l.5-8" />
          <path d="M6 6v4M8 6v4" strokeLinecap="round" />
        </svg>
      </button>
      {error ? <p className="alert">{error}</p> : null}
    </div>
  );
}

export function CreateProjectForm({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  return (
    <form
      className="profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError("");
        void postJson(`/api/companies/${companyId}/projects`, { name })
          .then((result) => {
            router.push(`/company/${companyId}/p/${result.id}`);
            router.refresh();
          })
          .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "没有完成"))
          .finally(() => setPending(false));
      }}
    >
      <label>
        项目名字
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="这个项目做什么" />
      </label>
      <button className="send" type="submit" disabled={pending}>
        新建
      </button>
      {error ? <p className="alert">{error}</p> : null}
    </form>
  );
}

export function AddMemberForm({
  projectId,
  candidates,
}: {
  projectId: string;
  candidates: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [roleId, setRoleId] = useState(candidates[0]?.id ?? "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  if (candidates.length === 0) return null;

  return (
    <form
      className="member-add"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError("");
        void postJson(`/api/projects/${projectId}/members`, { roleId })
          .then(() => router.refresh())
          .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "没有完成"))
          .finally(() => setPending(false));
      }}
    >
      <select aria-label="添加员工" value={roleId} onChange={(event) => setRoleId(event.target.value)}>
        {candidates.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </select>
      <button className="send" type="submit" disabled={pending || !roleId}>
        添加
      </button>
      {error ? <p className="alert">{error}</p> : null}
    </form>
  );
}

export function RemoveMemberButton({
  projectId,
  roleId,
  name,
  iconOnly = false,
}: {
  projectId: string;
  roleId: string;
  name: string;
  iconOnly?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const remove = () => {
    setError("");
    void postJson(`/api/projects/${projectId}/members/${roleId}`, {}, "DELETE")
      .then(() => router.refresh())
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "没有完成"));
  };

  if (iconOnly) {
    return (
      <button className="staff-remove" type="button" aria-label={`把${name}移出项目`} title="移出项目" onClick={remove}>
        ×
      </button>
    );
  }

  return (
    <span className="member">
      {name}
      <button type="button" aria-label={`把${name}移出项目`} title="移出项目" onClick={remove}>
        ×
      </button>
      {error ? <span className="quiet">{error}</span> : null}
    </span>
  );
}

export function ProjectComposer({
  projectId,
  members,
}: {
  projectId: string;
  members: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [roleId, setRoleId] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError("");
        void postJson(`/api/projects/${projectId}/messages`, { text, roleId })
          .then(() => {
            setText("");
            router.refresh();
          })
          .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "没有完成"))
          .finally(() => setPending(false));
      }}
    >
      <label className="ask">
        谁来接话
        <select aria-label="谁来接话" value={roleId} onChange={(event) => setRoleId(event.target.value)}>
          <option value="">在场的人都接话</option>
          {members.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </label>
      <div className="composer-box">
        <textarea
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (!pending && text.trim()) event.currentTarget.form?.requestSubmit();
          }}
          placeholder="写给这个项目"
          aria-label="项目对话"
        />
        <button className="send" type="submit" disabled={pending}>
          {pending ? "正在接话" : "发送"}
        </button>
      </div>
      {error ? <p className="alert">{error}</p> : null}
    </form>
  );
}
