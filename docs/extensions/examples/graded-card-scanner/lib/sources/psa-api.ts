// ── sources/psa-api.ts — PSA official API (identity + population) ───
//
// PSA's HTML pages are off-limits (Cloudflare interactive challenge,
// verified 2026-07-06 — spec invariant #3). Identity and the scanned
// grade's population come ONLY from the official JSON API:
//
//   GET https://api.psacard.com/publicapi/cert/GetByCertNumber/<cert>
//   authorization: bearer <token>
//
// Parsing is DEFENSIVE by contract: the exact field names are verified
// LIVE only by the sanity script (Phase C). Any missing/renamed field
// degrades to "" (identity strings) or null (population) per the
// null-honesty invariant — the parser must never throw on shape drift.
// Failures are TYPED so the caller can stamp the right source note.

import type { TimedFetch } from "../politeness";

export interface PsaIdentity {
  subject: string;
  year: string;
  set: string;
  cardNo: string;
  variety: string;
  grade: string;
}

export type PsaFailureKind = "no-token" | "http" | "quota" | "shape";

export type PsaResult =
  | { ok: true; identity: PsaIdentity; popAtGrade: number | null; popHigher: number | null }
  | { ok: false; kind: PsaFailureKind };

const API_BASE = "https://api.psacard.com/publicapi/cert/GetByCertNumber";
// The 15s budget is enforced by the queued fetch, which arms the abort
// AFTER acquiring the per-host slot (so a queue wait never eats it) and
// keeps the signal live across the body read below.
const PSA_TIMEOUT_MS = 15_000;

/** Coerce an API value to a display string; missing/null → "". */
function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** Coerce an API value to a population count; missing/non-numeric → null. */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Fetch a PSA cert. Returns typed identity + population on success, or a
 * typed failure. The 15s timeout is delegated to the queued fetch (see
 * PSA_TIMEOUT_MS) so it starts after the per-host queue slot.
 */
export async function fetchPsaCert(
  cert: string,
  token: string | null,
  fetchImpl: TimedFetch,
): Promise<PsaResult> {
  if (token === null || token.trim() === "") return { ok: false, kind: "no-token" };

  // Single-line the await call: a multi-line async call leaves each
  // argument on its own line, and bun's coverage instrumenter drops the
  // DA hit for those nested-async continuation lines under the sharded
  // merge (they read alone but zero out across shards). Hoisting the args
  // to plain synchronous locals keeps every line's attribution stable.
  const url = `${API_BASE}/${encodeURIComponent(cert)}`;
  const init = { headers: { authorization: `bearer ${token}` } };
  let res: Response;
  try {
    res = await fetchImpl(url, init, PSA_TIMEOUT_MS);
  } catch {
    // Network error OR the timeout abort — both are transport failures.
    return { ok: false, kind: "http" };
  }

  if (res.status === 429) return { ok: false, kind: "quota" };
  if (!res.ok) return { ok: false, kind: "http" };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, kind: "shape" };
  }

  const certObj = (body as { PSACert?: unknown } | null)?.PSACert;
  if (certObj === null || typeof certObj !== "object") return { ok: false, kind: "shape" };
  const c = certObj as Record<string, unknown>;

  return {
    ok: true,
    identity: {
      subject: str(c.Subject),
      year: str(c.Year),
      set: str(c.Brand),
      cardNo: str(c.CardNumber),
      variety: str(c.Variety),
      grade: str(c.CardGrade ?? c.GradeDescription),
    },
    popAtGrade: num(c.TotalPopulation),
    popHigher: num(c.PopulationHigher),
  };
}
