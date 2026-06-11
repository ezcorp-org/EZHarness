/**
 * Daily Briefing — per-user run pipeline (spec §5.2, Phase 1: sections
 * 1+2 — unfinished business + open tasks; watchlist is Phase 3).
 *
 * Per claimed user:
 *   1. Resolve the target project (configured → most recently active →
 *      `skipped`).
 *   2. Create the briefing conversation with the per-user system
 *      prompt (base contract + user instructions + today's date/tz).
 *   3. Persist the synthetic user message.
 *   4. `executor.streamChat(...)` and await its terminal state with a
 *      timeout (the executor resolves after finalize, so awaiting the
 *      call IS awaiting the run's terminal bus event).
 *   5. On error/timeout: DELETE the conversation if it has no
 *      assistant content (empty-failure hygiene, locked decision §6.5).
 *   6. On success: emit `conversation:created` (source 'briefing') +
 *      `briefing:delivered` on the bus (user-scoped SSE fan-out).
 *
 * State bookkeeping (`recordBriefingFireResult`) is the CALLER's job
 * (daemon tick / run-now route) — the pipeline stays a pure
 * orchestration of conversation + run + events and reports a status.
 */
import type { BriefingConfig } from "../../db/queries/briefing-configs";
import {
  createConversation,
  createMessage,
  deleteConversation,
  getMessages,
  listRecentConversationsForUser,
} from "../../db/queries/conversations";
import { getProject } from "../../db/queries/projects";
import { ensureBriefingAgentConfig, getBriefingAgentConfigId } from "./agent-config";
import { getBriefingRuntime, type BriefingRuntime } from "./runtime-registry";
import { logger } from "../../logger";

const log = logger.child("briefing.run");

/** Per-fire timeout (spec §5.1 — default 5 min). */
export const DEFAULT_BRIEFING_RUN_TIMEOUT_MS = 300_000;

export interface BriefingRunResult {
  status: "ok" | "error" | "skipped";
  conversationId?: string;
  error?: string;
}

export interface BriefingRunOptions {
  /** The fire is a boot/offline catch-up — flagged into the synthetic
   *  message so the agent can say "while you were away". */
  catchUp?: boolean;
}

export interface BriefingRunDeps extends BriefingRuntime {
  now?: () => Date;
  runTimeoutMs?: number;
}

/**
 * Project fallback chain (locked decision §7.2): configured project if
 * it still exists → project of the user's most recently active
 * conversation → null (caller records `skipped`).
 */
export async function resolveBriefingProject(config: BriefingConfig): Promise<string | null> {
  if (config.projectId) {
    const p = await getProject(config.projectId);
    if (p) return p.id;
  }
  const briefingAgentId = await getBriefingAgentConfigId();
  const recent = await listRecentConversationsForUser(config.userId, {
    excludeAgentConfigId: briefingAgentId,
    limit: 1,
  });
  if (recent[0]) {
    const p = await getProject(recent[0].projectId);
    if (p) return p.id;
  }
  return null;
}

/** "Daily Briefing — Wednesday, Jun 10" in the user's timezone. */
export function buildBriefingTitle(now: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  return `Daily Briefing — ${fmt.format(now)}`;
}

/** Conversation system prompt: base contract + date/tz + user
 *  instructions (the instructions field IS the prompt — spec §3.1). */
export function buildBriefingSystemPrompt(opts: {
  now: Date;
  timezone: string;
  instructions: string;
}): string {
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: opts.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const lines = [
    "You are the user's Daily Briefing agent. Compose a short, actionable morning briefing from the user's own conversations and tasks, then stay available — the user can reply and you should pick the work back up.",
    "",
    "Produce these sections in order, SKIPPING any section with nothing to report:",
    "1. **Unfinished business** — 2-4 bullets max. For each: what was happening, where it stopped, a one-line offer to resume. Source from recent conversation transcripts (list_recent_conversations + get_conversation_summary) and your memory context.",
    "2. **Open tasks** — counts plus the 3 most relevant open/active tasks with their conversation context (get_task_snapshots).",
    "Finish with a sign-off: ONE suggested next action phrased as a question.",
    "",
    "Rules:",
    "- Reference conversations by title, never by id.",
    "- If every section is empty, post a 2-line all-clear instead — never an empty or apologetic message.",
    "- Never expose tool errors to the user; silently skip what you cannot read.",
    "",
    `Today is ${dateFmt.format(opts.now)} (timezone: ${opts.timezone}).`,
  ];
  const instructions = opts.instructions.trim();
  if (instructions.length > 0) {
    lines.push("", "## User instructions", instructions);
  }
  return lines.join("\n");
}

