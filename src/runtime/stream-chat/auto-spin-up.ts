import { logger } from "../../logger";
import type { StreamChatContext } from "./context";
import type { StreamChatHost } from "./host";
import type { OrchestratedRun } from "./setup-tools";

const log = logger.child("executor.streamChat.autoSpinUp");

/**
 * Max `invoke_agent` calls fanned out concurrently per wave. The orchestration
 * extension's manifest allows `maxConcurrent: 25`, but auto-spin-up stays
 * deliberately conservative: firing every member at once means members beyond
 * the spawn-quota headroom come back as quota rejections that get woven into
 * the synthesized prompt as noise (indistinguishable from real failures), and a
 * smaller wave lets earlier members free their concurrent slots before later
 * members dispatch. Sequential waves of this size (each wave itself parallel)
 * keep the fan-out inside a healthy quota envelope.
 */
export const AUTO_SPINUP_BATCH = 5;

/** Distinctive host error phrases raised when the spawn quota is exhausted
 *  (`spawn-assignment-handler.ts` → surfaced by `invoke_agent` as
 *  `Agent "X" failed: <phrase>`). Matching these — not a loose /quota/ — avoids
 *  misclassifying a legitimate member output that merely mentions "quota". */
const QUOTA_SIGNATURE = /Concurrent spawn cap reached|Spawn quota exceeded/;

interface SpinMember {
  id: string;
  name: string;
}

/** A settled `invoke_agent.execute` outcome, classified into the three states
 *  the synthesized prompt must distinguish. */
type MemberOutcome =
  | { name: string; kind: "output"; text: string }
  | { name: string; kind: "quota" }
  | { name: string; kind: "error"; message: string };

type SettledInvoke = PromiseSettledResult<{
  content?: Array<{ type: string; text?: string }>;
}>;

/** Classify one settled `invoke_agent` result. Quota rejections (fulfilled with
 *  an isError text or a rejected promise whose message carries the host phrase)
 *  are the retryable/deferred state; any other rejection is a real error; a
 *  plain fulfilled result is the member's output. */
function classifyInvoke(name: string, r: SettledInvoke): MemberOutcome {
  if (r.status === "fulfilled") {
    const first = r.value?.content?.[0];
    const text = first && first.type === "text" ? (first.text ?? "") : "";
    if (QUOTA_SIGNATURE.test(text)) return { name, kind: "quota" };
    return { name, kind: "output", text };
  }
  const message =
    r.reason instanceof Error ? r.reason.message : String(r.reason ?? "Unknown error");
  if (QUOTA_SIGNATURE.test(message)) return { name, kind: "quota" };
  return { name, kind: "error", message };
}

/** Fire `invoke` for the given member indices in waves of {@link AUTO_SPINUP_BATCH},
 *  awaiting each wave before starting the next (so ordering/batching is
 *  observable and earlier slots free before later waves). Writes each result
 *  into `outcomes` at the member's original index. */
async function runWaves(
  members: SpinMember[],
  indices: number[],
  invoke: (m: SpinMember) => Promise<unknown>,
  outcomes: MemberOutcome[],
): Promise<void> {
  for (let i = 0; i < indices.length; i += AUTO_SPINUP_BATCH) {
    const waveIdx = indices.slice(i, i + AUTO_SPINUP_BATCH);
    const settled = await Promise.allSettled(waveIdx.map((idx) => invoke(members[idx]!)));
    settled.forEach((r, j) => {
      const idx = waveIdx[j]!;
      outcomes[idx] = classifyInvoke(members[idx]!.name, r as SettledInvoke);
    });
  }
}

/**
 * Auto-spin-up phase. After {@link setupTools} completes, the
 * orchestration tool-loader may have stashed `_pendingAutoSpinUp` +
 * `_mentionedAgents` on `run` (see setup-tools.ts 2d). If so, we
 * pre-invoke every member's `invoke_agent` tool — in bounded parallel
 * WAVES (see {@link AUTO_SPINUP_BATCH}) rather than all-at-once — so the
 * orchestrator prompt that follows can include their outputs. Quota
 * rejections are retried once in a later wave (by then earlier members have
 * freed their slots) before being reported as `[deferred: quota]`, distinct
 * from a real member output and from a `[error: …]`.
 *
 * Then injects the orchestrator prompt (or task-tracking instructions
 * for non-orchestrator runs) onto `ctx.system` and clears the
 * `_*` scratch fields off `run`.
 *
 * Mutates `ctx.system` and `run`'s scratch fields in place.
 */
