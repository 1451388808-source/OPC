import { RuleError } from "../domain/task.ts";

export type ProjectMessageIntent =
  | { type: "conversation" }
  | { type: "new_workflow"; title: string }
  | { type: "workflow_input"; workflowId: string }
  | { type: "decision_answer"; decisionId: string }
  | { type: "review_action"; workflowId: string; action: "approve" | "return" | "cancel" };

export type ProjectMessageRoute = {
  text: string;
  intent: ProjectMessageIntent;
  confidence: "explicit" | "high" | "medium";
  reason: string;
};

export type ProjectMessageRouteContext = {
  override?: "conversation" | "task";
  workflowId?: string;
  decisionId?: string;
  reviewAction?: "approve" | "return" | "cancel";
};

const TASK_MARKER = /^(?:任务|执行|开工)\s*[:：]\s*/;
const TASK_VERB = /(完成|实现|读取|替换|换成|换|调整|修改|改进|改|新增|创建|修复|调查|整理|生成|编写|写|运行|启动|更新|删除|优化|测试|制作|迁移|重构|接入|设计|补充|搭建|开发)/;
const COLLOQUIAL_TASK_VERB = /(?:^|[，。,.\s])(?:我想|我要|请|帮我|给我|麻烦)?(?:做|弄|写|建|搭)(?:一个|一份|个|份)?/;
const DELIVERABLE = /(文件|页面|网页|网站|首页|界面|交互|样式|按钮|文字|内容|文案|简历|功能|接口|测试|文档|报告|方案|代码|流程|表格|系统|项目|模块|数据库|服务|脚本|组件|说明|README|配置)/i;
const TARGET_REFERENCE = /(这里|这边|这个|当前|上面|下面|刚才|前面)/;
const PROBLEM_REPORT = /(有问题|不对|不正常|坏了|失败|报错|卡住|很卡|不能用|没反应)/;
const WORKFLOW_FOLLOW_UP = /(按(?:你|这个|上面|刚才)|照(?:这个|上面)|继续|接着|不用|不需要|就这样|保持.+不动|前面.+改|补充要求)/;
const QUESTION = /(是什么|为什么|怎么|如何|能否|是否|多少|哪个|哪些|哪里|谁|吗|呢)[？?]?$/;

function titleFromMessage(text: string): string {
  const cleaned = text.replace(TASK_MARKER, "").trim();
  const chars = Array.from(cleaned);
  return chars.length <= 40 ? cleaned : `${chars.slice(0, 40).join("")}…`;
}

function requireMessage(text: string): string {
  const message = text.trim();
  if (!message) throw new RuleError("先写一句话");
  if (Array.from(message).length > 20_000) throw new RuleError("项目消息太长");
  return message;
}

export function isWorkflowFollowUp(text: string): boolean {
  return WORKFLOW_FOLLOW_UP.test(text.trim());
}

export function routeProjectMessage(
  text: string,
  context: ProjectMessageRouteContext = {},
): ProjectMessageRoute {
  const message = requireMessage(text);

  if (context.reviewAction) {
    if (!context.workflowId) throw new RuleError("验收动作缺少协作任务");
    return {
      text: message,
      intent: { type: "review_action", workflowId: context.workflowId, action: context.reviewAction },
      confidence: "explicit",
      reason: "用户通过明确的验收控件提交动作。",
    };
  }
  if (context.decisionId) {
    return {
      text: message,
      intent: { type: "decision_answer", decisionId: context.decisionId },
      confidence: "explicit",
      reason: "消息从待决问题卡片提交。",
    };
  }
  if (context.workflowId) {
    return {
      text: message,
      intent: { type: "workflow_input", workflowId: context.workflowId },
      confidence: "explicit",
      reason: "用户明确选择了要补充的协作任务。",
    };
  }
  if (context.override === "conversation") {
    return {
      text: message,
      intent: { type: "conversation" },
      confidence: "explicit",
      reason: "用户明确指定为普通交流。",
    };
  }
  if (context.override === "task") {
    return {
      text: message,
      intent: { type: "new_workflow", title: titleFromMessage(message) },
      confidence: "explicit",
      reason: "用户明确指定为新任务。",
    };
  }

  if (TASK_MARKER.test(message)) {
    return {
      text: message,
      intent: { type: "new_workflow", title: titleFromMessage(message) },
      confidence: "high",
      reason: "消息使用了明确的任务前缀。",
    };
  }

  const isQuestion = QUESTION.test(message) || /[？?]$/.test(message);
  if (isQuestion) {
    return {
      text: message,
      intent: { type: "conversation" },
      confidence: "high",
      reason: "消息是解释或信息型问题，没有明确交付动作。",
    };
  }

  const hasTarget = DELIVERABLE.test(message) || TARGET_REFERENCE.test(message);

  if (COLLOQUIAL_TASK_VERB.test(message) && hasTarget) {
    return {
      text: message,
      intent: { type: "new_workflow", title: titleFromMessage(message) },
      confidence: "high",
      reason: "消息使用口语执行动作并给出了明确交付物。",
    };
  }

  if (TASK_VERB.test(message) && hasTarget) {
    return {
      text: message,
      intent: { type: "new_workflow", title: titleFromMessage(message) },
      confidence: "high",
      reason: "消息同时包含执行动作和可交付对象。",
    };
  }

  if (PROBLEM_REPORT.test(message) && hasTarget && !isQuestion) {
    return {
      text: message,
      intent: { type: "new_workflow", title: titleFromMessage(message) },
      confidence: "high",
      reason: "消息报告了明确对象的问题，需要进入修复流程。",
    };
  }

  if (TASK_VERB.test(message) && !isQuestion) {
    return {
      text: message,
      intent: { type: "conversation" },
      confidence: "medium",
      reason: "消息包含执行动作，但交付对象不够明确；为避免误执行，先按普通交流处理。",
    };
  }

  return {
    text: message,
    intent: { type: "conversation" },
    confidence: "medium",
    reason: "没有识别到明确的交付动作，按普通交流处理。",
  };
}

