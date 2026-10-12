export const STATUSES = ["inbox", "doing", "review", "blocked", "done"] as const;
export const PRIORITIES = ["now", "next", "later"] as const;

export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];

export type Task = {
  id: string;
  title: string;
  brief: string;
  goal: string;
  acceptance: string[];
  role: string;
  status: Status;
  priority: Priority;
  artifacts: string[];
  notes: string;
  needsApproval: boolean;
  blockReason: string;
  decision: string | null;
  createdAt: string;
  updatedAt: string;
};

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
  }
}

const DOING_LIMIT = 2;

export function doingCount(tasks: Pick<Task, "status" | "priority">[]): number {
  return tasks.filter((task) => task.status === "doing" && task.priority === "now").length;
}

export function inboxPriority(currentDoing: number): Priority {
  return currentDoing === 0 ? "now" : "next";
}

export function nextTaskId(ids: string[]): string {
  let max = 0;
  for (const id of ids) {
    const value = Number(id.slice(2));
    if (Number.isInteger(value) && value > max) max = value;
  }
  return `t-${String(max + 1).padStart(3, "0")}`;
}

export function titleFromBrief(brief: string): string {
  const chars = Array.from(brief.trim());
  if (chars.length <= 32) return chars.join("");
  return `${chars.slice(0, 32).join("")}…`;
}

export function appendNote(notes: string, stamp: string, actor: string, text: string): string {
  const line = `${stamp} · ${actor} · ${text}`;
  const current = notes.trim();
  return current ? `${current}\n${line}` : line;
}

export function deliverableIsDecision(task: Pick<Task, "goal" | "acceptance">): boolean {
  return `${task.goal}\n${task.acceptance.join("\n")}`.includes("决定");
}

export function approveTask(
  task: Task,
  decision: string,
  stamp: string,
  iso: string,
): Task {
  if (task.status !== "review") throw new RuleError("只有待批准的任务可以批准");
  const text = decision.trim();
  if (!text) throw new RuleError("结论不能为空");
  if (task.artifacts.length === 0 && !deliverableIsDecision(task)) {
    throw new RuleError("没有产出，不能批准");
  }
  return {
    ...task,
    status: "done",
    decision: text,
    notes: appendNote(task.notes, stamp, "你", `批准。${text}`),
    updatedAt: iso,
  };
}

export function returnTask(
  task: Task,
  reason: string,
  currentDoing: number,
  stamp: string,
  iso: string,
): Task {
  if (task.status !== "review") throw new RuleError("只有待批准的任务可以退回");
  const text = reason.trim();
  if (!text) throw new RuleError("退回原因不能为空");
  if (currentDoing >= DOING_LIMIT) throw new RuleError("进行中已满 2 条，不能退回");
  return {
    ...task,
    status: "doing",
    notes: appendNote(task.notes, stamp, "你", `退回。${text}`),
    updatedAt: iso,
  };
}

export function promoteTask(
  task: Task,
  currentDoing: number,
  iso: string,
): Task {
  if (task.priority !== "next") throw new RuleError("只有接下来的任务可以提为现在");
  if (task.status === "doing" && currentDoing >= DOING_LIMIT) {
    throw new RuleError("进行中已满 2 条，不能提为现在");
  }
  return { ...task, priority: "now", updatedAt: iso };
}

export const BLOCK_REASON = "目标已变，需重新规划";
