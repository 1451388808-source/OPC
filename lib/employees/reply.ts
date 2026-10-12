import type { RoleDefinition } from "../domain/role";
import { readSkillText } from "../infrastructure/files";
import { composeReply, parseProjectTurn, replySoFar } from "./message-text";
import { ModelCallError, runEmployee, streamEmployee } from "./model";

export async function replyAsEmployee(employee: RoleDefinition, input: string): Promise<string> {
  const notes = await Promise.all(employee.skills.map((id) => readSkillText(id)));
  const result = await runEmployee({
    employee,
    skillIds: employee.skills,
    skillText: notes.filter(Boolean).join("\n\n"),
    input,
  });
  return composeReply(result.reasoning, result.text);
}

export async function streamChatTurn(
  employee: RoleDefinition,
  input: string,
  onDelta: (delta: { reasoning?: string; text?: string }) => void,
): Promise<{ reasoning: string; reply: string }> {
  const notes = await Promise.all(employee.skills.map((id) => readSkillText(id)));
  const result = await streamEmployee(
    {
      employee,
      skillIds: employee.skills,
      skillText: notes.filter(Boolean).join("\n\n"),
      input,
      kind: "chat",
    },
    onDelta,
  );
  if (!result.text && !result.reasoning) throw new ModelCallError("DeepSeek 没有给出回复");
  return { reasoning: result.reasoning, reply: result.text };
}

export async function streamProjectTurn(
  employee: RoleDefinition,
  input: string,
  onDelta: (delta: { reasoning?: string; text?: string }) => void,
): Promise<{ thinking: string; reply: string; reasoning: string }> {
  const notes = await Promise.all(employee.skills.map((id) => readSkillText(id)));
  const result = await streamEmployee(
    {
      employee,
      skillIds: employee.skills,
      skillText: notes.filter(Boolean).join("\n\n"),
      input,
      kind: "project",
    },
    onDelta,
  );
  const parsed = parseProjectTurn(result.text);
  return { thinking: parsed.thinking, reply: parsed.reply || replySoFar(result.text), reasoning: result.reasoning };
}
