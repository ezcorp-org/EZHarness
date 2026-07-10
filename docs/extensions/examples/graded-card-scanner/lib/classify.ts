// ── classify.ts — grader classification from a decoded barcode/QR ────
//
// Maps the raw text a slab's barcode/QR decodes to into (grader, cert):
//
//   - psacard.com/cert/<n> URL or a BARE 5-10 digit run (the ITF front
//     label) ⇒ PSA — reuses `parseCertInput` (app/lib/cert.js), the same
//     rules the phone scanner + lookup_card use (DRY).
//   - cgccards.com / cgccomics.com cert URL ⇒ CGC.
//   - beckett.com URL with a digit run ⇒ BGS.
//   - gosgc.com / sgccard.com URL with a digit run ⇒ SGC.
//   - anything else ⇒ grader "unknown" with a null cert — honest nulls,
//     never a guess (spec invariant).
//
// Pure functions; no I/O.

import { parseCertInput } from "../app/lib/cert.js";

export type Grader = "PSA" | "CGC" | "BGS" | "SGC" | "unknown";

export interface SlabClassification {
  grader: Grader;
  /** Certification number digits, or null when unclassifiable. */
  cert: string | null;
}

// CGC cert lookups live at cgccards.com/certlookup/<n>/ (cards) and
// cgccomics.com/certlookup/<n>/ (comics); modern slabs QR-encode those
// URLs. Certs are long digit runs (typically 10) — accept 5-12 anywhere
// in the URL's path/query so format drift degrades gracefully.
const CGC_URL_RE = /(?:cgccards|cgccomics)\.com[^\s]*?(\d{5,12})/i;
// BGS slab QR codes point at beckett.com (grading lookup paths carry the
// serial as a digit run).
const BGS_URL_RE = /beckett\.com[^\s]*?(\d{5,12})/i;
// SGC lookup URLs: gosgc.com (current) / sgccard.com (legacy).
const SGC_URL_RE = /(?:gosgc|sgccard)\.com[^\s]*?(\d{5,12})/i;

const UNKNOWN: SlabClassification = { grader: "unknown", cert: null };

/**
 * Classify a decoded payload. PSA is checked FIRST (its bare-digit ITF
 * form is the most common physical label); company-URL forms are
 * mutually exclusive by host.
 */
export function classifyDecode(text: unknown): SlabClassification {
  if (typeof text !== "string" || text.trim().length === 0) return UNKNOWN;
  const trimmed = text.trim();

  // PSA: psacard.com cert URL or bare 5-10 digit ITF payload.
  const psaCert = parseCertInput(trimmed);
  if (psaCert !== null) return { grader: "PSA", cert: psaCert };

  const cgc = CGC_URL_RE.exec(trimmed);
  if (cgc) return { grader: "CGC", cert: cgc[1]! };

  const bgs = BGS_URL_RE.exec(trimmed);
  if (bgs) return { grader: "BGS", cert: bgs[1]! };

  const sgc = SGC_URL_RE.exec(trimmed);
  if (sgc) return { grader: "SGC", cert: sgc[1]! };

  return UNKNOWN;
}
