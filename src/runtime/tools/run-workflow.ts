/**
 * `run_workflow` — execute a workflow from inside a chat turn.
 *
 * Reference and execution are deliberately split. A `!workflow:<name>`
 * mention only adds a NOTE describing the workflow (name, description,
 * `inputSchema`); it never fires anything, because the mention grammar
 * carries a bare name and a workflow takes arbitrary JSON input. This tool
 * is the execution half: the LLM reads the note, composes the input object
 * from conversation context, and calls it.
 *
 * ── Not in `getBuiltinToolDefs()` ──────────────────────────────────────
 *
 * Same reason the Ez tools aren't (see `tools/ez/index.ts`): this is a
 * per-turn factory over per-USER context (`userId`, `conversationId`,
 * `projectId`) and needs no project root, so caching it alongside the
 * project-rooted built-ins would leak one conversation's coordinates into
 * another across a project switch. It is wired per turn by
 * `wireRunWorkflowForTurn` (`runtime/workflow-tools-host.ts`) and is
 * likewise absent from the `/api/tools` metadata listing.
 *
 * ── Security ───────────────────────────────────────────────────────────
 *
 * Every RBAC coordinate comes from the turn closure, never from the tool
 * schema — an argument is LLM-controlled, and letting the model choose its
 * own `conversationId` / `userId` / `projectId` is letting it choose its
 * own authorization. The schema has exactly two fields: `name` and `input`.
 *
 * Authorization is `canRunWorkflow` — the SAME helper `POST
 * /api/workflows/[name]/run` uses, so the chat path and the REST path can
 * never disagree about who may run what. It is handed the definition
 * resolved out of the MERGED CACHE (the object the executor will actually
 * run), never a re-lookup by name: on a YAML/DB name collision a re-lookup
 * would authorize a different object than the one that executes.
 */
import { Type } from "@earendil-works/pi-ai";
import { errorMessage, toolError, type BuiltinToolDef } from "./types";
import type { WorkflowRun } from "../../types";
import type { PendingPermissionGate } from "../workflow-tool-runner";
import { getWorkflowRuntime } from "../workflow/runtime-registry";
import { canRunWorkflow } from "../workflow-authz";
import { getUserById } from "../../db/queries/users";
import { getToolOutputLimit, truncateText } from "./output-limits";

export const RUN_WORKFLOW_TOOL_NAME = "run_workflow";

/**
 * Per-call watchdog budget: 10 minutes, matching `shell`.
 *
 * A workflow is a graph of agent turns and tool calls, so it routinely
 * outlives the undeclared-built-in default (`DEFAULT_BUILTIN_CALL_TIMEOUT_MS`,
 * which equals `WATCHDOG_IDLE_MS` = 90s and would kill the surrounding run
 * mid-workflow). Bounded, not indefinite — a genuinely wedged workflow must
 * still be reaped. Time spent waiting on a consent card does NOT burn this
 * budget: an open gate registers in `host.pendingPermissions`, which the
 * watchdog defers on indefinitely.
 */
export const RUN_WORKFLOW_CALL_TIMEOUT_MS = 600_000;

/** Per-turn context, supplied entirely by the host wire. */
export interface RunWorkflowToolContext {
  /** Conversation OWNER. The principal `canRunWorkflow` gates on and the
   *  `userId` the run's `workflow:*` events are delivered to. */
  userId: string;
  /** The REAL conversation this turn belongs to. Presence is what makes the
   *  run interactive, so a sensitive step can render a consent card the
   *  user can actually answer. */
  conversationId: string;
  /** RBAC/project coordinate, derived server-side from the conversation. */
  projectId?: string;
  /** Watchdog visibility for a parked consent card — see
   *  {@link PendingPermissionGate}. */
  pendingPermissions?: PendingPermissionGate;
}

/**
 * What the LLM gets back — a PROJECTION of `WorkflowRun`, not the row.
 *
 * The raw run carries per-step `runId`s and epoch timestamps the model
 * cannot use, and an unbounded `result`. This keeps the shape the model
 * needs to explain what happened: the terminal status, the per-step
 * outcome, the final output, and the error.
 */
