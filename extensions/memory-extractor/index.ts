#!/usr/bin/env bun
// memory-extractor — bundled extension implementation (Phase 53.4 Stage 1).
//
// Mirrors the legacy `src/memory/extraction.ts` pipeline (LLM-driven
// fact extraction → host-side dedup → memory.write), but performs every
// privileged op via the SDK capability surfaces:
//
//   - message slice    →  ctx.invoke("runtime.conversations.getMessages")
//   - settings         →  ctx.invoke("runtime.settings.getMine")
//   - LLM call         →  ctx.llm.complete  (host-brokered; token never crosses)
//   - dedup + write    →  ctx.invoke("runtime.memory.dedupMemoryWrite")
//   - 6h compaction    →  ctx.invoke("runtime.memory.compact")  (cron-driven)
//
// Cross-extension dedup is host-side by design — see
// `src/memory/dedup.ts`. The bundled extension calls
// `runtime.memory.dedupMemoryWrite` instead of `ctx.memory.write`
// because the dedup decision (insert vs update existing row) needs
// visibility into memories authored by the legacy host pipeline; only
// host-side code can make that join. The `selfOnly: false` exception
// in the manifest is the trust boundary that gates the RPC.
//
// Module-level seams (`runtimeApi`, `_setRuntimeApiForTests`) let unit
// tests swap in a fake without going through the JSON-RPC pipe — same
// pattern lessons-distiller uses.

