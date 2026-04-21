import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { AgentExecutor } from "../executor";
import type { EventBus } from "../events";
import { CURRENT_MODEL_SENTINEL, type AgentEvents, type TeamMember, type TeamMemberOverrides, type TeamToolScope } from "../../types";
import { createSubConversation, getLatestLeaf, getSubConversations } from "../../db/queries/conversations";
import { getAgentConfig } from "../../db/queries/agent-configs";
import { logger } from "../../logger";
const log = logger.child("invoke-agent");

const DEFAULT_AGENT_TIMEOUT_MS = 60_000;

/** Resolve a model/provider value, substituting the sentinel with the parent's value. */
function resolveSentinel(value: string | undefined | null, fallback: string | undefined): string | undefined {
  if (value === CURRENT_MODEL_SENTINEL) return fallback;
  return value ?? undefined;
}

export interface InvokeAgentOpts {
  executor: AgentExecutor;
  bus: EventBus<AgentEvents>;
  parentConversationId: string;
  parentRunId: string;
  projectId: string;
  availableAgents: Array<{ id: string; name: string; description: string }>;
  /** Fallback model/provider from the parent conversation (used when agent config has none) */
  parentModel?: string;
  parentProvider?: string;
  /** Current orchestration depth (0 = top-level). Used to prevent infinite nesting. */
  depth?: number;
  /** Parent message ID to link sub-conversations to (for historical display after refresh) */
  parentMessageId?: string;
  /** Per-member overrides keyed by agentConfigId */
  memberOverrides?: Map<string, TeamMemberOverrides>;
  /** Sub-agent member tree for next nesting level */
  subAgentMembers?: TeamMember[];
  /**
   * Team-level tool scope (allow / deny lists). When set, overrides each
   * member's individual `toolRestriction` / `allowedTools` / `deniedTools`.
   * Applies only to invoked sub-members, not to the team orchestrator itself.
   */
  teamToolScope?: TeamToolScope;
  /** Override the default 60s timeout. Primarily a test hook so the Promise.race timeout
   *  branch can be exercised without a real minute-long wait. */
  timeoutMs?: number;
}