export interface RunWorkflowToolResult {
  runId: string;
  workflowName: string;
  status: string;
  steps: Array<{ name: string; status: string; iterations?: number }>;
  result: unknown;
  error: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function projectWorkflowRun(run: WorkflowRun): RunWorkflowToolResult {
  return {
    runId: run.id,
    workflowName: run.workflowName,
    status: run.status,
    steps: run.steps.map((step) => ({
      name: step.stepName,
      status: step.status,
      ...(step.iterations !== undefined ? { iterations: step.iterations } : {}),
    })),
    result: run.result?.output ?? null,
    error: run.result?.error ?? null,
  };
}

export function createRunWorkflowTool(ctx: RunWorkflowToolContext): BuiltinToolDef {
  const maxOutputBytes = getToolOutputLimit(RUN_WORKFLOW_TOOL_NAME);
  return {
    name: RUN_WORKFLOW_TOOL_NAME,
    label: RUN_WORKFLOW_TOOL_NAME,
    description:
      "Run a named workflow (a saved multi-step graph of agent and tool steps) and wait for it to finish. " +
      "Use the exact name from the workflow note a `!workflow:<name>` mention added to the conversation. " +
      "Compose `input` to match that workflow's declared inputSchema. " +
      "Steps needing sensitive permissions prompt the user; a declined prompt fails the run.",
    category: "execute",
    // WorkflowRunCard renders this projection verbatim (name, status,
    // per-step outcome, result, error) so the card is byte-for-byte
    // identical between two runs on identical input — the model's PROSE
    // above it is not, and used to be the only rendering of the result
    // (`cardType: "default"` truncates and starts collapsed).
    cardType: "workflow-run",
    maxOutputBytes,
    callTimeoutMs: RUN_WORKFLOW_CALL_TIMEOUT_MS,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Exact name of the workflow to run.",
        },
        input: {
          type: "object",
          description:
            "Input object for the workflow, matching its inputSchema. Omit for a workflow that takes none.",
          additionalProperties: true,
        },
      },
      required: ["name"],
    }),
    execute: async (_toolCallId, params: unknown, signal?: AbortSignal) => {
      try {
        const { name, input } = (params ?? {}) as { name?: unknown; input?: unknown };
        const workflowName = typeof name === "string" ? name.trim() : "";
        if (!workflowName) return toolError("`name` is required");
        if (input !== undefined && !isPlainObject(input)) {
          return toolError("`input` must be a JSON object");
        }

        // Null on a backend-only or CLI boot: nothing has registered the
        // live executor, so there is no workflow to run. A clean error
        // result, never a throw.
        const runtime = getWorkflowRuntime();
        if (!runtime) {
          return toolError("workflows are not available in this process");
        }

        // Resolved out of the PROVENANCE-carrying cache: the ladder
        // authorizes an owner and a visibility, and a bare definition
        // carries neither. Same lookup order the REST path resolves
        // through, so the two cannot disagree about which object runs.
        //
        // Fails CLOSED when the registration cannot supply it — a process
        // that cannot say who owns a workflow does not get to run one on
        // an LLM's say-so.
        const cached = runtime.getCachedWorkflows?.();
        if (!cached) {
          return toolError("workflow authorization is unavailable in this process");
        }
        const entry = cached.find((e) => e.definition.name === workflowName);
        if (!entry) return toolError(`no workflow named "${workflowName}"`);

        // The role is read from the DB, not carried on the turn: the
        // ladder needs it and nothing LLM-reachable may supply it. A
        // vanished user row fails CLOSED.
        const user = await getUserById(ctx.userId);
        if (!user) {
          return toolError("the acting user could not be resolved, so the run was not authorized");
        }

        const decision = await canRunWorkflow(
          entry,
          { id: user.id, role: user.role },
          ctx.projectId,
        );
        if (!decision.allowed) return toolError(decision.reason);

        const run = await runtime.workflowExecutor.runWorkflow(
          entry.definition,
          input ?? {},
          ctx.projectId,
          ctx.userId,
          // Cancelling the chat turn cancels the workflow with it.
          signal,
          {
            conversationId: ctx.conversationId,
            ...(ctx.pendingPermissions ? { pendingPermissions: ctx.pendingPermissions } : {}),
          },
        );

        const projection = projectWorkflowRun(run);
        // Structured on BOTH paths — the model has to be able to explain a
        // failure, not just see a red card, so the failing step list and
        // the error survive into the text.
        const { text } = truncateText(
          JSON.stringify(projection),
          maxOutputBytes,
          RUN_WORKFLOW_TOOL_NAME,
        );
        return {
          content: [{ type: "text" as const, text }],
          details: { ...projection, isError: run.status !== "success" },
        };
      } catch (e) {
        return toolError(errorMessage(e));
      }
    },
  };
}
