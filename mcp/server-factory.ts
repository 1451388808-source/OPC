import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { migrate, getPool } from "../lib/infrastructure/db.ts";
import { getProject, listMemberIds } from "../lib/infrastructure/org-store.ts";
import {
  getProjectWorkflow,
  getProjectWorkItem,
  listOpenWorkflowDecisionRequests,
  listWorkflowArtifacts,
  listWorkflowDependencies,
} from "../lib/infrastructure/collaboration-store.ts";
import { projectWorkspace, type WorkspaceEntry } from "../lib/project-workspace/index.ts";
import { workflowWorkspace } from "../lib/project-workspace/workflow-workspace.ts";
import { shanghaiTime } from "../lib/domain/time.ts";
import { runValidationProfile } from "../lib/project-workspace/validation.ts";
import { requestWorkflowDecisionByScope } from "../lib/application/collaboration.ts";

let ready: Promise<void> | null = null;

function ensureMcpReady(): Promise<void> {
  ready ??= migrate();
  return ready;
}

const contextSchema = z.object({
  workflowId: z.string().regex(/^wf-[0-9a-f-]{36}$/i),
  workItemId: z.string().regex(/^wi-[0-9a-f-]{36}$/i),
  roleId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
});

async function authorizeContext(input: z.infer<typeof contextSchema>, access: "read" | "write" = "read") {
  await ensureMcpReady();
  const pool = getPool();
  const workflow = await getProjectWorkflow(pool, input.workflowId);
  if (!workflow) throw new Error("找不到这个协作任务");
  const item = await getProjectWorkItem(pool, input.workItemId);
  if (!item || item.workflowId !== workflow.id) throw new Error("工作项不属于这个协作任务");
  const project = await getProject(pool, workflow.projectId);
  if (!project) throw new Error("找不到这个项目");
  const members = await listMemberIds(pool, workflow.projectId);
  if (!members.includes(input.roleId)) throw new Error("员工不在这个项目中");
  const isReviewer = item.reviewerRoleId === input.roleId;
  if (item.ownerRoleId !== input.roleId && workflow.coordinatorRoleId !== input.roleId && !isReviewer) {
    throw new Error("员工无权访问这个工作项的工具上下文");
  }
  if (item.status === "cancelled") throw new Error("已取消的工作项不能调用工具");
  if (access === "write") {
    if (item.ownerRoleId !== input.roleId) throw new Error("只有工作项主责员工可以暂存文件");
    if (item.status !== "running") throw new Error("工作项必须先进入执行中才能暂存文件");
  }
  return { workflow, item, project };
}