export function createInvokeAgentTool(opts: InvokeAgentOpts): AgentTool {
  const { executor, bus, parentConversationId, parentRunId, projectId, availableAgents, parentModel, parentProvider, depth = 0, parentMessageId: optParentMessageId, memberOverrides, subAgentMembers, teamToolScope, timeoutMs } = opts;
  const teamScopeActive = !!(teamToolScope && ((teamToolScope.allowedTools?.length ?? 0) > 0 || (teamToolScope.deniedTools?.length ?? 0) > 0));
  const AGENT_TIMEOUT_MS = timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const validIds = new Set(availableAgents.map((a) => a.id));

  return {
    name: "invoke_agent",
    label: "Invoke Agent",
    description:
      "Invoke a specialized agent to handle a task. The agent runs as an independent sub-conversation and returns its response. You can call this tool multiple times in parallel for independent tasks.",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        agentConfigId: {
          type: "string",
          description: "The ID of the agent to invoke.",
          enum: availableAgents.map((a) => a.id),
        },
        task: {
          type: "string",
          description: "A clear description of what the agent should do.",
        },
      },
      required: ["agentConfigId", "task"],
    }),

    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      const { agentConfigId, task } = params as { agentConfigId: string; task: string };
      log.info("invoke_agent called", { agentConfigId, task: task.slice(0, 100) });

      // Validate agent ID
      if (!validIds.has(agentConfigId)) {
        return {
          content: [{ type: "text" as const, text: `Error: Unknown agent "${agentConfigId}". Available: ${availableAgents.map((a) => a.name).join(", ")}` }],
          details: { isError: true },
        };
      }

      const agentInfo = availableAgents.find((a) => a.id === agentConfigId)!;

      // Load full config for model/provider preferences
      const config = await getAgentConfig(agentConfigId);
      if (!config) {
        return {
          content: [{ type: "text" as const, text: `Error: Agent config "${agentConfigId}" not found in database.` }],
          details: { isError: true },
        };
      }

      // Reuse existing sub-conversation for this agent (persistent context),
      // or create a new one on first invocation
      const existingSubConvos = await getSubConversations(parentConversationId);
      const existingAgentConv = existingSubConvos.find(sc => sc.agentConfigId === agentConfigId);

      let subConversationId: string;
      if (existingAgentConv) {
        subConversationId = existingAgentConv.id;
        log.info("Reusing existing agent sub-conversation", { subConversationId, agentName: agentInfo.name });
      } else {
        const subConv = await createSubConversation(projectId, {
          parentConversationId,
          parentMessageId: optParentMessageId,
          agentConfigId,
          systemPrompt: config.prompt,
          title: agentInfo.name,
        });
        subConversationId = subConv.id;
        log.info("Created new agent sub-conversation", { subConversationId, agentName: agentInfo.name });
      }
      const agentRunId = crypto.randomUUID();

      // Emit spawn event
      bus.emit("agent:spawn", {
        runId: parentRunId,
        agentRunId,
        subConversationId,
        agentName: agentInfo.name,
        agentConfigId,
        task,
        parentConversationId,
      });

      // Bridge run:status from agent to agent:status for parent
      const unsubStatus = bus.on("run:status", (data) => {
        if ((data as any).runId === agentRunId) {
          bus.emit("agent:status", {
            runId: parentRunId,
            subConversationId,
            agentName: agentInfo.name,
            status: (data as any).status,
          });
        }
      });

      // Timeout + parent cancellation
      const timeoutCtrl = new AbortController();
      const timeout = setTimeout(() => timeoutCtrl.abort(), AGENT_TIMEOUT_MS);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutCtrl.signal])
        : timeoutCtrl.signal;

      // Cancel sub-conversation on abort
      const onAbort = () => {
        executor.cancelRun(agentRunId);
      };
      combinedSignal.addEventListener("abort", onAbort, { once: true });

      // Resolve overrides for this member
      const overrides = memberOverrides?.get(agentConfigId);
      // Find this member's sub-agents for next nesting level
      const thisMember = subAgentMembers?.find(m => m.agentConfigId === agentConfigId);
      const nextSubAgents = thisMember?.subAgents;
      // Build memberOverrides map from next-level sub-agents
      let nextMemberOverrides: Map<string, TeamMemberOverrides> | undefined;
      if (nextSubAgents?.length) {
        nextMemberOverrides = new Map<string, TeamMemberOverrides>();
        for (const sa of nextSubAgents) {
          if (sa.overrides) nextMemberOverrides.set(sa.agentConfigId, sa.overrides);
        }
      }

      // Race the inner streamChat against the timeout signal. Previously this relied on
      // aborting the inner controller to throw out of `await streamChat`, but if streamChat's
      // underlying await is blocked in a non-abortable section (e.g. a hung provider request
      // that doesn't honour the signal), the outer promise would never settle and neither
      // success nor failure would reach the bus. The race guarantees we always emit
      // agent:complete exactly once, so observability, toasts, and UI chips stay in sync.
      try {
        const streamPromise = (async () => {
          await executor.streamChat(subConversationId, task, {
            projectId,
            agentConfigId,
            runId: agentRunId,
            model: resolveSentinel(overrides?.model, parentModel) ?? resolveSentinel(config.model, parentModel) ?? parentModel,
            provider: resolveSentinel(overrides?.provider, parentProvider) ?? resolveSentinel(config.provider, parentProvider) ?? parentProvider,
            system: overrides?.systemPromptAppend
              ? `${config.prompt}\n\n${overrides.systemPromptAppend}`
              : config.prompt,
            orchestrationDepth: depth + 1,
            permissionMode: overrides?.permissionMode ?? "yolo",
            // Team scope, when active, overrides per-member toolRestriction entirely.
            toolRestriction: teamScopeActive ? undefined : overrides?.toolRestriction,
            modeId: overrides?.modeId,
            // Team scope allow/deny wins over per-member lists.
            allowedTools: teamScopeActive
              ? teamToolScope!.allowedTools
              : overrides?.allowedTools,
            deniedTools: teamScopeActive
              ? teamToolScope!.deniedTools
              : overrides?.deniedTools,
            ...(nextSubAgents ? { subAgentMembers: nextSubAgents } : {}),
            ...(nextMemberOverrides?.size ? { memberOverrides: nextMemberOverrides } : {}),
          });
          return "ok" as const;
        })();

        const timeoutPromise = new Promise<"timeout">((resolve) => {
          if (timeoutCtrl.signal.aborted) {
            resolve("timeout");
            return;
          }
          timeoutCtrl.signal.addEventListener("abort", () => resolve("timeout"), { once: true });
        });

        const winner = await Promise.race([streamPromise, timeoutPromise]);

        if (winner === "timeout") {
          // Best-effort: ask the executor to cancel the inner run. Even if the inner await
          // never unblocks, we still emit agent:complete below so the parent run and UI
          // aren't stuck waiting for us.
          executor.cancelRun(agentRunId);
          const timeoutMsg = `Agent "${agentInfo.name}" timed out after ${Math.round(AGENT_TIMEOUT_MS / 1000)}s`;
          log.error("Agent timed out", { agentName: agentInfo.name, agentRunId, subConversationId });
          bus.emit("agent:complete", {
            runId: parentRunId,
            agentRunId,
            subConversationId,
            agentName: agentInfo.name,
            agentConfigId,
            success: false,
            resultPreview: timeoutMsg,
            parentConversationId,
          });
          return {
            content: [{ type: "text" as const, text: timeoutMsg }],
            details: { isError: true, _agentMeta: { subConversationId, agentName: agentInfo.name, agentConfigId } },
          };
        }

        // Fetch the agent's last response
        const leaf = await getLatestLeaf(subConversationId);
        log.info("Agent finished", { agentName: agentInfo.name, leafRole: leaf?.role, leafContentLen: leaf?.content?.length ?? 0, leafPreview: leaf?.content?.slice(0, 100) });
        const responseText = leaf?.content ?? "(Agent produced no response)";
        const preview = responseText.length > 200 ? responseText.slice(0, 200) + "..." : responseText;

        bus.emit("agent:complete", {
          runId: parentRunId,
          agentRunId,
          subConversationId,
          agentName: agentInfo.name,
          agentConfigId,
          success: true,
          resultPreview: preview,
          parentConversationId,
        });

        return {
          content: [{ type: "text" as const, text: responseText }],
          details: { _agentMeta: { subConversationId, agentName: agentInfo.name, agentConfigId } },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("Agent execution failed", { agentName: agentInfo.name, error: message, stack: err instanceof Error ? err.stack : undefined });

        bus.emit("agent:complete", {
          runId: parentRunId,
          agentRunId,
          subConversationId,
          agentName: agentInfo.name,
          agentConfigId,
          success: false,
          resultPreview: message.slice(0, 200),
          parentConversationId,
        });

        return {
          content: [{ type: "text" as const, text: `Agent "${agentInfo.name}" failed: ${message}` }],
          details: { isError: true, _agentMeta: { subConversationId, agentName: agentInfo.name, agentConfigId } },
        };
      } finally {
        clearTimeout(timeout);
        combinedSignal.removeEventListener("abort", onAbort);
        unsubStatus();
      }
    },
  };
}
