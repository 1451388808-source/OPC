export type RoleDefinition = {
  id: string;
  name: string;
  inboxDefault: boolean;
  prompt: string;
  skills: string[];
  model: {
    provider: string;
    model: string;
  };
};

const roleIdPattern = /^[a-z][a-z0-9-]{0,62}$/;

export function isRoleId(value: string): boolean {
  return roleIdPattern.test(value);
}

function block(markdown: string, title: string): string {
  const match = markdown.match(new RegExp(`## ${title}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`));
  return match?.[1]?.trim() ?? "";
}

function field(text: string, key: string): string {
  const match = text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

export function parseRoleFile(id: string, markdown: string): RoleDefinition {
  const heading = markdown.match(/^#\s+(.+)\s*$/m)?.[1]?.trim();
  const skills = block(markdown, "技能")
    .split(/\r?\n/)
    .map((line) => line.match(/^-\s+([a-z][a-z0-9-]*)/)?.[1] ?? "")
    .filter(Boolean);
  const modelBlock = block(markdown, "模型");
  return {
    id,
    name: heading || id,
    inboxDefault: /^收件默认:\s*是\s*$/m.test(markdown),
    prompt: block(markdown, "提示词"),
    skills,
    model: {
      provider: field(modelBlock, "provider"),
      model: field(modelBlock, "model"),
    },
  };
}

export function pickInboxRole(roles: RoleDefinition[]): RoleDefinition | null {
  if (roles.length === 0) return null;
  return roles.find((role) => role.inboxDefault) ?? [...roles].sort((a, b) => a.id.localeCompare(b.id))[0];
}

export function nextEmployeeId(ids: string[]): string {
  let max = 0;
  for (const id of ids) {
    const match = id.match(/^e-(\d+)$/);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }
  return `e-${String(max + 1).padStart(3, "0")}`;
}

export function modelConnected(role: RoleDefinition): boolean {
  return role.model.provider.length > 0 && role.model.model.length > 0;
}
