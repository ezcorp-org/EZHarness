// ── sources/pricecharting.ts — keyless price-by-grade lookup ────────
//
// PriceCharting publishes a price table per product with one column per
// grade tier. We (1) search for the product, (2) confidence-gate the
// match, then (3) parse the price cells. Every failure mode — robots
// disallow, no confident match, blank cells — degrades to null prices
// (spec invariant #1). Network errors propagate so the pipeline can
// stamp `pricecharting:error`; everything else returns an all-null map.

import type { FetchImpl, Robots } from "../politeness";
import type { PsaIdentity } from "./psa-api";

const HOST = "www.pricecharting.com";
const ORIGIN = `https://${HOST}`;
const SEARCH_PATH = "/search-products";

/**
 * Grade → PriceCharting price-column id. LOCKED by the Phase-0 council
 * (2026-07-06): one entry per grade PriceCharting actually publishes.
 *   Ungraded = used, PSA 7 = complete, PSA 8 = new,
 *   PSA 9 = graded, PSA 10 = manual_only.
 * `box_only_price` (grade 9.5) is intentionally unused, and PSA 1–6
 * have no PriceCharting column → those grades stay null.
 */
export const GRADE_PRICE_ID: Readonly<Record<string, string>> = Object.freeze({
  Ungraded: "used_price",
  "PSA 7": "complete_price",
  "PSA 8": "new_price",
  "PSA 9": "graded_price",
  "PSA 10": "manual_only_price",
});

export type PriceMap = Record<string, number | null>;

/** The mapped grades, all null — the honest result for every soft miss. */
function allNull(): PriceMap {
  const out: PriceMap = {};
  for (const grade of Object.keys(GRADE_PRICE_ID)) out[grade] = null;
  return out;
}