/** Prefix every synthetic briefing prompt starts with. The
 *  empty-failure hygiene check uses it to tell the pipeline's own
 *  synthetic message apart from a real user reply (which must never
 *  be deleted). */
export const SYNTHETIC_PROMPT_PREFIX = "[Scheduled briefing — ";

/** Synthetic user message — embeds the section contract so the agent
 *  doesn't depend on config-table access (spec §5.2.3). */
export function buildSyntheticPrompt(now: Date, catchUp: boolean): string {
  const base = `${SYNTHETIC_PROMPT_PREFIX}${now.toISOString()}]`;
  const catchUpNote = catchUp
    ? " This is a catch-up fire: the host was offline at the scheduled time, so briefly note you're catching up on what happened while the user was away."
    : "";
  return (
    `${base}${catchUpNote}\n` +
    "Compose today's briefing now. Mine the user's recent conversations with list_recent_conversations and get_conversation_summary for unfinished business, and get_task_snapshots for open tasks. Skip empty sections; end with one suggested next action as a question."
  );
}

/** True when the conversation carries at least one non-empty assistant
 *  message — the "did the briefing actually deliver" signal. */
async function hasAssistantContent(conversationId: string): Promise<boolean> {
  const msgs = await getMessages(conversationId);
  return msgs.some((m) => m.role === "assistant" && m.content.trim().length > 0);
}

/** True when the conversation carries content worth preserving: a
 *  non-empty assistant message OR a real (non-synthetic) user message.
 *  A user who replied mid-run must never lose that reply to the
 *  empty-failure hygiene path, even when the run itself errored. */
async function hasPreservableContent(conversationId: string): Promise<boolean> {
  const msgs = await getMessages(conversationId);
  return msgs.some(
    (m) =>
      (m.role === "assistant" && m.content.trim().length > 0) ||
      (m.role === "user" && !m.content.startsWith(SYNTHETIC_PROMPT_PREFIX)),
  );
}

/** Delete the conversation when a failed run left it without
 *  preservable content. Returns true when the conversation was deleted. */
export async function deleteBriefingConversationIfEmpty(conversationId: string): Promise<boolean> {
  try {
    if (await hasPreservableContent(conversationId)) return false;
    await deleteConversation(conversationId);
    return true;
  } catch (err) {
    log.warn("delete-if-empty failed", { conversationId, error: String(err) });
    return false;
  }
}

function resolveDeps(override?: Partial<BriefingRunDeps>): BriefingRunDeps | null {
  if (override?.executor && override.bus) return override as BriefingRunDeps;
  const runtime = getBriefingRuntime();
  if (!runtime) return null;
  return { ...runtime, ...override };
}

/**
 * Run one user's briefing end-to-end. Never throws — every failure is
 * folded into the returned status so the daemon's bookkeeping stays a
 * single code path.
 */
