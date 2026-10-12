import { isRoleId, nextEmployeeId } from "../domain/role";
import { RuleError } from "../domain/task";
import { shanghaiTime } from "../domain/time";
import { composeReply } from "../employees/message-text";
import { ModelCallError, ModelNotConnectedError } from "../employees/model";
import { streamChatTurn } from "../employees/reply";
import { deepseekModel, deepseekProvider } from "../employees/deepseek";
import { ensureReady } from "./board";
import { getPool } from "../infrastructure/db";
import {
  deleteRoleFile,
  readRoles,
  updateRoleProfile,
  writeRoleFile,
} from "../infrastructure/files";
import {
  countTasksForRole,
  deleteMessages,
  insertMessage,
  listMessages,
  type ChatMessage,
} from "../infrastructure/store";

function skillIds(skills: string): string[] {
  const list = skills
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (list.some((skill) => !isRoleId(skill))) throw new RuleError("技能 id 用小写英文、数字和连字符");
  return list;
}

export async function createEmployee(input: {
  name: string;
  id?: string;
  prompt?: string;
  skills?: string;
  provider?: string;
  model?: string;
}): Promise<string> {
  const trimmed = input.name.trim();
  if (!trimmed) throw new RuleError("先写员工名字");
  const roles = await readRoles();
  const id = input.id?.trim() || nextEmployeeId(roles.map((role) => role.id));
  if (id === "new") throw new RuleError("这个 id 留给添加页");
  if (!isRoleId(id)) throw new RuleError("id 用小写英文、数字和连字符");
  if (roles.some((role) => role.id === id)) throw new RuleError("已经有这个员工");
  const skills = skillIds(input.skills ?? "");
  const prompt = (input.prompt ?? "").trim();
  const provider = (input.provider ?? "").trim() || deepseekProvider;
  const model = (input.model ?? "").trim() || deepseekModel;
  const section = (title: string, body: string) => (body ? `## ${title}\n\n${body}` : `## ${title}`);
  const markdown = [
    `# ${trimmed}`,
    section("提示词", prompt),
    section("技能", skills.map((skill) => `- ${skill}`).join("\n")),
    section("模型", `${provider ? `provider: ${provider}` : "provider:"}\n${model ? `model: ${model}` : "model:"}`),
  ].join("\n\n");
  await writeRoleFile(id, markdown);
  return id;
}

export async function removeEmployee(id: string): Promise<void> {
  if (!isRoleId(id)) throw new RuleError("找不到这个员工");
  const roles = await readRoles();
  if (!roles.some((role) => role.id === id)) throw new RuleError("找不到这个员工");
  await ensureReady();
  const used = await countTasksForRole(getPool(), id);
  if (used > 0) throw new RuleError("还有任务交给这个员工，先改任务再移除");
  await deleteRoleFile(id);
  await deleteMessages(getPool(), id);
}

export async function loadChat(id: string): Promise<ChatMessage[]> {
  await ensureReady();
  return listMessages(getPool(), id);
}

export type ChatEvent =
  | { type: "thinking"; delta: string }
  | { type: "reply"; delta: string }
  | { type: "error"; message: string };

export async function sendToEmployee(
  id: string,
  text: string,
  emit: (event: ChatEvent) => void = () => {},
): Promise<void> {
  const message = text.trim();
  if (!message) throw new RuleError("先写一句话");
  const roles = await readRoles();
  const employee = roles.find((role) => role.id === id);
  if (!employee) throw new RuleError("找不到这个员工");
  await ensureReady();
  const pool = getPool();
  await insertMessage(pool, id, "boss", message, shanghaiTime().iso);
  let reply = "";
  try {
    const turn = await streamChatTurn(employee, message, (delta) => {
      if (delta.reasoning) emit({ type: "thinking", delta: delta.reasoning });
      if (delta.text) emit({ type: "reply", delta: delta.text });
    });
    reply = composeReply(turn.reasoning, turn.reply);
  } catch (error) {
    if (error instanceof ModelNotConnectedError || error instanceof ModelCallError) {
      reply = error.message;
      emit({ type: "reply", delta: reply });
    } else throw error;
  }
  if (!reply) {
    reply = "这一轮没有说出话。";
    emit({ type: "reply", delta: reply });
  }
  await insertMessage(pool, id, "employee", reply, shanghaiTime().iso);
}

export async function saveEmployeeProfile(
  id: string,
  input: { prompt: string; skills: string; provider: string; model: string },
): Promise<void> {
  const roles = await readRoles();
  if (!roles.some((role) => role.id === id)) throw new RuleError("找不到这个员工");
  const skills = skillIds(input.skills);
  await updateRoleProfile(id, {
    prompt: input.prompt.trim(),
    skills,
    provider: input.provider.trim(),
    model: input.model.trim(),
  });
}