import {
  createToolDispatcher,
  defineLoop,
  formatMessages,
  getChannel,
  getLoopTools,
  Llm,
  resolveProviderModel,
  invoke,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

// ── Extraction prompt ───────────────────────────────────────────────
//
// Copied VERBATIM from src/memory/extraction.ts (the legacy
// `EXTRACTION_SYSTEM_PROMPT`). The parity test asserts both code paths
// produce the same memory rows for the same fixture conversation; any
// wording drift here would break that assertion. Stage 2 deletes the
// legacy export, but until then keep the strings identical.
export const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system. Analyze the conversation and extract structured facts worth remembering for future conversations.

Extract ONLY facts that would be useful context in future conversations. Do NOT extract:
- Transient information (weather today, current task status)
- Obvious conversational filler
- Information the system already knows (model names, capabilities)

For each fact, provide:
- content: A clear, standalone natural language statement
- category: One of "preferences", "biographical", "technical", "decisions_goals"
- confidence: "high", "medium", or "low"
- messageIds: Array of message IDs this fact was extracted from

Respond with a JSON array. If no facts are worth extracting, respond with [].

Example output:
[
  {"content": "User prefers TypeScript over JavaScript", "category": "preferences", "confidence": "high", "messageIds": ["msg-123"]},
  {"content": "User is building a SaaS product for healthcare", "category": "biographical", "confidence": "medium", "messageIds": ["msg-124", "msg-125"]}
]`;

// ── Outcome shape ───────────────────────────────────────────────────
//
// Memory extraction produces N rows, not 1. Outcomes mirror the
// distiller's variant model so test assertions stay shape-aligned.
export type MemoryCategory =
  | "preferences"
  | "biographical"
  | "technical"
  | "decisions_goals";

export type MemoryConfidence = "high" | "medium" | "low";

export interface ExtractedMemoryFact {
  content: string;
  category: MemoryCategory;
  confidence?: MemoryConfidence;
  messageIds?: string[];
}

export interface MemoryWriteOutcome {
  action: "inserted" | "updated";
  memoryId: string;
  fact: ExtractedMemoryFact;
}

export type ExtractionOutcome =
  | { kind: "success"; writes: MemoryWriteOutcome[] }
  | { kind: "decline"; reason: "settings_disabled" }
  | { kind: "decline"; reason: "wrong_agent_or_status" }
  | { kind: "decline"; reason: "empty_conversation" }
  | { kind: "decline"; reason: "llm_empty" }
  | { kind: "decline"; reason: "llm_malformed"; detail: string }
  | { kind: "error"; reason: "llm_error"; detail: string }
  | { kind: "error"; reason: "internal"; detail: string };

// ── Provider/model defaults ─────────────────────────────────────────
//
// The provider→default-model map + resolution now live in the SDK
// (`resolveProviderModel`, imported above) — the Loop primitive owns the
// single shared copy, so the per-extension duplicate is DELETED (spec
// decision #6). v1 values are identical, so every existing test resolves
// the same provider key.

// ── RPC contract shapes ─────────────────────────────────────────────
interface RuntimeMessage {
  id: string;
  role: string;
  content: string;
}

interface RuntimeDedupResult {
  action: "inserted" | "updated";
  memoryId: string;
}

// ── Module-level SDK seam ───────────────────────────────────────────
//
// Tests swap these via `_setRuntimeApiForTests` to bypass the JSON-RPC
// pipe. Production wiring at the bottom of the file installs the real
// implementations.
export interface MemoryExtractorRuntimeApi {
  getMessagesEnvelope(conversationId: string): Promise<{
    messages: RuntimeMessage[];
    projectId: string | null;
  }>;
  llmComplete(opts: {
    provider: string;
    model: string;
    systemPrompt: string;
    messages: { role: "user"; content: string }[];
    maxTokens: number;
    temperature: number;
  }): Promise<{ content: string }>;
  dedupMemoryWrite(input: {
    content: string;
    category: MemoryCategory;
    confidence?: MemoryConfidence;
    sourceMessageIds: string[];
    conversationId: string;
    projectId: string | null;
    extensionId?: string;
    injectionEligible?: boolean;
  }): Promise<RuntimeDedupResult>;
  compact(args: { projectId?: string }): Promise<{ mergedCount: number }>;
  /** Effective settings for THIS extension on behalf of the acting
   *  user. Used by event/schedule paths which have no per-call ctx. */
  getMySettings(): Promise<Record<string, unknown>>;
}

const llm = new Llm();

let runtimeApi: MemoryExtractorRuntimeApi = {
  getMessagesEnvelope: async (conversationId: string) => {
    const result = await invoke<{ messages: RuntimeMessage[]; projectId?: string | null }>(
      "runtime.conversations.getMessages",
      { conversationId },
    );
    return { messages: result.messages, projectId: result.projectId ?? null };
  },
  llmComplete: async (opts) => {
    const result = await llm.complete({
      provider: opts.provider,
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      messages: opts.messages,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
    });
    return { content: result.content };
  },
  dedupMemoryWrite: async (input) => {
    return invoke<RuntimeDedupResult>("runtime.memory.dedupMemoryWrite", input);
  },
  compact: async (args) => {
    return invoke<{ mergedCount: number }>("runtime.memory.compact", args);
  },
  getMySettings: async () => {
    return invoke<Record<string, unknown>>("runtime.settings.getMine", {});
  },
};

/** Test-only — replace the live runtime API with a fake. */
export function _setRuntimeApiForTests(fake: Partial<MemoryExtractorRuntimeApi>): void {
  runtimeApi = { ...runtimeApi, ...fake };
}

// Cache the original real API so tests can fully restore it.
const _realRuntimeApi: MemoryExtractorRuntimeApi = { ...runtimeApi };

/** Test-only — restore the real runtime API after a test. */
export function _resetRuntimeApiForTests(): void {
  runtimeApi = { ..._realRuntimeApi };
}

// ── Pure JSON parser (mirrors legacy lines 110-133) ─────────────────
//
// Returns either a flat array of facts or a typed decline outcome.
// Matches the legacy `extractMemories`'s tolerance for ```json fences
// and "starts-with-`[`" auto-correction.
function parseFactsJson(rawText: string):
  | { ok: true; facts: ExtractedMemoryFact[] }
  | { ok: false; outcome: ExtractionOutcome } {
  let jsonText = rawText.trim();
  // Tolerate ```json … ``` fences from chatty models.
  const fenced = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) jsonText = fenced[1]!.trim();

  if (!jsonText) {
    return { ok: false, outcome: { kind: "decline", reason: "llm_empty" } };
  }
  // Match the legacy auto-correction: if the response doesn't start
  // with `[`, try to slice from the first `[`.
  if (!jsonText.startsWith("[")) {
    const arrayStart = jsonText.indexOf("[");
    if (arrayStart !== -1) jsonText = jsonText.slice(arrayStart);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return {
      ok: false,
      outcome: {
        kind: "decline",
        reason: "llm_malformed",
        detail: (err as Error).message,
      },
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      outcome: {
        kind: "decline",
        reason: "llm_malformed",
        detail: `expected array, got ${typeof parsed}`,
      },
    };
  }
  if (parsed.length === 0) {
    return { ok: true, facts: [] };
  }
  // Filter out entries missing required fields to match the legacy
  // `if (!fact.content || !fact.category) continue` behavior.
  const validCategories: ReadonlyArray<MemoryCategory> = [
    "preferences",
    "biographical",
    "technical",
    "decisions_goals",
  ];
  const facts: ExtractedMemoryFact[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.content !== "string" || !candidate.content) continue;
    if (
      typeof candidate.category !== "string" ||
      !validCategories.includes(candidate.category as MemoryCategory)
    ) {
      continue;
    }
    facts.push({
      content: candidate.content,
      category: candidate.category as MemoryCategory,
      confidence:
        candidate.confidence === "high" ||
        candidate.confidence === "medium" ||
        candidate.confidence === "low"
          ? candidate.confidence
          : "medium",
      messageIds: Array.isArray(candidate.messageIds)
        ? (candidate.messageIds.filter((s) => typeof s === "string") as string[])
        : [],
    });
  }
  return { ok: true, facts };
}