export async function runBriefingForUser(
  config: BriefingConfig,
  opts: BriefingRunOptions = {},
  depsOverride?: Partial<BriefingRunDeps>,
): Promise<BriefingRunResult> {
  const deps = resolveDeps(depsOverride);
  if (!deps) {
    // Boot-ordering race or backend-only process — operational, not a
    // user-config error. The daemon logs and skips (no claim happened
    // without a runtime; run-now 503s before reaching here).
    return { status: "error", error: "briefing runtime not registered" };
  }
  const now = deps.now?.() ?? new Date();
  const timeoutMs = deps.runTimeoutMs ?? DEFAULT_BRIEFING_RUN_TIMEOUT_MS;

  let conversationId: string | undefined;
  try {
    const projectId = await resolveBriefingProject(config);
    if (!projectId) {
      log.info("briefing skipped — no resolvable project", { userId: config.userId });
      return { status: "skipped" };
    }

    const agent = await ensureBriefingAgentConfig();

    const conversation = await createConversation(projectId, {
      title: buildBriefingTitle(now, config.timezone),
      userId: config.userId,
      agentConfigId: agent.id,
      systemPrompt: buildBriefingSystemPrompt({
        now,
        timezone: config.timezone,
        instructions: config.instructions ?? "",
      }),
      model: config.model ?? undefined,
      provider: config.provider ?? undefined,
    });
    conversationId = conversation.id;

    const syntheticPrompt = buildSyntheticPrompt(now, opts.catchUp === true);
    const userMessage = await createMessage(conversation.id, {
      role: "user",
      content: syntheticPrompt,
    });

    const runId = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      if (typeof timer === "object" && "unref" in timer) {
        (timer as unknown as { unref: () => void }).unref();
      }
    });

    const outcome = await Promise.race([
      deps.executor
        .streamChat(conversation.id, syntheticPrompt, {
          projectId,
          runId,
          parentMessageId: userMessage.id,
          agentConfigId: agent.id,
          model: config.model ?? undefined,
          provider: config.provider ?? undefined,
          // Unattended pipeline runs are read-only (spec §9): no
          // edit-file/shell on a turn nobody is watching. Follow-up
          // user turns in the delivered conversation go through the
          // normal chat route and keep full tool access (spec §3.2).
          toolRestriction: "read-only",
        })
        .then((run) => ({ kind: "run" as const, run })),
      timeoutPromise,
    ]);
    if (timer) clearTimeout(timer);

    if (outcome.kind === "timeout") {
      try {
        deps.executor.cancelRun(runId);
      } catch (cancelErr) {
        log.warn("cancelRun after timeout failed", { runId, error: String(cancelErr) });
      }
      const deleted = await deleteBriefingConversationIfEmpty(conversation.id);
      log.warn("briefing run timed out", { userId: config.userId, runId, timeoutMs, deleted });
      return { status: "error", conversationId: conversation.id, error: `briefing run timed out after ${timeoutMs}ms` };
    }

    if (outcome.run.status !== "success") {
      const errText = typeof outcome.run.result?.error === "string"
        ? outcome.run.result.error
        : JSON.stringify(outcome.run.result?.error ?? `run ${outcome.run.status}`);
      const deleted = await deleteBriefingConversationIfEmpty(conversation.id);
      log.warn("briefing run failed", { userId: config.userId, runId, error: errText, deleted });
      return { status: "error", conversationId: conversation.id, error: errText };
    }

    // Defensive: a "successful" run that produced no assistant content
    // is still a failed delivery (status stays assistant-gated), but
    // the deletion goes through the preservation check — a mid-run
    // user reply keeps the conversation alive.
    if (!(await hasAssistantContent(conversation.id))) {
      await deleteBriefingConversationIfEmpty(conversation.id);
      return { status: "error", conversationId: conversation.id, error: "run completed without assistant content" };
    }

    deps.bus.emit("conversation:created", {
      conversationId: conversation.id,
      projectId,
      userId: config.userId,
      source: "briefing",
    });
    deps.bus.emit("briefing:delivered", {
      userId: config.userId,
      conversationId: conversation.id,
      projectId,
    });

    log.info("briefing delivered", { userId: config.userId, conversationId: conversation.id });
    return { status: "ok", conversationId: conversation.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (conversationId) await deleteBriefingConversationIfEmpty(conversationId);
    log.warn("briefing pipeline error", { userId: config.userId, error: message });
    return { status: "error", ...(conversationId ? { conversationId } : {}), error: message };
  }
}

/**
 * One-time auto-disable notification (spec §5.1): when 5 consecutive
 * errors disable a user's briefing, post a short conversation
 * explaining why and how to re-enable. Best-effort — every failure is
 * swallowed (the disable itself already happened in the config row).
 */
export async function notifyBriefingAutoDisabled(
  config: BriefingConfig,
  consecutiveErrors: number,
  depsOverride?: Partial<BriefingRunDeps>,
): Promise<void> {
  try {
    const deps = resolveDeps(depsOverride);
    const projectId = await resolveBriefingProject(config);
    if (!projectId) {
      log.warn("auto-disable notification skipped — no resolvable project", { userId: config.userId });
      return;
    }
    const agent = await ensureBriefingAgentConfig();
    const conversation = await createConversation(projectId, {
      title: "Daily Briefing disabled",
      userId: config.userId,
      agentConfigId: agent.id,
    });
    await createMessage(conversation.id, {
      role: "assistant",
      content:
        `Your Daily Briefing was automatically disabled after ${consecutiveErrors} consecutive failed runs ` +
        `(last status: error). This usually means a provider credential is missing or invalid. ` +
        `Fix the underlying issue, then re-enable the briefing in Settings → Briefing.`,
    });
    deps?.bus.emit("conversation:created", {
      conversationId: conversation.id,
      projectId,
      userId: config.userId,
      source: "briefing",
    });
    log.info("auto-disable notification posted", { userId: config.userId, conversationId: conversation.id });
  } catch (err) {
    log.warn("auto-disable notification failed", { userId: config.userId, error: String(err) });
  }
}
