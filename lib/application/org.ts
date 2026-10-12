import { RuleError } from "../domain/task";
import { shanghaiTime } from "../domain/time";
import { composeReply, replySoFar, splitReply } from "../employees/message-text";
import { ModelCallError, ModelNotConnectedError } from "../employees/model";
import { streamProjectTurn } from "../employees/reply";
import { ensureReady } from "./board";
import { getPool, withTransaction } from "../infrastructure/db";
import { readRoles } from "../infrastructure/files";
import {
  allocateSerial,
  deleteMember,
  getCompany,
  getProject,
  insertCompany,
  insertMember,
  insertProject,
  insertProjectMessage,
  listCompanies,
  listMemberIds,
  listProjectMessages,
  listProjects,
  listStaff,
  saveProjectThinking,
  serialId,
  type CompanyRow,
  type ProjectRow,
} from "../infrastructure/org-store";

export function isCompanyId(id: string): boolean {
  return /^c-\d{3}$/.test(id);
}

export function isProjectId(id: string): boolean {
  return /^p-\d{3}$/.test(id);
}

function requireName(name: string, empty: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new RuleError(empty);
  if (trimmed.length > 200) throw new RuleError("名字太长");
  return trimmed;
}

export type StaffItem = { projectId: string; id: string; name: string; thinking: string };

export async function loadOrg(): Promise<{ companies: CompanyRow[]; projects: ProjectRow[]; staff: StaffItem[] }> {
  await ensureReady();
  const pool = getPool();
  const [companies, projects, rows] = await Promise.all([listCompanies(pool), listProjects(pool), listStaff(pool)]);
  const roles = await readRoles();
  const nameOf = (roleId: string) => roles.find((role) => role.id === roleId)?.name ?? roleId;
  return {
    companies,
    projects,
    staff: rows.map((row) => ({
      projectId: row.projectId,
      id: row.roleId,
      name: nameOf(row.roleId),
      thinking: row.thinking,
    })),
  };
}

export async function createCompany(name: string): Promise<string> {
  const trimmed = requireName(name, "先写公司名字");
  await ensureReady();
  const now = shanghaiTime().iso;
  return withTransaction(async (conn) => {
    const next = await allocateSerial(conn, "company");
    if (next > 999) throw new RuleError("公司编号已经用完");
    const id = serialId("c", next);
    await insertCompany(conn, { id, name: trimmed, createdAt: now });
    return id;
  });
}

export async function createProject(companyId: string, name: string): Promise<string> {
  if (!isCompanyId(companyId)) throw new RuleError("找不到这家公司");
  const trimmed = requireName(name, "先写项目名字");
  await ensureReady();
  const now = shanghaiTime().iso;
  return withTransaction(async (conn) => {
    const company = await getCompany(conn, companyId);
    if (!company) throw new RuleError("找不到这家公司");
    const next = await allocateSerial(conn, "project");
    if (next > 999) throw new RuleError("项目编号已经用完");
    const id = serialId("p", next);
    await insertProject(conn, { id, companyId, name: trimmed, createdAt: now });
    return id;
  });
}

export async function findCompany(id: string): Promise<CompanyRow | null> {
  if (!isCompanyId(id)) return null;
  await ensureReady();
  return getCompany(getPool(), id);
}

export type ProjectRoom = {
  company: CompanyRow;
  project: ProjectRow;
  members: { id: string; name: string; thinking: string }[];
  candidates: { id: string; name: string }[];
  messages: { id: number; speaker: "boss" | "employee"; roleId: string; name: string; body: string }[];
};

export async function openProject(companyId: string, projectId: string): Promise<ProjectRoom | null> {
  if (!isCompanyId(companyId) || !isProjectId(projectId)) return null;
  await ensureReady();
  const pool = getPool();
  const company = await getCompany(pool, companyId);
  const project = await getProject(pool, projectId);
  if (!company || !project || project.companyId !== companyId) return null;
  const roles = await readRoles();
  const staff = (await listStaff(pool)).filter((row) => row.projectId === projectId);
  const memberIds = staff.map((row) => row.roleId);
  const nameOf = (roleId: string) => roles.find((role) => role.id === roleId)?.name ?? roleId;
  const messages = await listProjectMessages(pool, projectId);
  return {
    company,
    project,
    members: staff.map((row) => ({ id: row.roleId, name: nameOf(row.roleId), thinking: row.thinking })),
    candidates: roles.filter((role) => !memberIds.includes(role.id)).map((role) => ({ id: role.id, name: role.name })),
    messages: messages.map((message) => ({
      id: message.id,
      speaker: message.speaker,
      roleId: message.roleId,
      name: message.speaker === "boss" ? "你" : nameOf(message.roleId),
      body: message.body,
    })),
  };
}