// ── Extraction pipeline ─────────────────────────────────────────────
export interface ExtractOptions {
  conversationId: string;
  /** Resolved settings for the calling user. Provided by the caller so
   *  the listener path can feed the same shape. */
  settings: { provider?: string; model?: string };
  /** Project id for the conversation. Embedded in the host's
   *  `getMessages` response — passed through here so a separate RPC
   *  isn't needed. */
  projectId: string | null;
}

export async function extract(opts: ExtractOptions): Promise<ExtractionOutcome> {
  let messages: RuntimeMessage[];
  let projectId = opts.projectId;
  try {
    const envelope = await runtimeApi.getMessagesEnvelope(opts.conversationId);
    messages = envelope.messages;
    projectId = envelope.projectId ?? opts.projectId;
  } catch (err) {
    return { kind: "error", reason: "internal", detail: (err as Error).message };
  }
  if (messages.length === 0) {
    return { kind: "decline", reason: "empty_conversation" };
  }

  // Last-20 window, formatted via the SDK's shared `formatMessages` (the
  // same `[id] role: content` join the Loop primitive uses) — replaces the
  // hand-rolled slice+format. Byte-identical output.
  const conversationText = formatMessages(messages.slice(-20));

  const { provider, model } = resolveProviderModel(opts.settings.provider, opts.settings.model);

  let llmText: string;
  try {
    const completion = await runtimeApi.llmComplete({
      provider,
      model,
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Extract facts from this conversation:\n\n${conversationText}`,
        },
      ],
      maxTokens: 2048,
      temperature: 0,
    });
    llmText = completion.content;
  } catch (err) {
    return { kind: "error", reason: "llm_error", detail: (err as Error).message };
  }

  const parsed = parseFactsJson(llmText);
  if (!parsed.ok) return parsed.outcome;
  if (parsed.facts.length === 0) {
    // Empty array is a successful zero-write run — the legacy code
    // path silently completes; the bundled extension surfaces it as
    // a `success` with no writes so audit trails record the call.
    return { kind: "success", writes: [] };
  }

  // Each write goes through the host's dedup helper. Errors on a
  // single write are logged but don't abort the rest — matches the
  // legacy listener's "fire-and-forget per fact" semantics.
  const writes: MemoryWriteOutcome[] = [];
  for (const fact of parsed.facts) {
    try {
      const result = await runtimeApi.dedupMemoryWrite({
        content: fact.content,
        category: fact.category,
        confidence: fact.confidence ?? "medium",
        sourceMessageIds: fact.messageIds ?? [],
        conversationId: opts.conversationId,
        projectId,
        extensionId: "memory-extractor",
        // Bundled extractor's writes match the host pipeline's
        // injection eligibility. v1.3 ships injectionEligible=true
        // for this extension only — admin UI to flip per-memory
        // eligibility is deferred (see PHASE 53.5 NOT-IN-SCOPE).
        injectionEligible: true,
      });
      writes.push({ action: result.action, memoryId: result.memoryId, fact });
    } catch (err) {
      console.warn("[memory-extractor] dedupMemoryWrite failed for one fact", {
        conversationId: opts.conversationId,
        category: fact.category,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { kind: "success", writes };
}

// ── run:complete extraction core ────────────────────────────────────
//
// The auto-extract path. Now driven ONLY by the `defineLoop` capture loop
// (`defineMemoryLoops`), which passes `ctx.settings` into
// `extractRunComplete`. The old ctx-less `handleRunComplete` listener — which
// round-tripped `getMySettings` itself — is DELETED: it was never wired in
// boot (boot calls only `defineMemoryLoops`), so it was dead production code.
// `ctx.settings` covers the settings fetch. (`getMySettings` stays on the
// runtimeApi — compaction + the boot cron-resolution still use it.)

/**
 * Run:complete extraction core, settings-injected. Driven by the
 * `defineLoop` capture act (`defineMemoryLoops`), which passes
 * `ctx.settings` (the primitive-owned resolution). The gating + project-id
 * resolution lives here once.
 */
export async function extractRunComplete(
  payload: { run?: unknown; conversationId?: string },
  settings: Record<string, unknown>,
): Promise<ExtractionOutcome | undefined> {
  const conversationId = payload?.conversationId;
  if (!conversationId) return undefined;
  if (settings.enabled === false) {
    return { kind: "decline", reason: "settings_disabled" };
  }

  // Status / agent gating — only successful chat runs extract.
  const run = payload?.run as { agentName?: string; status?: string } | undefined;
  if (run?.agentName !== "chat" || run?.status !== "success") {
    return { kind: "decline", reason: "wrong_agent_or_status" };
  }

  // Resolve the project id via the same getMessages call.
  let projectId: string | null = null;
  try {
    const envelope = await runtimeApi.getMessagesEnvelope(conversationId);
    projectId = envelope.projectId;
  } catch {
    return undefined; // expected for deleted / unwired conversations
  }

  return extract({
    conversationId,
    settings: {
      provider: settings.provider as string | undefined,
      model: settings.model as string | undefined,
    },
    projectId,
  }).catch(() => undefined);
}

// ── Compaction schedule handler (6h cron) ──────────────────────────
//
// Fires every 6 hours (the manifest's only cron). Honors the
// `compactionEnabled` setting so users can disable the sweep without
// disabling extraction. Calls into the host's `runCompaction` via the
// `runtime.memory.compact` invoke handler.
export async function handleCompactionTick(): Promise<{ mergedCount: number } | { skipped: true; reason: string }> {
  let settings: Record<string, unknown>;
  try {
    settings = await runtimeApi.getMySettings();
  } catch {
    settings = {};
  }
  // `compaction_enabled` defaults to true. An explicit `false` skips
  // the run; the schedule daemon still records the fire (for audit /
  // missed-run accounting) but the extension does no real work.
  if (settings.compaction_enabled === false) {
    return { skipped: true, reason: "settings_disabled" };
  }
  if (settings.enabled === false) {
    // The master `enabled` switch covers compaction too — disabling
    // the extractor disables compaction by default. Users who want
    // the per-knob granular control set `compactionEnabled: false`
    // alone (above branch).
    return { skipped: true, reason: "extractor_disabled" };
  }
  try {
    return await runtimeApi.compact({});
  } catch (err) {
    console.warn("[memory-extractor] compaction tick failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { skipped: true, reason: "internal_error" };
  }
}

// ── Compaction cron derivation ──────────────────────────────────────
//
// v1.4 — `compaction_interval_hours` is a per-extension setting (see
// `ezcorp.config.ts` settings block). The manifest declares the legal
// set of crons so the SDK's "must be in manifest" gate passes; this
// helper picks the right one based on the user's chosen value, with
// a fallback to the default-6h cron for invalid / unset values.
//
// The mapping is exhaustive across the manifest's declared crons —
// any future widening of the cadence set must update both this map
// AND `permissions.schedule.crons` AND the setting's `options[]`.
// Pure function so the test suite can pin the boundary cases.
export const SUPPORTED_COMPACTION_CRONS = {
  "1": "0 */1 * * *",
  "3": "0 */3 * * *",
  "6": "0 */6 * * *",
  "12": "0 */12 * * *",
  "24": "0 0 * * *",
} as const;

export const DEFAULT_COMPACTION_CRON = SUPPORTED_COMPACTION_CRONS["6"];

/** Resolve the compaction cron from a setting value. Accepts string
 *  or number (the SchemaForm may marshal either depending on UI
 *  flow). Out-of-range / unsupported values fall back to the
 *  default 6h cron and the caller logs a warning. */
export function resolveCompactionCron(
  intervalHours: unknown,
): { cron: string; resolvedFrom: string; usedFallback: boolean } {
  // Normalise to a string — `select` widgets may send the raw
  // number or its string form.
  let key: string;
  if (typeof intervalHours === "string") {
    key = intervalHours;
  } else if (typeof intervalHours === "number" && Number.isFinite(intervalHours)) {
    key = String(Math.floor(intervalHours));
  } else {
    return {
      cron: DEFAULT_COMPACTION_CRON,
      resolvedFrom: "missing-or-invalid-type",
      usedFallback: true,
    };
  }
  const matched = (SUPPORTED_COMPACTION_CRONS as Record<string, string>)[key];
  if (matched) {
    return { cron: matched, resolvedFrom: key, usedFallback: false };
  }
  return {
    cron: DEFAULT_COMPACTION_CRON,
    resolvedFrom: key,
    usedFallback: true,
  };
}

// ── Tool dispatcher (none) ──────────────────────────────────────────
//
// The manifest declares an empty `tools: []`. Extraction and
// compaction are both event/cron driven; there is no user-facing
// manual entry point in v1.3 (deferred to v1.4 alongside the per-
// memory eligibility UI).
export const tools: Record<string, ToolHandler> = {};

// ── Boot wiring ─────────────────────────────────────────────────────
//
// `if (import.meta.main)` keeps the dispatcher off when this file is
// imported by a unit test (which mounts its own channel). Production
// path is the default subprocess-spawn entrypoint.

// ── Loop definitions (TWO loops in ONE extension) ───────────────────
//
// Proves multi-loop-per-extension: an event capture loop + a cron
// compaction loop, both `defineLoop`. The capture loop is terminal
// (writes N memory facts, no run row needed beyond the audit); the
// compaction loop is stateless (its work is the host-side merge).
//
// `compactionCron` is resolved from settings at boot (the manifest
// declares the legal cron set; the SDK's "must be in manifest" gate
// passes). Setting changes apply on next host restart — same as before.
export function defineMemoryLoops(compactionCron: string): void {
  // Capture loop — terminal extraction on every successful chat run.
  defineLoop<{ run?: unknown; conversationId?: string }, ExtractionOutcome>({
    id: "extract",
    trigger: { kind: "event", event: "run:complete" },
    contract: { states: ["done"], terminal: ["done"], scope: "user" },
    act: async (ctx) => {
      const outcome = await extractRunComplete(ctx.input, ctx.settings);
      if (!outcome) return { kind: "skip", reason: "gated" };
      if (outcome.kind === "success") {
        return { kind: "terminal", status: "done", outcome };
      }
      if (outcome.kind === "error") {
        throw new Error(`${outcome.reason}: ${outcome.detail}`);
      }
      return { kind: "skip", reason: outcome.reason };
    },
  });

  // Compaction loop — stateless cron sweep. The cron still rides on
  // `extension_schedules` (the SDK Schedule the primitive wires).
  defineLoop({
    id: "compaction",
    trigger: { kind: "cron", cron: compactionCron },
    contract: { states: ["done"], terminal: ["done"], scope: "global" },
    act: async () => {
      const result = await handleCompactionTick();
      if ("skipped" in result) return { kind: "skip", reason: result.reason };
      return { kind: "terminal", status: "done", outcome: result };
    },
  });
}

if (import.meta.main) {
  // Resolve the compaction cadence at boot (errors → default 6h cron).
  let resolvedCron: string = DEFAULT_COMPACTION_CRON;
  try {
    const settings = await runtimeApi.getMySettings();
    const resolved = resolveCompactionCron(settings.compaction_interval_hours);
    resolvedCron = resolved.cron;
    if (resolved.usedFallback) {
      console.warn("[memory-extractor] compaction_interval_hours fallback to default 6h", {
        resolvedFrom: resolved.resolvedFrom,
      });
    }
  } catch (err) {
    console.warn("[memory-extractor] could not read settings at boot; defaulting to 6h", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  defineMemoryLoops(resolvedCron);
  // The extension declares no manual tools; the dispatcher still mounts
  // the `tools/call` plumbing the host expects (merged with the loops'
  // tools, of which there are none).
  createToolDispatcher({ ...getLoopTools(), ...tools });
  getChannel().start();
}
