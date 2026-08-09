#!/usr/bin/env bun
/**
 * Routing training-set export — manual operator CLI invocation (WS7).
 *
 * Dumps labelled routing samples as JSONL: one line per assistant turn, each
 * carrying the classifier inputs that turn was routed from (`usage.routingSignals`,
 * stamped by WS5) and the label derived from what the user did next
 * (`src/runtime/routing/labels.ts`).
 *
 * NO new table and NO migration: every sample is DERIVED on demand from
 * `messages`. That is deliberate — a derived export can be re-run with a fixed
 * label definition, whereas a materialised table freezes whichever definition
 * was current when the row was written, and the label definition is the part
 * most likely to need correcting.
 *
 * Nothing here trains anything. The output is the input a learned router would
 * need; producing it now costs one script, and the provenance it reads cannot
 * be reconstructed after the fact.
 *
 * Modeled on scripts/backfill-embeddings.ts: shebang, initDb/getDb, flag parse,
 * a summary JSON doc on stdout (or the payload on stdout and the summary on
 * stderr when writing JSONL), exit codes.
 *
 * Usage:
 *   bun run scripts/routing-export.ts                        # last 30 days → stdout
 *   bun run scripts/routing-export.ts --days 90
 *   bun run scripts/routing-export.ts --conversation <id>    # one conversation
 *   bun run scripts/routing-export.ts --include-excluded     # audit the exclusions
 *   bun run scripts/routing-export.ts --out samples.jsonl
 *
 * Exit codes:
 *   0 — exported
 *   2 — invocation error (unknown flag, bad numeric arg)
 */

import { sql } from "drizzle-orm";
import { initDb, getDb } from "../src/db/connection";
import { messages } from "../src/db/schema";
import { nowMinusInterval } from "../src/db/queries/sql-interval";
import { getMessages } from "../src/db/queries/conversations";
import { getCapabilities } from "../src/providers/model-capabilities";
import { resolveModelObject, tierForModel } from "../src/providers/registry";
import {
  countLabels,
  labelConversation,
  type LabelCounts,
  type LabelMessage,
  type LabelledSample,
  type ModelFacts,
  type ModelFactsResolver,
} from "../src/runtime/routing/labels";

export interface ParsedExportArgs {
  days: number;
  /** Restrict to one conversation. Absent ⇒ every conversation in the window. */
  conversationId?: string;
  /** Emit `excluded` samples too. Off by default: a training set wants the
   *  labelled classes, while the exclusions are an audit artifact. Their COUNTS
   *  are always reported either way, so the exclusions are never invisible. */
  includeExcluded: boolean;
  /** Write JSONL here instead of stdout. */
  out?: string;
}

export type ParseResult = ParsedExportArgs | { error: string };

const DEFAULT_DAYS = 30;

function parseCount(raw: string | undefined, flag: string): number | string {
  const n = Number(raw);
  if (raw === undefined || !Number.isFinite(n) || n <= 0) {
    return `${flag} needs a positive number`;
  }
  return Math.floor(n);
}

/** Parse argv (WITHOUT the `bun script.ts` prefix). Returns `{error}` rather
 *  than throwing, so `main` can map it to exit code 2. */
export function parseExportArgs(argv: readonly string[]): ParseResult {
  const parsed: ParsedExportArgs = { days: DEFAULT_DAYS, includeExcluded: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--days") {
      const days = parseCount(argv[++i], "--days");
      if (typeof days === "string") return { error: days };
      parsed.days = days;
    } else if (arg === "--conversation") {
      const id = argv[++i];
      if (!id) return { error: "--conversation needs an id" };
      parsed.conversationId = id;
    } else if (arg === "--out") {
      const out = argv[++i];
      if (!out) return { error: "--out needs a path" };
      parsed.out = out;
    } else if (arg === "--include-excluded") {
      parsed.includeExcluded = true;
    } else {
      return { error: `unknown flag "${arg}"` };
    }
  }
  return parsed;
}

/** Everything {@link runExport} touches the outside world through. */
export interface ExportDeps {
  /** Conversations with an assistant turn inside the window. */
  conversationIds(days: number): Promise<string[]>;
  /** One conversation's messages, oldest first, with attachment MIMEs. */
  loadConversation(conversationId: string): Promise<LabelMessage[]>;
  resolveModelFacts: ModelFactsResolver;
  /** Called once per EMITTED sample, with the JSONL line (no trailing \n). */
  emit(line: string): void;
}

