import fs from "node:fs/promises";
import path from "node:path";
import { taskSchema } from "../domain/schema";
import type { Task } from "../domain/task";
import { parseRoleFile, isRoleId, type RoleDefinition } from "../domain/role";

export const repoRoot = process.cwd();

export function section(markdown: string, title: string): string {
  const match = markdown.match(new RegExp(`## ${title}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`));
  return match?.[1]?.trim() ?? "";
}

export function firstParagraph(text: string): string {
  return text.split(/\r?\n\s*\r?\n/)[0]?.trim() ?? "";
}

export function replaceSection(markdown: string, title: string, body: string): string {
  const pattern = new RegExp(`(## ${title}\\r?\\n)[\\s\\S]*?(?=\\r?\\n## |$)`);
  if (!pattern.test(markdown)) return `${markdown.trim()}\n\n## ${title}\n\n${body.trim()}\n`;
  return markdown.replace(pattern, `$1\n${body.trim()}\n`);
}

export function replaceFirstParagraph(markdown: string, title: string, paragraph: string): string {
  const current = section(markdown, title);
  const rest = current.split(/\r?\n\s*\r?\n/).slice(1).join("\n\n");
  const body = rest ? `${paragraph.trim()}\n\n${rest}` : paragraph.trim();
  return replaceSection(markdown, title, body);
}

export async function readRoles(): Promise<RoleDefinition[]> {
  const dir = path.join(repoRoot, "roles");
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const roles: RoleDefinition[] = [];
  for (const name of names.filter((item) => /^[a-z][a-z0-9-]*\.md$/.test(item)).sort()) {
    const id = name.slice(0, -3);
    const markdown = await fs.readFile(path.join(dir, name), "utf8");
    roles.push(parseRoleFile(id, markdown));
  }
  return roles;
}

export async function readSkillText(id: string): Promise<string> {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return "";
  try {
    return (await fs.readFile(path.join(repoRoot, "skills", `${id}.md`), "utf8")).trim();
  } catch {
    return "";
  }
}

export async function readSkill(id: string): Promise<{ id: string; name: string } | null> {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return null;
  try {
    const markdown = await fs.readFile(path.join(repoRoot, "skills", `${id}.md`), "utf8");
    const name = markdown.match(/^#\s+(.+)\s*$/m)?.[1]?.trim() || id;
    return { id, name };
  } catch {
    return null;
  }
}

function roleFile(id: string): string {
  if (!isRoleId(id)) throw new Error("角色 id 不合法");
  return path.join(repoRoot, "roles", `${id}.md`);
}

export async function writeRoleFile(id: string, markdown: string): Promise<void> {
  await writeAtomic(roleFile(id), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
}

export async function deleteRoleFile(id: string): Promise<void> {
  await fs.unlink(roleFile(id));
}

export async function updateRoleProfile(
  id: string,
  profile: { prompt: string; skills: string[]; provider: string; model: string },
): Promise<void> {
  const file = roleFile(id);
  let markdown = await fs.readFile(file, "utf8");
  const skillBody = profile.skills.map((skill) => `- ${skill}`).join("\n");
  const modelBody = `provider: ${profile.provider}\nmodel: ${profile.model}`;
  markdown = replaceSection(markdown, "提示词", profile.prompt);
  markdown = replaceSection(markdown, "技能", skillBody);
  markdown = replaceSection(markdown, "模型", modelBody);
  await writeAtomic(file, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
}

export async function readTasksFromFiles(): Promise<Task[]> {
  const dir = path.join(repoRoot, "tasks");
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const tasks: Task[] = [];
  for (const name of names.filter((item) => /^t-\d{3}\.json$/.test(item)).sort()) {
    const raw = await fs.readFile(path.join(dir, name), "utf8");
    tasks.push(taskSchema.parse(JSON.parse(raw)));
  }
  return tasks;
}

export async function readGoalFile(): Promise<{
  quarterText: string;
  weekFocus: string;
  weekStart: string | null;
  weekEnd: string | null;
  outOfScope: string;
}> {
  const markdown = await fs.readFile(path.join(repoRoot, "company", "goals.md"), "utf8");
  const week = section(markdown, "本周唯一重点");
  const dates = week.match(/(\d{4}-\d{2}-\d{2})\s*至\s*(\d{4}-\d{2}-\d{2})/);
  return {
    quarterText: section(markdown, "本季目标"),
    weekFocus: firstParagraph(week).replace(/^本周是.*$/m, "").trim(),
    weekStart: dates?.[1] ?? null,
    weekEnd: dates?.[2] ?? null,
    outOfScope: section(markdown, "这周范围之外"),
  };
}

export async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
}

export async function exportTaskFile(task: Task): Promise<void> {
  await writeAtomic(
    path.join(repoRoot, "tasks", `${task.id}.json`),
    `${JSON.stringify(task, null, 2)}\n`,
  );
}

export async function exportWeekFocus(weekFocus: string): Promise<void> {
  const file = path.join(repoRoot, "company", "goals.md");
  const markdown = await fs.readFile(file, "utf8");
  await writeAtomic(file, replaceFirstParagraph(markdown, "本周唯一重点", weekFocus));
}

export async function exportDecisions(
  rows: { day: string; title: string; decision: string; reason: string; taskId: string }[],
): Promise<void> {
  const file = path.join(repoRoot, "company", "decisions.md");
  const markdown = await fs.readFile(file, "utf8");
  const body = rows.length
    ? rows
        .map(
          (row) =>
            `## ${row.day} · ${row.title}\n\n- 决定：${row.decision}\n- 理由：${row.reason}\n- 任务：${row.taskId}`,
        )
        .join("\n\n")
    : "尚无。";
  await writeAtomic(file, replaceSection(markdown, "已生效的条目", body));
}
