/**
 * Live region-1 prompt-cache proof (PR #56 — memory-tail split + 1h retention).
 *
 * Drives TWO real Anthropic calls through the app's OWN payload transforms
 * (`appendMemoryTailBlock` + `applyCacheRetention` — the exact `onPayload`
 * chain `build-pi-agent.ts` installs) and asserts on the provider-reported
 * usage:
 *
 *   turn 1  frozen system base + volatile "memory" tail A
 *           → expect cache WRITE  (cache_creation_input_tokens > 0)
 *           → expect a 1h split   (cacheWrite1h > 0: the ttl:"1h" was accepted)
 *   turn 2  SAME frozen base + DIFFERENT tail B
 *           → expect cache READ   (cache_read_input_tokens > 0)
 *             — the region-1 prefix survived a changing memory tail.
 *
 * `--legacy` reproduces the pre-fix behavior (tail merged INTO the cached
 * system block): turn 2 then reads ~0 tokens, demonstrating the defect the
 * split fixes. `--dry-run` skips the network and just prints/validates the
 * shaped payloads (frozen block byte-identical, tail uncached, breakpoints).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... bun scripts/cache-proof-live.ts [--model <id>] [--legacy] [--dry-run]
 *
 * Cost: two small completions over a ~6k-token prefix on Haiku — roughly a
 * cent. Runs entirely outside the app server; no DB, no container.
 */
import { complete, getModel } from "@earendil-works/pi-ai";
import { applyCacheRetention } from "../src/runtime/stream-chat/cache-retention";
import { appendMemoryTailBlock } from "../src/runtime/stream-chat/system-cache-split";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const MODEL_ID = opt("--model") ?? "claude-haiku-4-5-20251001";
const LEGACY = flag("--legacy");
const DRY_RUN = flag("--dry-run");

// Frozen "region-1" base — deterministic and comfortably above the model's
// minimum cacheable prefix (4096 tokens on Haiku 4.5). Same bytes both turns.
const PARAGRAPH =
  "You are the EZCorp assistant. Follow the platform conventions precisely: " +
  "answer concisely, cite sources when the knowledge base is used, prefer " +
  "the user's stated preferences, and never reveal internal identifiers. ";
const FROZEN_BASE = `${PARAGRAPH.repeat(400)}\nEnd of standing instructions.`;

// Volatile "memory recall" tails — different every turn, like real semantic
// recall keyed on the user's message.
const TAILS = [
  "\n\n## Relevant Memories\n- The user prefers dark mode for all interfaces.\n- The user's favorite database is Postgres.",
  "\n\n## Relevant Memories\n- The user is auditing prompt-cache economics today.\n- The user ships with Bun, not Node.",
];

async function runTurn(turn: number): Promise<{ cacheRead: number; cacheWrite: number; cacheWrite1h: number }> {
  const model = getModel("anthropic", MODEL_ID as Parameters<typeof getModel<"anthropic">>[1]);
  if (!model) throw new Error(`unknown anthropic model: ${MODEL_ID}`);
  const supportsLong =
    (model as { compat?: { supportsLongCacheRetention?: boolean } }).compat
      ?.supportsLongCacheRetention !== false;

  const tail = TAILS[turn]!;
  const shaped: unknown[] = [];
  const message = await complete(
    model,
    {
      // Legacy mode reproduces the pre-fix wire shape: the volatile tail is
      // part of the single cached system block.
      systemPrompt: LEGACY ? FROZEN_BASE + tail : FROZEN_BASE,
      messages: [{ role: "user", content: "Reply with the single word: ok", timestamp: Date.now() }],
    },
    {
      apiKey: process.env.ANTHROPIC_API_KEY,
      onPayload: (body) => {
        const withTail = LEGACY ? body : appendMemoryTailBlock(body, tail);
        const out = applyCacheRetention(withTail, supportsLong, "long");
        shaped.push(out);
        return out;
      },
    },
  );
  const u = message.usage;
  console.log(
    `turn ${turn + 1}: input=${u.input} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} cacheWrite1h=${u.cacheWrite1h ?? 0}`,
  );
  return { cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cacheWrite1h: u.cacheWrite1h ?? 0 };
}

function dryRun(): void {
  // Shape two synthetic Anthropic payloads (the block layout buildParams
  // emits) through the same transforms and validate the invariants locally.
  const paint = (tail: string) => {
    const body: unknown = {
      system: [{ type: "text", text: FROZEN_BASE, cache_control: { type: "ephemeral" } }],
    };
    const withTail = LEGACY ? body : appendMemoryTailBlock(body, tail);
    return applyCacheRetention(withTail, true, "long") as {
      system: Array<{ text: string; cache_control?: { type: string; ttl?: string } }>;
    };
  };
  const [a, b] = [paint(TAILS[0]!), paint(TAILS[1]!)];
  const frozenStable = a.system[0]!.text === b.system[0]!.text;
  const frozenIs1h = a.system[0]!.cache_control?.ttl === "1h";
  const tailUncached = LEGACY || (a.system.length === 2 && a.system[1]!.cache_control === undefined);
  const tailVaries = LEGACY || a.system[1]!.text !== b.system[1]!.text;
  console.log(`dry-run (${LEGACY ? "legacy" : "split"} mode):`);
  console.log(`  frozen block byte-identical across turns: ${frozenStable}`);
  console.log(`  frozen block cache_control ttl=1h:        ${frozenIs1h}`);
  console.log(`  memory tail uncached + varying:           ${tailUncached && tailVaries}`);
  if (!(frozenStable && frozenIs1h && tailUncached && tailVaries)) {
    console.error("DRY-RUN FAIL");
    process.exit(1);
  }
  console.log("DRY-RUN PASS");
}

if (DRY_RUN) {
  dryRun();
} else {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set. Run:\n  ANTHROPIC_API_KEY=sk-ant-... bun scripts/cache-proof-live.ts\nOr validate the payload shaping offline with --dry-run.",
    );
    process.exit(2);
  }
  const one = await runTurn(0);
  const two = await runTurn(1);
  const wrotePrefix = one.cacheWrite > 0;
  const accepted1h = one.cacheWrite1h > 0;
  const readOnTurn2 = two.cacheRead > 0;
  console.log(`\nprefix written on turn 1:   ${wrotePrefix}`);
  console.log(`1h TTL accepted (1h split): ${accepted1h}`);
  console.log(`prefix READ on turn 2:      ${readOnTurn2}${LEGACY ? "  (legacy mode expects false)" : ""}`);
  const pass = LEGACY ? wrotePrefix && !readOnTurn2 : wrotePrefix && accepted1h && readOnTurn2;
  console.log(pass ? "\nPROOF PASS" : "\nPROOF FAIL");
  process.exit(pass ? 0 : 1);
}
