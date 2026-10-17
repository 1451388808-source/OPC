import type { ProjectWorkflow, ProjectWorkItem } from "../domain/collaboration.ts";

const statusQuestion = /(做完|完成了|完成没|进度|到哪|怎么样了|状态|还要多久|卡住|为什么没|怎么还没)/;

export function isWorkflowStatusQuestion(text: string): boolean {
  return statusQuestion.test(text.trim());
}

export function workflowStatusMessage(input: {
  workflow: ProjectWorkflow;
  items: ProjectWorkItem[];
  resumed?: boolean;
}): string {
  const { workflow, items } = input;
  const done = items.filter((item) => item.status === "done").length;
  const total = items.length;
  const progress = total > 0 ? `已完成 ${done}/${total} 个工作项。` : "";
  const blocked = items.find((item) => item.status === "blocked");
  const running = items.find((item) => item.status === "running");
  const ready = items.find((item) => item.status === "ready");

  if (input.resumed) {
    return `还没完成。${progress}系统检测到可自动修复的执行阻塞，已经恢复任务并继续调度员工；你不需要选择员工。`;
  }
  if (workflow.status === "waiting_user") {
    const reason = blocked?.blockedReason.replace(/^[a-z][a-z0-9_]+:\s*/i, "") || "存在需要老板决定的事项";
    return `还没完成。${progress}当前卡在「${blocked?.title ?? workflow.title}」：${reason}`;
  }
  if (workflow.status === "collaborating") {
    const current = running ?? ready;
    return `还没完成。${progress}${current ? `团队正在处理「${current.title}」。` : "团队正在安排下一项工作。"}`;
  }
  if (workflow.status === "verifying") return `主体工作已经完成。${progress}团队正在汇总验证证据。`;
  if (workflow.status === "review") return `团队已经完成并提交验收。${progress}现在只等你最终批准或退回。`;
  if (workflow.status === "applying") return "团队已经完成验收，正在检查冲突并应用文件。";
  if (workflow.status === "approved") return `已经完成并批准。${workflow.summary ? `摘要：${workflow.summary}` : ""}`;
  if (workflow.status === "failed") return `任务执行失败：${workflow.errorText || "没有记录失败原因"}`;
  if (workflow.status === "cancelled") return "这项任务已经取消。";
  return `任务当前处于 ${workflow.status}。${progress}`;
}

