import { z } from "zod";

const roleIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const workItemKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const artifactRefSchema = z.string().trim().min(1).max(700);

export const decisionScopeSchema = z.enum(["current", "current_and_dependents"]);

export const decisionOptionSchema = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(300),
  impact: z.string().trim().min(1),
});

export const writeIntentSchema = z.object({
  includes: z.array(z.string().trim().min(1).max(500)).min(1),
  excludes: z.array(z.string().trim().min(1).max(500)).default([]),
});

export const workItemProposalSchema = z.object({
  key: workItemKeySchema,
  title: z.string().trim().min(1).max(300),
  objective: z.string().trim().min(1),
  acceptance: z.array(z.string().trim().min(1)).min(1),
  ownerRoleId: roleIdSchema,
  reviewerRoleId: roleIdSchema.nullable().optional(),
  dependsOn: z.array(workItemKeySchema).default([]),
  writeIntent: writeIntentSchema.optional(),
});

export const verificationCheckSchema = z.object({
  acceptance: z.string().trim().min(1),
  status: z.enum(["passed", "failed", "not_checked"]),
  evidenceRefs: z.array(artifactRefSchema),
  note: z.string().trim(),
});

export const agentActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("speak"), text: z.string().trim().min(1) }),
  z.object({
    type: z.literal("call_tool"),
    tool: z.string().trim().min(1).max(160),
    arguments: z.unknown(),
  }),
  z.object({ type: z.literal("propose_plan"), items: z.array(workItemProposalSchema).min(1).max(12) }),
  z.object({
    type: z.literal("raise_objection"),
    targetKey: workItemKeySchema,
    reason: z.string().trim().min(1).max(500),
    evidenceRefs: z.array(artifactRefSchema),
  }),
  z.object({
    type: z.literal("handoff"),
    targetRole: roleIdSchema,
    reason: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("request_decision"),
    scope: decisionScopeSchema,
    question: z.string().trim().min(1),
    options: z.array(decisionOptionSchema).min(2).max(5),
    recommendation: z.string().trim().min(1).max(40),
    reason: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("submit_review"),
    summary: z.string().trim().min(1),
    evidenceRefs: z.array(artifactRefSchema).min(1),
    checks: z.array(verificationCheckSchema).min(1),
  }),
  z.object({
    type: z.literal("report_blocked"),
    code: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    detail: z.string().trim().min(1),
  }),
]);

export type DecisionScope = z.infer<typeof decisionScopeSchema>;
export type WorkItemProposal = z.infer<typeof workItemProposalSchema>;
export type AgentAction = z.infer<typeof agentActionSchema>;