export async function applyAutoSpinUp(
  ctx: StreamChatContext,
  host: StreamChatHost,
  userMessage: string,
): Promise<void> {
  const { run, controller } = ctx;
  // Typed view onto the orchestration scratch fields populated by setup-tools.
  // See OrchestratedRun / RunOrchestrationMeta in ./setup-tools for the shape.
  const orchRun = run as OrchestratedRun;
  const pendingAutoSpinUp = orchRun._pendingAutoSpinUp;
  const mentionedAgents = orchRun._mentionedAgents;
  const teamConfig = orchRun._teamConfig;
  let autoSpinUpResults: Array<{ name: string; output: string }> | undefined;

  if (pendingAutoSpinUp && mentionedAgents?.length) {
    const invokeAgentTool = ctx.agentTools.find((t) => t.name === "invoke_agent");
    if (invokeAgentTool) {
      try {
        const members: SpinMember[] = mentionedAgents.map((a) => ({ id: a.id, name: a.name }));
        log.info("Auto-spin-up: pre-invoking all members in waves", {
          members: members.map((m) => m.name),
          batch: AUTO_SPINUP_BATCH,
        });
        host.bus.emit("run:status", { runId: run.id, status: "Auto-invoking all team members..." });

        const invoke = (m: SpinMember) =>
          invokeAgentTool.execute(
            crypto.randomUUID(),
            { agentConfigId: m.id, task: userMessage },
            controller.signal,
          );

        const outcomes = new Array<MemberOutcome>(members.length);
        // Initial pass — every member, batched.
        await runWaves(members, members.map((_, i) => i), invoke, outcomes);
        // Retry wave — quota-deferred members get ONE more attempt now that
        // earlier members have freed their concurrent slots. Still batched.
        const retryIdx = outcomes
          .map((o, i) => (o.kind === "quota" ? i : -1))
          .filter((i) => i >= 0);
        if (retryIdx.length > 0) {
          log.info("Auto-spin-up: retrying quota-deferred members", {
            members: retryIdx.map((i) => members[i]!.name),
          });
          await runWaves(members, retryIdx, invoke, outcomes);
        }

        // Project outcomes into the {name, output} shape the prompt builder
        // reads, with a DISTINCT marker per state so the orchestrator can tell
        // a real answer from a deferred spawn from a genuine failure.
        autoSpinUpResults = outcomes.map((o) => {
          if (o.kind === "output") return { name: o.name, output: o.text };
          if (o.kind === "quota") {
            log.error("Auto-spin-up member deferred (quota)", { agentName: o.name });
            return {
              name: o.name,
              output:
                "[deferred: quota — spawn slots were exhausted this turn, so this member was NOT run. Invoke it directly on a later turn.]",
            };
          }
          log.error("Auto-spin-up agent failed", { agentName: o.name, error: o.message });
          return { name: o.name, output: `[error: ${o.message}]` };
        });
        log.info("Auto-spin-up complete", { resultCount: autoSpinUpResults.length });
      } catch (spinErr) {
        log.error("Auto-spin-up failed", { error: String(spinErr), stack: spinErr instanceof Error ? spinErr.stack : undefined });
      }
    }
    delete orchRun._pendingAutoSpinUp;
  }

  // Inject orchestrator prompt AFTER auto-spin-up (results available for prompt)
  if (mentionedAgents && mentionedAgents.length > 0) {
    const { buildOrchestratorPrompt, buildTeamOrchestratorPrompt } = await import("../orchestrator-prompt");
    const teamToolScopeForPrompt = orchRun._teamToolScope;
    const orchestratorBlock = teamConfig
      ? buildTeamOrchestratorPrompt(teamConfig.name, teamConfig.prompt, mentionedAgents, autoSpinUpResults, teamToolScopeForPrompt)
      : buildOrchestratorPrompt(mentionedAgents);
    ctx.system = ctx.system ? `${orchestratorBlock}\n\n${ctx.system}` : orchestratorBlock;
    delete orchRun._mentionedAgents;
    delete orchRun._teamConfig;
    delete orchRun._memberOverrides;
    delete orchRun._subAgentMembers;
    delete orchRun._teamToolScope;
  } else {
    // Non-orchestrator runs: still inject task tracking instructions so single agents
    // can decompose complex work into visible tasks.
    try {
      const { buildTaskTrackingInstructions } = await import("../orchestrator-prompt");
      const taskBlock = buildTaskTrackingInstructions();
      ctx.system = ctx.system ? `${ctx.system}\n\n${taskBlock}` : taskBlock;
    } catch { /* non-fatal */ }
  }
}