function subjectTokens(identity: PsaIdentity): string[] {
  return identity.subject.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

function searchQuery(identity: PsaIdentity): string {
  return `${identity.year} ${identity.set} ${identity.subject} ${identity.cardNo}`
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * First `/game/…` product href in the search results, else null. Results
 * pages emit the link as either an absolute URL on PriceCharting's own
 * origin (`href="https://www.pricecharting.com/game/…"`) or a bare path
 * (`href="/game/…"`); we accept both but ONLY that one origin, and always
 * return the PATH portion so the caller never fetches another host (the
 * SSRF guard stays even if the markup carries a full URL).
 */
export function firstProductHref(searchHtml: string): string | null {
  const m = new RegExp(`href="(?:${escapeRegExp(ORIGIN)})?(/game/[^"]+)"`, "i").exec(searchHtml);
  return m?.[1] ?? null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Drop any `?query`/`#hash` so slug matching sees the path only. */
function pathOnly(href: string): string {
  return href.split(/[?#]/, 1)[0] ?? href;
}

/**
 * Confidence gate: the product slug must match the card number on a DIGIT
 * boundary AND share an EXACT token with the subject — otherwise the match
 * is unconfident and we must NOT attach its prices (a wrong card is worse
 * than N/A). Both checks are boundary-safe so card "4" does not match a
 * "-40" slug and "mew" does not match a "mewtwo" slug.
 */
export function isConfidentMatch(href: string, identity: PsaIdentity): boolean {
  const slug = href.toLowerCase();
  const cardNo = identity.cardNo.trim().toLowerCase();
  // Subject tokens ≥3 chars — short fragments (e.g. "ex", "jr") are too
  // ambiguous to anchor a match on.
  const subjectToks = subjectTokens(identity).filter((t) => t.length >= 3);
  if (subjectToks.length === 0) return false;

  // Card number must sit on a digit boundary: "4" matches "…-4" but NOT
  // "…-40". An empty cardNo (PSA gave none) skips this and leans wholly on
  // the subject-token match.
  if (cardNo !== "") {
    const bounded = new RegExp(`(^|[^0-9])${escapeRegExp(cardNo)}([^0-9]|$)`);
    if (!bounded.test(slug)) return false;
  }

  // At least one subject token must EQUAL a slug token exactly.
  const slugTokens = new Set(slug.split(/[^a-z0-9]+/).filter((t) => t.length > 0));
  return subjectToks.some((token) => slugTokens.has(token));
}

/** Parse one `<td id="…_price">` cell → dollar float, or null if blank. */
function priceFromCell(html: string, priceId: string): number | null {
  const re = new RegExp(
    `id="${priceId}"[^>]*>\\s*<span class="price js-price">\\s*\\$([\\d,]+(?:\\.\\d+)?)`,
    "i",
  );
  const m = re.exec(html);
  const raw = m?.[1];
  if (raw === undefined) return null;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Parse the full grade→price map from a product page's HTML. */
export function parsePrices(productHtml: string): PriceMap {
  const out: PriceMap = {};
  for (const [grade, priceId] of Object.entries(GRADE_PRICE_ID)) {
    out[grade] = priceFromCell(productHtml, priceId);
  }
  return out;
}

// ── Per-company graded columns (identify_slab multi-grader flow) ────
//
// The product page also carries a "full price guide" table
// (`<table id="full-prices">`) with one label+price row per graded
// column. Row-label vocabulary (verified against the live Charizard
// capture the summary fixture came from):
//   - "Grade N"        — the generic graded column; PSA-tracked (the
//     locked summary mapping already treats Grade 7/8/9 as PSA 7/8/9),
//     EXCEPT "Grade 9.5" which is the BGS 9.5 column (= the summary
//     table's box_only cell — BGS is the company that grades 9.5).
//   - "PSA|BGS|CGC|SGC N" — explicit per-company rows (top tiers).
//   - Qualified labels ("BGS 10 Black", "CGC 10 Pristine") and
//     non-grade rows ("Ungraded", "Box Only", …) are IGNORED — they are
//     not comparable adjacent-grade points.
// Missing/blank price → null, never a guess (spec invariant #1).

/** company → (grade label → price|null), e.g. `{ PSA: { "9": 2587.5 } }`. */
export type CompanyPriceMap = Record<string, Record<string, number | null>>;

export const GRADING_COMPANIES = ["PSA", "BGS", "CGC", "SGC"] as const;

const FULL_PRICES_TABLE_RE = /<table[^>]*id="full-prices"[\s\S]*?<\/table>/i;
// One label cell, optionally followed by a price cell on the same row.
const FULL_PRICE_ROW_RE =
  /<tr[^>]*>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>\s*(?:<td[^>]*>([\s\S]*?)<\/td>)?/gi;
const COMPANY_LABEL_RE = /^(PSA|BGS|CGC|SGC)\s+(\d+(?:\.\d+)?)$/i;
const GENERIC_LABEL_RE = /^Grade\s+(\d+(?:\.\d+)?)$/i;

/** Map a full-price-guide row label to its (company, grade), or null for
 *  labels the multi-grader flow doesn't track. */
export function companyForLabel(label: string): { company: string; grade: string } | null {
  const explicit = COMPANY_LABEL_RE.exec(label);
  if (explicit) return { company: explicit[1]!.toUpperCase(), grade: explicit[2]! };
  const generic = GENERIC_LABEL_RE.exec(label);
  if (generic) {
    const grade = generic[1]!;
    // "Grade 9.5" is BGS's column; whole-number generic grades are PSA's
    // (mirrors the council-locked summary mapping: box_only = 9.5).
    return { company: grade === "9.5" ? "BGS" : "PSA", grade };
  }
  return null;
}

/** Dollar amount from a price cell's inner HTML, or null when blank. */
function priceFromRowCell(cellHtml: string | undefined): number | null {
  if (cellHtml === undefined) return null;
  const m = /\$([\d,]+(?:\.\d+)?)/.exec(cellHtml);
  const raw = m?.[1];
  if (raw === undefined) return null;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse ALL per-company graded columns from the product page's full
 * price-guide table. A page without the table (or with no trackable
 * rows) yields `{}`; a row present with a blank price yields an
 * explicit null for that grade.
 */
export function parseCompanyPrices(productHtml: string): CompanyPriceMap {
  const table = FULL_PRICES_TABLE_RE.exec(productHtml)?.[0];
  if (!table) return {};
  const out: CompanyPriceMap = {};
  for (const m of table.matchAll(FULL_PRICE_ROW_RE)) {
    const mapped = companyForLabel(m[1]!.trim());
    if (!mapped) continue;
    const byGrade = out[mapped.company] ?? {};
    byGrade[mapped.grade] = priceFromRowCell(m[2]);
    out[mapped.company] = byGrade;
  }
  return out;
}

/**
 * Shared fetch flow: search → confidence gate → product page HTML, or
 * null for every soft miss (robots disallow, no confident match, non-200
 * — the callers translate null into their honest all-null shapes). A
 * hard network error propagates. Robots is checked before EACH fetch.
 */
async function fetchProductHtml(
  identity: PsaIdentity,
  fetchImpl: FetchImpl,
  robots: Robots,
): Promise<string | null> {
  // Nothing to confidently match on → don't even fire a request (polite).
  if (subjectTokens(identity).length === 0) return null;

  // Step 1 — search.
  if (!(await robots.isAllowed(HOST, SEARCH_PATH))) return null;
  const searchUrl = `${ORIGIN}${SEARCH_PATH}?q=${encodeURIComponent(searchQuery(identity))}&type=prices`;
  const searchRes = await fetchImpl(searchUrl);
  if (!searchRes.ok) return null;

  // A specific enough query 307-redirects straight to the product page, so
  // `searchRes` may ALREADY be the product (its final url is a `/game/…`
  // path). Detect that from the final url — falling back to the request url
  // when a fake Response carries an empty `url` — and parse it in place with
  // NO second fetch (one fewer request = more polite). The post-hoc
  // confidence + robots checks still gate it.
  const finalPath = new URL(searchRes.url || searchUrl).pathname;
  if (finalPath.startsWith("/game/")) {
    if (!isConfidentMatch(finalPath, identity)) return null;
    if (!(await robots.isAllowed(HOST, finalPath))) return null;
    return searchRes.text();
  }

  // Otherwise it's a results page — follow the first product link.
  const href = firstProductHref(await searchRes.text());
  if (href === null || !isConfidentMatch(pathOnly(href), identity)) return null;

  // Step 2 — product page.
  const productPath = pathOnly(href);
  if (!(await robots.isAllowed(HOST, productPath))) return null;
  const productRes = await fetchImpl(`${ORIGIN}${href}`);
  if (!productRes.ok) return null;
  return productRes.text();
}

/**
 * Look up prices for an identity. Robots is checked before EACH fetch;
 * an unconfident match or a disallowed path yields all-null (no throw).
 * A hard network error propagates to the caller.
 */
export async function fetchPrices(
  identity: PsaIdentity,
  fetchImpl: FetchImpl,
  robots: Robots,
): Promise<PriceMap> {
  const html = await fetchProductHtml(identity, fetchImpl, robots);
  return html === null ? allNull() : parsePrices(html);
}

/**
 * Combined lookup for the multi-grader flow: the summary grade→price
 * map AND the per-company graded columns, from ONE page fetch (same
 * politeness budget as `fetchPrices`). Soft misses yield the honest
 * empty shapes; hard network errors propagate.
 */
export async function fetchAllPrices(
  identity: PsaIdentity,
  fetchImpl: FetchImpl,
  robots: Robots,
): Promise<{ prices: PriceMap; companies: CompanyPriceMap }> {
  const html = await fetchProductHtml(identity, fetchImpl, robots);
  if (html === null) return { prices: allNull(), companies: {} };
  return { prices: parsePrices(html), companies: parseCompanyPrices(html) };
}
