// ── sources/cgc.ts — CGC public cert page (identity) ────────────────
//
// CGC has no free public JSON API; identity comes from scraping the
// public cert-verification page:
//
//   GET https://www.cgccards.com/certlookup/<cert>/
//
// Parsing is FIXTURES-FIRST and defensive by contract (mirrors
// psa-api.ts): the exact live field names are verified only by the
// sanity script. Label/value pairs are read from BOTH <dt>/<dd> and
// <th>/<td> shapes, labels match case-insensitively, and any missing
// field degrades to "" per the null-honesty invariant. Failures are
// TYPED so the caller can stamp the right source note. The politeness
// contract applies: robots.txt is checked before the fetch and the
// caller passes the per-host queued fetch.

import type { FetchImpl, Robots } from "../politeness";
import type { PsaIdentity } from "./psa-api";

const HOST = "www.cgccards.com";
const ORIGIN = `https://${HOST}`;
const LOOKUP_PATH = "/certlookup";

export type CgcFailureKind = "robots" | "http" | "shape";

export type CgcResult =
  | { ok: true; identity: PsaIdentity }
  | { ok: false; kind: CgcFailureKind };

// Label → identity field. First matching alias wins; unmatched labels
// are ignored (e.g. "Language").
const LABEL_FIELDS: Array<{ re: RegExp; field: keyof PsaIdentity }> = [
  { re: /^card\s*name$|^character$/i, field: "subject" },
  { re: /^year$/i, field: "year" },
  { re: /^(set|set\s*name|series)$/i, field: "set" },
  { re: /^card\s*(number|#)$/i, field: "cardNo" },
  { re: /^(variant|variety)(\s*\/\s*pedigree)?$/i, field: "variety" },
  { re: /^grade$/i, field: "grade" },
];

const DT_DD_RE = /<dt[^>]*>\s*([^<]+?)\s*<\/dt>\s*<dd[^>]*>\s*([^<]*?)\s*<\/dd>/gi;
const TH_TD_RE = /<th[^>]*>\s*([^<]+?)\s*<\/th>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>/gi;

/**
 * Parse a CGC cert page into an identity. Returns null when NO known
 * label matched at all (a shape miss — page layout changed or the cert
 * doesn't exist); otherwise every unmatched field is "" (honest).
 */
export function parseCgcCertPage(html: string): PsaIdentity | null {
  const identity: PsaIdentity = {
    subject: "",
    year: "",
    set: "",
    cardNo: "",
    variety: "",
    grade: "",
  };
  let matchedAny = false;
  for (const re of [DT_DD_RE, TH_TD_RE]) {
    for (const m of html.matchAll(re)) {
      const label = m[1]!.trim();
      const value = m[2]!.trim();
      const mapped = LABEL_FIELDS.find((f) => f.re.test(label));
      if (!mapped) continue;
      matchedAny = true;
      if (identity[mapped.field] === "") identity[mapped.field] = value;
    }
  }
  return matchedAny ? identity : null;
}

/**
 * Fetch + parse a CGC cert. Robots is checked before the fetch (spec
 * politeness invariant); network errors and non-200s are typed "http";
 * an unparseable page is typed "shape".
 */
export async function fetchCgcCert(
  cert: string,
  fetchImpl: FetchImpl,
  robots: Robots,
): Promise<CgcResult> {
  const path = `${LOOKUP_PATH}/${encodeURIComponent(cert)}/`;
  if (!(await robots.isAllowed(HOST, path))) return { ok: false, kind: "robots" };

  let res: Response;
  try {
    res = await fetchImpl(`${ORIGIN}${path}`);
  } catch {
    return { ok: false, kind: "http" };
  }
  if (!res.ok) return { ok: false, kind: "http" };

  const identity = parseCgcCertPage(await res.text());
  if (identity === null) return { ok: false, kind: "shape" };
  return { ok: true, identity };
}
