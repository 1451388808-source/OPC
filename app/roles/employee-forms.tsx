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

export function CreateEmployeeForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [skills, setSkills] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  return (
    <form
      className="profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError("");
        void postJson("/api/roles", { name, id, prompt, skills, provider, model })
          .then((result) => {
            router.push(`/roles/${result.id}`);
            router.refresh();
          })
          .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "没有完成"))
          .finally(() => setPending(false));
      }}
    >
      <label>
        员工名字
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="看板上的名字" />
      </label>
      <label>
        id
        <input value={id} onChange={(event) => setId(event.target.value)} placeholder="可空，空着就自动编号" />
      </label>
      <label>
        提示词
        <textarea rows={6} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      </label>
      <label>
        技能
        <textarea
          rows={4}
          value={skills}
          onChange={(event) => setSkills(event.target.value)}
          placeholder="一行一个技能 id，对应 skills/ 里的文件"
        />
      </label>
      <label>
        模型 provider
        <input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="以后再填" />
      </label>
      <label>
        模型名
        <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="以后再填" />
      </label>
      <button className="send" type="submit" disabled={pending}>
        添加
      </button>
      {error ? <p className="alert">{error}</p> : null}
    </form>
  );
}

export function RemoveEmployee({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [error, setError] = useState("");

  return (
    <div className="remove-employee">
      <button
        className="trash"
        type="button"
        aria-label={`移除${name}`}
        title={`移除${name}`}
        onClick={() => {
          setError("");
          void postJson(`/api/roles/${id}`, {}, "DELETE")
            .then(() => {
              router.push("/roles");
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

export function ProfileForm({
  roleId,
  prompt,
  skills,
  provider,
  model,
}: {
  roleId: string;
  prompt: string;
  skills: string;
  provider: string;
  model: string;
}) {
  const router = useRouter();
  const [draftPrompt, setPrompt] = useState(prompt);
  const [draftSkills, setSkills] = useState(skills);
  const [draftProvider, setProvider] = useState(provider);
  const [draftModel, setModel] = useState(model);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  return (
    <form
      className="profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError("");
        void postJson(`/api/roles/${roleId}/profile`, {
          prompt: draftPrompt,
          skills: draftSkills,
          provider: draftProvider,
          model: draftModel,
        })
          .then(() => router.refresh())
          .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "没有完成"))
          .finally(() => setPending(false));
      }}
    >
      <label>
        提示词
        <textarea rows={6} value={draftPrompt} onChange={(event) => setPrompt(event.target.value)} />
      </label>
      <label>
        技能
        <textarea
          rows={4}
          value={draftSkills}
          onChange={(event) => setSkills(event.target.value)}
          placeholder="一行一个技能 id，对应 skills/ 里的文件"
        />
      </label>
      <label>
        模型 provider
        <input value={draftProvider} onChange={(event) => setProvider(event.target.value)} placeholder="以后再填" />
      </label>
      <label>
        模型名
        <input value={draftModel} onChange={(event) => setModel(event.target.value)} placeholder="以后再填" />
      </label>
      <button className="send" type="submit" disabled={pending}>
        保存
      </button>
      {error ? <p className="alert">{error}</p> : null}
    </form>
  );
}
