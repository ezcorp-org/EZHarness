// ── identify.ts — the identify_slab pipeline, behind a dep seam ─────
//
// `buildIdentify(deps)` returns the `(bytes, mimeType) => record`
// function the identify_slab tool dispatches to. It orchestrates:
//
//   decode (host-side zxing ladder) → classify (grader + cert) →
//   identity (PSA API / CGC cert page / decode-only) →
//   prices (PriceCharting per-company graded columns) →
//   deltas (adjacent-grade % steps per company).
//
// Null-honesty invariant carried from lookup_card: every source failure
// degrades to nulls/"" with an honest source stamp; the pipeline throws
// ONLY for undecodable input bytes (a caller error the tool layer maps
// to a toolError). BGS/SGC are decode-only in v1 — cert + grader with
// identity nulls, stamped "decode-only" (documented in the README).

import { classifyDecode, type Grader } from "./classify";
import { computeDeltas, type CompanyDeltas } from "./deltas";
import type { CgcResult } from "./sources/cgc";
import type { PsaIdentity, PsaResult } from "./sources/psa-api";
import type { CompanyPriceMap, PriceMap } from "./sources/pricecharting";

export interface SourceStamp {
  source: string;
  fetchedAt: string;
}

/** The identify_slab tool's JSON output shape (spec-locked). */
export interface IdentifySlabRecord {
  cert: string | null;
  grader: Grader;
  identity: PsaIdentity;
  /** Per-company grade→price map (PriceCharting full price guide). */
  grades: CompanyPriceMap;
  /** Adjacent-grade % steps per company (chart payload). */
  deltas: CompanyDeltas[];
  sources: {
    decode: SourceStamp;
    identity: SourceStamp;
    price: SourceStamp;
  };
}

export interface IdentifyDeps {
  /** Host-side ladder decode (lib/decode.ts). Null = no barcode found. */
  decodeImage(bytes: Uint8Array, mimeType: string): string | null;
  getToken(): Promise<string | null>;
  fetchPsa(cert: string, token: string | null): Promise<PsaResult>;
  fetchCgc(cert: string): Promise<CgcResult>;
  fetchAllPrices(
    identity: PsaIdentity,
  ): Promise<{ prices: PriceMap; companies: CompanyPriceMap }>;
  now(): string;
}

export function emptyIdentity(): PsaIdentity {
  return { subject: "", year: "", set: "", cardNo: "", variety: "", grade: "" };
}

/** Honest identity-source stamp for the PSA path (mirrors pipeline.ts). */
function psaIdentitySource(psa: PsaResult): string {
  if (psa.ok) return "psa-api";
  if (psa.kind === "no-token") return "psa-api:no-token";
  return `psa-api:error(${psa.kind})`;
}

function cgcIdentitySource(cgc: CgcResult): string {
  if (cgc.ok) return "cgc-cert-page";
  return `cgc-cert-page:error(${cgc.kind})`;
}

/**
 * Build the identify pipeline. The returned closure is what the
 * identify_slab tool calls; tests swap it via the index.ts seam.
 */
export function buildIdentify(
  deps: IdentifyDeps,
): (bytes: Uint8Array, mimeType: string) => Promise<IdentifySlabRecord> {
  return async function identify(bytes, mimeType): Promise<IdentifySlabRecord> {
    const fetchedAt = deps.now();

    // 1. Decode. Undecodable BYTES throw (caller error → toolError); a
    // photo with no findable barcode is a legitimate null.
    const decoded = deps.decodeImage(bytes, mimeType);
    const decodeStamp: SourceStamp = {
      source: decoded !== null ? "zxing" : "zxing:none",
      fetchedAt,
    };

    // 2. Classify grader + cert from the decode payload.
    const { grader, cert } = classifyDecode(decoded);

    // 3. Identity, per grader.
    let identity = emptyIdentity();
    let identitySource = "none";
    if (grader === "PSA" && cert !== null) {
      const token = await deps.getToken();
      const psa = await deps.fetchPsa(cert, token);
      if (psa.ok) identity = psa.identity;
      identitySource = psaIdentitySource(psa);
    } else if (grader === "CGC" && cert !== null) {
      const cgc = await deps.fetchCgc(cert);
      if (cgc.ok) identity = cgc.identity;
      identitySource = cgcIdentitySource(cgc);
    } else if (grader === "BGS" || grader === "SGC") {
      // v1: decode-only — cert + grader, identity honest nulls.
      identitySource = "decode-only";
    }

    // 4. Prices — only when we have a subject to confidently match on
    // (fetchAllPrices would refuse anyway; skipping documents the intent
    // in the source stamp instead of a silent empty result).
    let companies: CompanyPriceMap = {};
    let priceSource = "not-searched";
    if (identity.subject.trim() !== "") {
      try {
        const all = await deps.fetchAllPrices(identity);
        companies = all.companies;
        priceSource = "pricecharting";
      } catch {
        companies = {};
        priceSource = "pricecharting:error";
      }
    }

    // 5. Deltas.
    const deltas = computeDeltas(companies);

    return {
      cert,
      grader,
      identity,
      grades: companies,
      deltas,
      sources: {
        decode: decodeStamp,
        identity: { source: identitySource, fetchedAt },
        price: { source: priceSource, fetchedAt },
      },
    };
  };
}