export interface ExportSummary {
  days: number;
  conversations: number;
  /** Samples written to the output. */
  emitted: number;
  /** Every sample the labeller produced, tallied by class and reason —
   *  including the exclusions `--include-excluded` would have added. */
  counts: LabelCounts;
}

/**
 * Label every conversation in the window and emit the requested samples.
 *
 * The tally covers ALL samples, not just the emitted ones, on purpose: an
 * export whose negatives are outnumbered ten-to-one by `capability-*`
 * exclusions is telling you something important about the dataset, and that is
 * only visible if the exclusions are counted.
 */
export async function runExport(args: ParsedExportArgs, deps: ExportDeps): Promise<ExportSummary> {
  const ids = args.conversationId ? [args.conversationId] : await deps.conversationIds(args.days);
  const all: LabelledSample[] = [];
  let emitted = 0;
  for (const id of ids) {
    const samples = labelConversation(id, await deps.loadConversation(id), deps.resolveModelFacts);
    for (const sample of samples) {
      all.push(sample);
      if (!args.includeExcluded && sample.label === "excluded") continue;
      deps.emit(JSON.stringify(sample));
      emitted += 1;
    }
  }
  return { days: args.days, conversations: ids.length, emitted, counts: countLabels(all) };
}

/**
 * The real model-facts resolver: the registry's tier + context window, and the
 * per-model attachment capability table. Memoised per provider+model because a
 * conversation asks the same question once per turn.
 *
 * `resolveModelObject` never throws (it synthesizes a stand-in for an id the
 * catalog no longer lists), so facts are always available in practice — the
 * labeller's `model-facts-unknown` exclusion is the contract for callers that
 * cannot say, not a case this resolver produces.
 */
export function buildModelFactsResolver(): ModelFactsResolver {
  const cache = new Map<string, ModelFacts>();
  return (provider, model) => {
    const key = `${provider}\0${model}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const piModel = resolveModelObject(provider, model);
    const facts: ModelFacts = {
      tier: tierForModel(piModel),
      contextWindow: piModel.contextWindow ?? 0,
      acceptedMimeTypes: new Set(getCapabilities(provider, model).acceptedMimeTypes),
    };
    cache.set(key, facts);
    return facts;
  };
}

/** Conversations that produced an assistant turn inside the window. */
export async function listConversationIds(days: number): Promise<string[]> {
  const res = await getDb().execute(sql`
    SELECT DISTINCT ${messages.conversationId} AS conversation_id
    FROM ${messages}
    WHERE ${messages.role} = 'assistant'
      AND ${messages.createdAt} >= ${nowMinusInterval(days, "days")}
    ORDER BY 1
  `);
  return (res.rows as Record<string, unknown>[]).map((r) => String(r.conversation_id));
}

/** One conversation's messages in the shape the labeller reads. */
export async function loadLabelMessages(conversationId: string): Promise<LabelMessage[]> {
  const rows = await getMessages(conversationId);
  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    parentMessageId: m.parentMessageId,
    createdAt: m.createdAt,
    provider: m.provider,
    model: m.model,
    usage: m.usage ?? null,
    attachmentMimeTypes: (m.attachments ?? []).map((a) => a.mimeType),
  }));
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseExportArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  await initDb();
  // Buffered rather than streamed: this is an operator-run export over one
  // self-hosted install's history, and buffering keeps `--out` and stdout the
  // same single code path.
  const lines: string[] = [];
  const summary = await runExport(parsed, {
    conversationIds: listConversationIds,
    loadConversation: loadLabelMessages,
    resolveModelFacts: buildModelFactsResolver(),
    emit: (line) => lines.push(line),
  });
  const payload = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  if (parsed.out) {
    await Bun.write(parsed.out, payload);
    process.stdout.write(`${JSON.stringify({ out: parsed.out, ...summary }, null, 2)}\n`);
  } else {
    // JSONL on stdout stays machine-pipeable; the summary goes to stderr so it
    // can never corrupt the stream.
    process.stdout.write(payload);
    process.stderr.write(`${JSON.stringify(summary)}\n`);
  }
  return 0;
}

// Single-line guard so it is covered on import; the body only runs when the
// script is invoked directly, never in-process.
if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
