#!/usr/bin/env bun
// graded-card-scanner — extension subprocess.
//
// Tools:
//   - `lookup_card(cert, fresh?)` → the merged card record (identity +
//     population/price per grade) as JSON. The scanner SPA (app/, served
//     from the extension data route) calls it through
//     `POST /api/tool-invoke`; the LLM can call it directly in chat.
//   - `set_psa_token(token)` → save the user's free PSA API token so
//     lookups can return identity + population.
//
// Phase 1 returned a built-in sample card. Phase 2 swaps `lookupImpl`
// for the real pipeline (PSA official API for identity + population,
// PriceCharting for prices, per-cert Storage cache) behind the same
// seam — the tool contract does not change. The SPA keeps its own mock
// fallback for when the tool is unreachable; a REACHABLE tool with no
// token returns honest nulls (UI shows N/A + a `psa-api:no-token` source).
//
// Hard rule carried through every phase: anything the sources can't
// provide is `null` — never 0, never a guess (the UI renders "N/A").

import {
  Storage,
  createToolDispatcher,
  getChannel,
  toolError,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import { parseCertInput } from "./app/lib/cert.js";
import { mockCard } from "./app/lib/mock-card.js";
import { createHostQueue, createQueuedFetch, createRobots, type FetchImpl } from "./lib/politeness";
import { pushDashboard, registerDashboardPage } from "./lib/page";
import { buildLookup } from "./lib/pipeline";
import { fetchPsaCert } from "./lib/sources/psa-api";
import { fetchPrices } from "./lib/sources/pricecharting";
import { TOKEN_STORAGE_KEY, resolveToken } from "./lib/token";

/** @see app/lib/format.js CardRecord — the shared record shape. */
export type CardRecord = ReturnType<typeof mockCard>;

// ── Storage handles ─────────────────────────────────────────────────
//
// Cache + recent list live in `global` scope: card data is not secret
// and the recent list feeds the (user-shared) Hub page. The PSA token is
// a secret — it lives in `user` scope, written encrypted, so it is never
// shared across users nor stored in plaintext.
const cacheStorage = new Storage("global");
const tokenStorage = new Storage("user");

// ── Live pipeline wiring ────────────────────────────────────────────
//
// One per-host queue (≥1.1s gap) wraps every outbound fetch, and one
// robots gate is shared across the run. `fetch` here is the sandbox's
// allowlist-wrapped builtin (manifest `permissions.network`).
const hostQueue = createHostQueue();
const queuedFetch: FetchImpl = createQueuedFetch(hostQueue, fetch);
const robots = createRobots(queuedFetch);

const realLookup = buildLookup({
  getToken: () => resolveToken(process.env, tokenStorage),
  fetchPsa: (cert, token) => fetchPsaCert(cert, token, queuedFetch),
  fetchPrices: (identity) => fetchPrices(identity, queuedFetch, robots),
  storage: cacheStorage,
  now: () => new Date().toISOString(),
  onLookup: () => pushDashboard(cacheStorage),
});

// ── Capability seam (swappable for tests) ───────────────────────────

export type LookupImpl = (cert: string, fresh: boolean) => Promise<CardRecord>;

const mockLookup: LookupImpl = async (cert) => mockCard(cert);

let lookupImpl: LookupImpl = mockLookup;

export function _setLookupForTests(impl: LookupImpl): void {
  lookupImpl = impl;
}
export function _resetLookupForTests(): void {
  lookupImpl = mockLookup;
}

// ── lookup_card ──────────────────────────────────────────────────────

const lookupCard: ToolHandler = async (args) => {
  const { cert, fresh } = args as { cert?: unknown; fresh?: unknown };
  const parsed = parseCertInput(cert);
  if (!parsed) {
    return toolError(
      "'cert' must be a PSA certification number (5-10 digits) or a psacard.com/cert URL",
    );
  }
  try {
    const record = await lookupImpl(parsed, fresh === true);
    return toolResult(JSON.stringify(record));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolError(`lookup failed for cert ${parsed}: ${msg}`);
  }
};

// ── set_psa_token ────────────────────────────────────────────────────

const MIN_TOKEN_LEN = 10;
const MAX_TOKEN_LEN = 200;

const setPsaToken: ToolHandler = async (args) => {
  const { token } = args as { token?: unknown };
  if (typeof token !== "string") {
    return toolError("'token' must be a string");
  }
  const trimmed = token.trim();
  if (trimmed.length < MIN_TOKEN_LEN || trimmed.length > MAX_TOKEN_LEN) {
    return toolError(`'token' must be ${MIN_TOKEN_LEN}-${MAX_TOKEN_LEN} characters`);
  }
  // Owner-bound + encrypted at rest; never logged, never echoed back.
  await tokenStorage.set(TOKEN_STORAGE_KEY, trimmed, { encrypted: true });
  return toolResult("PSA token saved.");
};

export const tools: Record<string, ToolHandler> = {
  lookup_card: lookupCard,
  set_psa_token: setPsaToken,
};

/** Wire the real pipeline + dashboard, the dispatcher, and start the channel. */
export function start(): void {
  lookupImpl = realLookup;
  const ch = getChannel();
  registerDashboardPage(cacheStorage);
  createToolDispatcher(tools);
  ch.start();
}

if (import.meta.main) start();
