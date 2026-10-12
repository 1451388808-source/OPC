import { z } from "zod";
import { PRIORITIES, STATUSES, type Priority, type Status, type Task } from "./task";

export const taskSchema = z.object({
  id: z.string().regex(/^t-\d{3}$/),
  title: z.string().min(1),
  brief: z.string(),
  goal: z.string(),
  acceptance: z.array(z.string()),
  role: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  status: z.enum(STATUSES),
  priority: z.enum(PRIORITIES),
  artifacts: z.array(z.string()),
  notes: z.string(),
  needsApproval: z.boolean(),
  blockReason: z.string(),
  decision: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type { Priority, Status, Task };
