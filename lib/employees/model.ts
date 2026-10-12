import type { RoleDefinition } from "../domain/role";
import { callDeepSeek, deepseekProvider, streamDeepSeek, type DeepSeekDelta } from "./deepseek";

export type EmployeeRunRequest = {
  employee: RoleDefinition;
  skillIds: string[];
  skillText: string;
  input: string;
  kind?: "chat" | "project";
};

export type EmployeeRunResult = {
  text: string;
  reasoning: string;
};

export class ModelNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelNotConnectedError";
  }
}

export class ModelCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelCallError";
  }
}

/** 按 provider 注册调用。deepseek 在加载这个文件时注册。 */
export interface EmployeeModel {
  run(request: EmployeeRunRequest): Promise<EmployeeRunResult>;
}

const adapters = new Map<string, EmployeeModel>();

export function registerModel(provider: string, adapter: EmployeeModel): void {
  adapters.set(provider, adapter);
}

function systemPrompt(request: EmployeeRunRequest): string {
  const skills = request.skillText.trim();
  const role = request.employee.prompt.trim() || `你是 OPC 的${request.employee.name}。`;
  if (request.kind === "project") {
    return [
      role,
      skills ? `按这些技能做：\n${skills}` : "",
      "你在这个项目里工作，和老板、其他员工看同一段对话。",
      "这一轮只是项目群聊，没有文件工具。老板要求创建或修改文件时，不要评审旧任务、不要说「不接」，也不要展开解释限制；回复段只简短提示：请选择一名员工并点击「执行任务」。",
      "先写你对这个项目的思考，只写一两句：项目现在是什么情况、还缺什么。不要展开，不要写怎么措辞。",
      "格式固定为两段：第一段以「对项目的思考：」开头，第二段以「回复：」开头。回复里只写要说进对话的话。",
      "用中文。不要假装已经改了仓库。",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return [role, skills ? `按这些技能做：\n${skills}` : "", "用中文回复。这一轮只说你要回复的话，不要假装已经改了仓库。"]
    .filter(Boolean)
    .join("\n\n");
}

registerModel(deepseekProvider, {
  async run(request) {
    try {
      const result = await callDeepSeek({
        model: request.employee.model.model,
        system: systemPrompt(request),
        user: request.input,
      });
      return { text: result.text, reasoning: result.reasoning };
    } catch (error) {
      const message = error instanceof Error ? error.message : "模型没有回应";
      if (message === "还没有配置 DeepSeek 密钥") throw new ModelNotConnectedError(message);
      throw new ModelCallError(message);
    }
  },
});

export async function streamEmployee(
  request: EmployeeRunRequest,
  onDelta: (delta: DeepSeekDelta) => void,
): Promise<EmployeeRunResult> {
  const { provider, model } = request.employee.model;
  if (!provider || !model) {
    throw new ModelNotConnectedError(`${request.employee.name} 还没有接入模型`);
  }
  if (provider !== deepseekProvider) {
    throw new ModelNotConnectedError(`${provider}/${model} 的调用还没有接上`);
  }
  try {
    return await streamDeepSeek(
      { model, system: systemPrompt(request), user: request.input },
      onDelta,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "模型没有回应";
    if (message === "还没有配置 DeepSeek 密钥") throw new ModelNotConnectedError(message);
    throw new ModelCallError(message);
  }
}

export async function runEmployee(request: EmployeeRunRequest): Promise<EmployeeRunResult> {
  const { provider, model } = request.employee.model;
  if (!provider || !model) {
    throw new ModelNotConnectedError(`${request.employee.name} 还没有接入模型`);
  }
  const adapter = adapters.get(provider);
  if (!adapter) {
    throw new ModelNotConnectedError(`${provider}/${model} 的调用还没有接上`);
  }
  return adapter.run(request);
}
