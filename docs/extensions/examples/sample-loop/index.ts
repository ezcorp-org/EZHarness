#!/usr/bin/env bun
// sample-loop — the reference Loop SDK primitive example.
//
// "Build a loop in 20 lines": a terminal capture loop that, on every
// successful chat run, asks the LLM for a one-line summary of the
// conversation and mirrors it to a human-readable artifact. The whole
// thing is ONE declarative `defineLoop` — the primitive owns settings
// resolution, the run record + retention, fire logging, and the artifact
// write. The author writes only `act` (what to do) + small config.
//
// See docs/extensions/loops.md for the full reference.

import {
  createToolDispatcher,
  defineLoop,
  getChannel,
  getLoopTools,
  type ActResult,
  type CheckResult,
  type LoopActContext,
  type LoopCheckContext,
} from "@ezcorp/sdk/runtime";

/** A summarized run outcome. Exported so the test can assert the shape. */
export interface SummaryOutcome {
  conversationId: string;
  summary: string;
}

/**
 * The deterministic pre-gate — "should the AI process even run?" It answers
 * the CHEAP, content-free questions (is the loop enabled? is there a
 * conversation?) so a disabled/misfired event never builds the act context
 * or reaches the LLM. Note the firewall: the check CANNOT read messages
 * (`LoopCheckContext` has no `recentMessages`), so the "is the conversation
 * empty?" gate stays in `act` — deterministic gating up front, content-
 * dependent gating where the data lives. Exported for unit tests.
 */
export async function summarizeCheck(
  ctx: LoopCheckContext<{ conversationId?: string }>,
): Promise<CheckResult<{ conversationId?: string }>> {
  if (ctx.settings.enabled === false) {
    return { proceed: false, reason: "settings_disabled" };
  }
  if (!ctx.input.conversationId) {
    return { proceed: false, reason: "no_conversation" };
  }
  return { proceed: true };
}

/**
 * The loop body — exported so the unit test can drive it with a hand-built
 * `ctx` (mock `llm`/`recentMessages`) without a live channel. The act maps
 * the input + a host-brokered LLM call to a terminal outcome (or a skip).
 */
export async function summarizeAct(
  ctx: LoopActContext<{ conversationId?: string }>,
): Promise<ActResult<SummaryOutcome>> {
  const conversationId = ctx.input.conversationId;
  if (!conversationId) return { kind: "skip", reason: "no_conversation" };
  if (ctx.settings.enabled === false) {
    return { kind: "skip", reason: "settings_disabled" };
  }

  // The primitive hands you a formatted last-20-message slice + a
  // host-brokered LLM (the token never reaches this code).
  const recent = await ctx.recentMessages(conversationId);
  if (recent.length === 0) return { kind: "skip", reason: "empty" };

  const { content } = await ctx.llm.complete({
    provider: (ctx.settings.provider as string) ?? "google",
    model: (ctx.settings.model as string) ?? "gemini-2.0-flash-lite",
    systemPrompt: "Summarize this conversation in ONE sentence.",
    messages: [{ role: "user", content: ctx.formatMessages(recent) }],
    maxTokens: 128,
    temperature: 0,
  });

  return {
    kind: "terminal",
    status: "done",
    outcome: { conversationId, summary: content.trim() },
  };
}

/**
 * Register the sample loop. Exported (not auto-run) so unit tests can
 * register it against a stubbed channel without `import.meta.main`.
 */
export function defineSampleLoop(): void {
  defineLoop<{ conversationId?: string }, SummaryOutcome>({
    id: "summarize",
    // Fire on every completed chat run.
    trigger: { kind: "event", event: "run:complete" },
    contract: {
      states: ["done"],
      scope: "user",
      // Don't re-summarize the same conversation while a run is open.
      idempotencyKey: (input) => input.conversationId,
      retention: { maxRuns: 50 },
    },
    // The deterministic gate runs BEFORE act — a disabled loop or a
    // conversation-less event is a first-class skip, no LLM context built.
    check: summarizeCheck,
    act: summarizeAct,
    log: {
      // Mirror each summary to a human-readable artifact (fail-soft; the
      // durable record lives in Storage, never the file).
      artifact: (run, outcome) => ({
        path: `summaries/${run.id}.md`,
        body: `# Summary\n\n${outcome.summary}\n`,
      }),
    },
  });
}

/**
 * Production boot: register the loop, mount the tools/call plumbing (a
 * pure-loop extension still mounts it — here only the loops' tools, of which
 * there are none), and start the channel's stdin read loop. Exported (not
 * inlined under `import.meta.main`) so a unit test can drive the boot path
 * against the SDK test channel — mirrors `start()` in the todo-tracker /
 * task-stack examples.
 */
export function start(): void {
  defineSampleLoop();
  createToolDispatcher({ ...getLoopTools() });
  getChannel().start();
}

// Gated on `import.meta.main` so test imports don't open stdin.
if (import.meta.main) start();
