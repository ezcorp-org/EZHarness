// @ts-check
// Presentation + table math for card records. Pure functions, shared by
// the SPA and unit tests. Hard rule from the spec: a missing price is
// "N/A", NEVER $0 or a guess.

/**
 * @typedef {{grade: string, pop: number|null, price: number|null}} GradeRow
 * @typedef {{source: string, fetchedAt: string}} SourceStamp
 * @typedef {{
 *   cert: string,
 *   identity: {subject: string, year: string, set: string, cardNo: string,
 *              variety: string, grade: string},
 *   grades: GradeRow[],
 *   sources: {identity?: SourceStamp, pop?: SourceStamp, price?: SourceStamp},
 * }} CardRecord
 */

/**
 * Format a price for display. `null`/`undefined` → "N/A" (never 0).
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function formatMoney(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "N/A";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Numeric sort key for a grade label, low → high.
 * "Ungraded" → 0, "PSA 8.5" → 8.5, "PSA 10" / "GEM MT 10" → 10.
 * Unknown labels sort first (−1) rather than being dropped.
 * @param {string} grade
 * @returns {number}
 */
export function gradeSortKey(grade) {
  if (/ungraded/i.test(grade)) return 0;
  const m = /(\d+(?:\.\d+)?)\s*$/.exec(grade.trim());
  return m ? Number(m[1]) : -1;
}

/**
 * True when `rowGrade` names the same grade as the slab's own grade
 * label (identity.grade may be "PSA 9", "9", or "MINT 9").
 * @param {string} rowGrade
 * @param {string} identityGrade
 * @returns {boolean}
 */
export function isSameGrade(rowGrade, identityGrade) {
  const a = gradeSortKey(rowGrade);
  const b = gradeSortKey(identityGrade);
  return a >= 0 && b >= 0 && a === b && !/ungraded/i.test(rowGrade) === !/ungraded/i.test(identityGrade);
}

/**
 * Build the detail-view rows: sorted low→high with a "% vs the next
 * lower PRICED grade" column. Rows without a price get pctVsLower null;
 * the first priced row also gets null (nothing lower to compare).
 * @param {GradeRow[]} grades
 * @returns {(GradeRow & {pctVsLower: number|null})[]}
 */
export function buildGradeRows(grades) {
  const sorted = [...grades].sort((a, b) => gradeSortKey(a.grade) - gradeSortKey(b.grade));
  /** @type {number|null} */
  let lowerPrice = null;
  return sorted.map((row) => {
    /** @type {number|null} */
    let pctVsLower = null;
    if (row.price !== null && row.price !== undefined) {
      if (lowerPrice !== null && lowerPrice > 0) {
        pctVsLower = ((row.price - lowerPrice) / lowerPrice) * 100;
      }
      lowerPrice = row.price;
    }
    return { ...row, pctVsLower };
  });
}

/**
 * Display string for the pct column: "+712.9%" / "−12.4%" / "—".
 * @param {number|null} pct
 * @returns {string}
 */
export function formatPct(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return "—";
  const sign = pct >= 0 ? "+" : "−";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/**
 * The card's headline value: the price at its own grade, else null.
 * @param {CardRecord} record
 * @returns {number|null}
 */
export function valueAtOwnGrade(record) {
  const row = record.grades.find((g) => isSameGrade(g.grade, record.identity.grade));
  return row?.price ?? null;
}

/**
 * One-line display title for a saved card.
 * @param {CardRecord["identity"]} identity
 * @returns {string}
 */
export function cardTitle(identity) {
  const parts = [identity.year, identity.set, identity.subject].filter((s) => s && s.length > 0);
  const head = parts.join(" ");
  return identity.cardNo ? `${head} #${identity.cardNo}` : head;
}

/**
 * Case-insensitive search across a saved card's visible fields.
 * @param {{cert: string, record: CardRecord|null}} saved
 * @param {string} query
 * @returns {boolean}
 */
export function searchMatch(saved, query) {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  if (saved.cert.includes(q)) return true;
  const id = saved.record?.identity;
  if (!id) return false;
  return [id.subject, id.year, id.set, id.cardNo, id.variety, id.grade]
    .some((f) => f && f.toLowerCase().includes(q));
}