export async function addProjectMember(projectId: string, roleId: string): Promise<void> {
  if (!isProjectId(projectId)) throw new RuleError("找不到这个项目");
  await ensureReady();
  const pool = getPool();
  const project = await getProject(pool, projectId);
  if (!project) throw new RuleError("找不到这个项目");
  const roles = await readRoles();
  if (!roles.some((role) => role.id === roleId)) throw new RuleError("找不到这个员工");
  const members = await listMemberIds(pool, projectId);
  if (members.includes(roleId)) throw new RuleError("这个员工已经在项目里");
  await insertMember(pool, projectId, roleId, shanghaiTime().iso);
}

export async function removeProjectMember(projectId: string, roleId: string): Promise<void> {
  if (!isProjectId(projectId)) throw new RuleError("找不到这个项目");
  await ensureReady();
  const project = await getProject(getPool(), projectId);
  if (!project) throw new RuleError("找不到这个项目");
  await deleteMember(getPool(), projectId, roleId);
}

export type ProjectEvent =
  | { type: "user"; text: string }
  | { type: "start"; roleId: string; name: string }
  | { type: "thinking"; roleId: string; delta: string }
  | { type: "reply"; roleId: string; delta: string }
  | { type: "error"; message: string };

function transcript(room: ProjectRoom): string {
  const people = room.members.map((member) => member.name).join("、") || "还没有员工";
  const lines = room.messages.map((message) => {
    const spoken = splitReply(message.body);
    return `${message.name}：${spoken.answer || spoken.reasoning}`;
  });
  return [`公司：${room.company.name}`, `项目：${room.project.name}`, `在场员工：${people}`, "", "共用对话：", ...lines].join(
    "\n",
  );
}

async function replyInProject(
  companyId: string,
  projectId: string,
  roleIds: string[],
  emit: (event: ProjectEvent) => void,
): Promise<void> {
  const roles = await readRoles();
  for (const roleId of roleIds) {
    const employee = roles.find((role) => role.id === roleId);
    if (!employee) throw new RuleError("找不到这个员工");
    const room = await openProject(companyId, projectId);
    if (!room) throw new RuleError("找不到这个项目");
    const previous = room.members.find((member) => member.id === roleId)?.thinking ?? "";
    const input = [
      transcript(room),
      "",
      previous ? `你上次对这个项目的思考：\n${previous}` : "你还没有写过对这个项目的思考。",
      "根据整段共用对话，用一两句重写你对这个项目的思考，再写这一轮要说的话。",
    ].join("\n");
    emit({ type: "start", roleId, name: employee.name });
    let content = "";
    let streamedReply = "";
    let spoken = "";
    let projectThinking = "";
    let reasoning = "";
    const pushReply = (next: string) => {
      if (!next.startsWith(streamedReply)) return;
      const delta = next.slice(streamedReply.length);
      streamedReply = next;
      if (delta) emit({ type: "reply", roleId, delta });
    };
    try {
      const turn = await streamProjectTurn(employee, input, (delta) => {
        if (delta.reasoning) emit({ type: "thinking", roleId, delta: delta.reasoning });
        if (delta.text) {
          content += delta.text;
          pushReply(replySoFar(content));
        }
      });
      projectThinking = turn.thinking;
      reasoning = turn.reasoning;
      spoken = turn.reply || content.trim();
      pushReply(spoken);
    } catch (error) {
      if (error instanceof ModelNotConnectedError || error instanceof ModelCallError) {
        spoken = error.message;
        pushReply(spoken);
      } else throw error;
    }
    if (!spoken) {
      spoken = "这一轮没有说出话。";
      pushReply(spoken);
    }
    if (projectThinking) await saveProjectThinking(getPool(), projectId, roleId, projectThinking, shanghaiTime().iso);
    const body = reasoning ? composeReply(reasoning, spoken) : spoken;
    await insertProjectMessage(getPool(), projectId, "employee", roleId, body, shanghaiTime().iso);
  }
}

export async function sayInProject(
  projectId: string,
  text: string,
  roleId: string,
  emit: (event: ProjectEvent) => void = () => {},
): Promise<void> {
  const message = text.trim();
  if (!message) throw new RuleError("先写一句话");
  if (!isProjectId(projectId)) throw new RuleError("找不到这个项目");
  await ensureReady();
  const pool = getPool();
  const project = await getProject(pool, projectId);
  if (!project) throw new RuleError("找不到这个项目");
  const members = await listMemberIds(pool, projectId);
  const asked = roleId.trim();
  const targets = asked ? [asked] : members;
  if (targets.length === 0) throw new RuleError("先把员工加进项目，才有人接话");
  if (asked && !members.includes(asked)) throw new RuleError("先把这个员工加进项目");
  await insertProjectMessage(pool, projectId, "boss", "", message, shanghaiTime().iso);
  emit({ type: "user", text: message });
  await replyInProject(project.companyId, projectId, targets, emit);
}