export function createOpcMcpServer(): McpServer {
  const server = new McpServer(
    { name: "opc-local", version: "0.4.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "opc.project.list_files",
    {
      title: "List project files",
      description: "List visible files inside the authorized OPC project workspace.",
      inputSchema: contextSchema.extend({
        path: z.string().default("."),
        depth: z.number().int().min(1).max(5).default(2),
      }),
      outputSchema: z.object({
        entries: z.array(
          z.object({
            path: z.string(),
            type: z.enum(["file", "directory"]),
            size: z.number().int().nonnegative(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      const { project } = await authorizeContext(input);
      const workspace = projectWorkspace({ companyId: project.companyId, projectId: project.id });
      let entries: WorkspaceEntry[];
      try {
        entries = await workspace.list({ path: input.path, depth: input.depth });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        entries = [];
      }
      const { workflow } = await authorizeContext(input);
      const staged = await workflowWorkspace({
        companyId: project.companyId,
        projectId: project.id,
        workflowId: workflow.id,
      }).changes();
      const byPath = new Map(entries.map((entry) => [entry.path, entry]));
      for (const change of staged) {
        if (input.path !== "." && !change.path.startsWith(`${input.path.replace(/\/$/, "")}/`)) continue;
        byPath.set(change.path, { path: change.path, type: "file", size: change.afterSize });
      }
      const output = { entries: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)) };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "opc.project.stage_write",
    {
      title: "Stage project file",
      description: "Stage one UTF-8 project file in the shared workflow workspace without changing formal files.",
      inputSchema: contextSchema.extend({
        path: z.string().min(1).max(500),
        content: z.string(),
        baseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
      }),
      outputSchema: z.object({
        path: z.string(),
        operation: z.enum(["create", "update"]),
        beforeSha256: z.string().nullable(),
        afterSha256: z.string(),
        beforeSize: z.number().int().nonnegative(),
        afterSize: z.number().int().nonnegative(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      const { workflow, project } = await authorizeContext(input, "write");
      const workspace = workflowWorkspace({
        companyId: project.companyId,
        projectId: project.id,
        workflowId: workflow.id,
      });
      const output = await workspace.write({
        path: input.path,
        content: input.content,
        baseSha256: input.baseSha256,
        workItemId: input.workItemId,
        roleId: input.roleId,
        updatedAt: shanghaiTime().iso,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "opc.project.get_diff",
    {
      title: "Get staged diff",
      description: "Read the unified diff for one staged workflow file.",
      inputSchema: contextSchema.extend({ path: z.string().min(1).max(500) }),
      outputSchema: z.object({ path: z.string(), diff: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      const { workflow, project } = await authorizeContext(input);
      const workspace = workflowWorkspace({
        companyId: project.companyId,
        projectId: project.id,
        workflowId: workflow.id,
      });
      const output = { path: input.path, diff: await workspace.diff(input.path) };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "opc.project.list_changes",
    {
      title: "List staged changes",
      description: "List workflow-level staged changes and their current work-item leases.",
      inputSchema: contextSchema,
      outputSchema: z.object({
        changes: z.array(
          z.object({
            path: z.string(),
            operation: z.enum(["create", "update"]),
            beforeSha256: z.string().nullable(),
            afterSha256: z.string(),
            beforeSize: z.number().int().nonnegative(),
            afterSize: z.number().int().nonnegative(),
            lease: z
              .object({
                path: z.string(),
                workItemId: z.string(),
                roleId: z.string(),
                updatedAt: z.string(),
              })
              .nullable(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      const { workflow, project } = await authorizeContext(input);
      const workspace = workflowWorkspace({
        companyId: project.companyId,
        projectId: project.id,
        workflowId: workflow.id,
      });
      const output = { changes: await workspace.changes() };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "opc.project.read_file",
    {
      title: "Read project file",
      description: "Read one authorized UTF-8 text file from the OPC project workspace.",
      inputSchema: contextSchema.extend({ path: z.string().min(1).max(500) }),
      outputSchema: z.object({
        path: z.string(),
        content: z.string(),
        size: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      const { workflow, project } = await authorizeContext(input);
      const workspace = workflowWorkspace({
        companyId: project.companyId,
        projectId: project.id,
        workflowId: workflow.id,
      });
      const output = await workspace.read(input.path);
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "opc.workflow.get_context",
    {
      title: "Get workflow context",
      description: "Read the authorized workflow, work item, dependencies, decisions, and artifacts.",
      inputSchema: contextSchema,
      outputSchema: z.object({
        workflow: z.record(z.string(), z.unknown()),
        workItem: z.record(z.string(), z.unknown()),
        dependencies: z.array(z.record(z.string(), z.unknown())),
        openDecisions: z.array(z.record(z.string(), z.unknown())),
        artifacts: z.array(z.record(z.string(), z.unknown())),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      const { workflow, item } = await authorizeContext(input);
      const pool = getPool();
      const output = {
        workflow,
        workItem: item,
        dependencies: await listWorkflowDependencies(pool, workflow.id),
        openDecisions: await listOpenWorkflowDecisionRequests(pool, workflow.id),
        artifacts: await listWorkflowArtifacts(pool, workflow.id),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "opc.validation.run",
    {
      title: "Run validation profile",
      description: "Run a configured or first-party built-in validation command in a materialized workflow sandbox.",
      inputSchema: contextSchema.extend({
        profile: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
      }),
      outputSchema: z.object({
        profile: z.string(),
        command: z.array(z.string()),
        exitCode: z.number().int().nullable(),
        signal: z.string().nullable(),
        timedOut: z.boolean(),
        durationMs: z.number().int().nonnegative(),
        stdout: z.string(),
        stderr: z.string(),
        stdoutTruncated: z.boolean(),
        stderrTruncated: z.boolean(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      const { workflow, project } = await authorizeContext(input);
      const output = await runValidationProfile({
        companyId: project.companyId,
        projectId: project.id,
        workflowId: workflow.id,
        profile: input.profile,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "opc.workflow.request_decision",
    {
      title: "Request user decision",
      description: "Pause specified work items and ask the boss to choose between structured options.",
      inputSchema: contextSchema.extend({
        scope: z.enum(["current", "current_and_dependents"]),
        question: z.string().min(1),
        options: z
          .array(z.object({ id: z.string().min(1), label: z.string().min(1), impact: z.string().min(1) }))
          .min(2)
          .max(5),
        recommendation: z.string().min(1),
        reason: z.string().min(1),
      }),
      outputSchema: z.object({ decisionId: z.string(), workflowStatus: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      await authorizeContext(input);
      const output = await requestWorkflowDecisionByScope({
        workflowId: input.workflowId,
        currentWorkItemId: input.workItemId,
        askedByRoleId: input.roleId,
        scope: input.scope,
        question: input.question,
        options: input.options,
        recommendation: input.recommendation,
        reason: input.reason,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  return server;
}

