// ── pipeline.ts — the live lookup, behind the Phase-1 seam ──────────
//
// `buildLookup(deps)` returns the `(cert, fresh) => CardRecord` function
// that replaces Phase 1's mock. It orchestrates the sources, merges them
// into the shared CardRecord shape, caches per-cert in Storage, and keeps
// the Hub dashboard's "recent" list current.
//
// Merge rules (spec §"Phase A · pipeline"):
//   - 11 grade rows: Ungraded, PSA 1 … PSA 10.
//   - population is null everywhere EXCEPT the scanned grade's row, which
//     carries the PSA API's popAtGrade (the official API exposes only the
//     scanned grade's pop — see README).
//   - prices come from the PriceCharting grade→column mapping; unmapped
//     grades stay null.
//   - every source failure degrades to nulls with an honest source stamp;
//     the pipeline NEVER throws for a source error. It only propagates a
//     Storage failure (which the tool layer maps to a toolError).

import type { CardRecord, GradeRow } from "../app/lib/format.js";
import { cardTitle, isSameGrade, valueAtOwnGrade } from "../app/lib/format.js";
import type { PsaIdentity, PsaResult } from "./sources/psa-api";
import type { PriceMap } from "./sources/pricecharting";

/** The 11 grade rows every live record carries, low → high. */
export const GRADE_LABELS: readonly string[] = [
  "Ungraded",
  "PSA 1",
  "PSA 2",
  "PSA 3",
  "PSA 4",
  "PSA 5",
  "PSA 6",
  "PSA 7",
  "PSA 8",
  "PSA 9",
  "PSA 10",
];

export const CERT_PREFIX = "cert:";
export const RECENT_KEY = "recent";
export const RECENT_CAP = 20;

/** Per-cert cache key. */
export const certKey = (cert: string): string => `${CERT_PREFIX}${cert}`;

/** A row in the Hub dashboard's recent-lookups list. */
export interface RecentEntry {
  cert: string;
  title: string;
  grade: string;
  value: number | null;
  at: string;
}

/** The Storage surface the pipeline needs (structurally satisfied by the
 *  SDK `Storage` class; a plain fake in tests). */
export interface PipelineStorage {
  get<T = unknown>(key: string): Promise<{ value: T | null; exists: boolean }>;
  set<T = unknown>(key: string, value: T): Promise<unknown>;
}

export interface PipelineDeps {
  getToken: () => Promise<string | null>;
  fetchPsa: (cert: string, token: string | null) => Promise<PsaResult>;
  fetchPrices: (identity: PsaIdentity) => Promise<PriceMap>;
  storage: PipelineStorage;
  now: () => string;
  /** Optional post-lookup hook (live Hub refresh). Fired only after an
   *  uncached lookup; best-effort — a throw here never fails the lookup. */
  onLookup?: () => void | Promise<void>;
}

function emptyIdentity(): PsaIdentity {
  return { subject: "", year: "", set: "", cardNo: "", variety: "", grade: "" };
}

/** Source stamp for identity/pop, honest about which failure occurred. */
function identitySource(psa: PsaResult): string {
  if (psa.ok) return "psa-api";
  if (psa.kind === "no-token") return "psa-api:no-token";
  return `psa-api:error(${psa.kind})`;
}

async function recordRecent(
  storage: PipelineStorage,
  record: CardRecord,
  at: string,
): Promise<void> {
  const res = await storage.get<RecentEntry[]>(RECENT_KEY);
  const prev = Array.isArray(res.value) ? res.value : [];
  const entry: RecentEntry = {
    cert: record.cert,
    title: cardTitle(record.identity),
    grade: record.identity.grade,
    value: valueAtOwnGrade(record),
    at,
  };
  const deduped = prev.filter((e) => e.cert !== record.cert);
  const next = [entry, ...deduped].slice(0, RECENT_CAP);
  await storage.set(RECENT_KEY, next);
}

/**
 * Build the live lookup function. The returned closure is the swap-in for
 * Phase 1's `mockLookup`; the tool contract is unchanged.
 */
export function buildLookup(deps: PipelineDeps): (cert: string, fresh: boolean) => Promise<CardRecord> {
  const { getToken, fetchPsa, fetchPrices, storage, now, onLookup } = deps;

  return async function lookup(cert: string, fresh: boolean): Promise<CardRecord> {
    if (!fresh) {
      const cached = await storage.get<CardRecord>(certKey(cert));
      if (cached.exists && cached.value) return cached.value;
    }

    const fetchedAt = now();
    const token = await getToken();
    const psa = await fetchPsa(cert, token);
    const identity = psa.ok ? psa.identity : emptyIdentity();
    const popAtGrade = psa.ok ? psa.popAtGrade : null;

    let prices: PriceMap;
    let priceSource: string;
    try {
      prices = await fetchPrices(identity);
      priceSource = "pricecharting";
    } catch {
      // A hard network error — honest nulls, distinct source stamp.
      prices = {};
      priceSource = "pricecharting:error";
    }

    const grades: GradeRow[] = GRADE_LABELS.map((grade) => ({
      grade,
      pop: isSameGrade(grade, identity.grade) ? popAtGrade : null,
      price: prices[grade] ?? null,
    }));

    const idStamp = { source: identitySource(psa), fetchedAt };
    const record: CardRecord = {
      cert,
      identity,
      grades,
      sources: {
        identity: idStamp,
        pop: idStamp,
        price: { source: priceSource, fetchedAt },
      },
    };

    // Only persist + surface SUCCESSFUL identity lookups. A failed
    // identity (no-token / http / quota / shape) still returns the honest
    // null-stamped record, but is NOT cached or added to `recent` — so a
    // later lookup (e.g. once a token is set) re-fetches live data instead
    // of serving a stale null record, and the Hub never lists a dead cert.
    if (psa.ok) {
      await storage.set(certKey(cert), record);
      await recordRecent(storage, record, fetchedAt);
      if (onLookup) {
        try {
          await onLookup();
        } catch {
          // Live Hub refresh is best-effort; the lookup already succeeded
          // and cached, so a push failure must not fail the tool call.
        }
      }
    }

    return record;
  };
}
