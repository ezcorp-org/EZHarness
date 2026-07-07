// @ts-check
// Detail-view chart — hand-rolled SVG, pure function of the grade rows.
//
// Form: TWO stacked panels sharing the grade x-axis — population bars on
// top, price dots+line below. Population (a count) and price (USD) are
// different scales; overlaying them on one plot would need a dual axis,
// which misleads. One measure per panel, same x, reads as one figure.
//
// Rules honored: single hue per panel (no legend needed — panel titles
// name the series), thin bars with rounded data-ends and 2px surface
// gaps, 2px line + ≥8px markers, selective direct labels (scanned grade
// + priced extremes only), missing price = a GAP, never a zero mark.
// Colors are CSS custom properties (--gcs-*) so light/dark swap in CSS.

import { buildGradeRows, formatMoney, gradeSortKey, isSameGrade } from "./format.js";

/** @typedef {import("./format.js").GradeRow} GradeRow */

const W = 360;
const PANEL_H = 110;
const GAP_Y = 26; // between panels (price panel title lives here)
const PAD = { top: 22, right: 10, bottom: 20, left: 10 };
const BAR_GAP = 2;

/** @param {string} s @returns {string} */
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Short x tick: "PSA 10" → "10", "Ungraded" → "Raw". @param {string} g */
function shortGrade(g) {
  if (/ungraded/i.test(g)) return "Raw";
  const k = gradeSortKey(g);
  return k >= 0 ? String(k) : g;
}

/**
 * Build the two-panel SVG. Deterministic — same input, same markup.
 * @param {GradeRow[]} grades
 * @param {string} scannedGrade identity.grade of the slab (highlighted)
 * @returns {string} svg markup
 */
export function buildChartSvg(grades, scannedGrade) {
  const rows = buildGradeRows(grades);
  if (rows.length === 0) {
    return `<svg viewBox="0 0 ${W} 60" role="img" aria-label="No grade data"><text x="${W / 2}" y="34" text-anchor="middle" class="gcs-chart-muted">No grade data</text></svg>`;
  }

  const H = PAD.top + PANEL_H + GAP_Y + PANEL_H + PAD.bottom;
  const plotW = W - PAD.left - PAD.right;
  const slot = plotW / rows.length;
  const barW = Math.max(4, slot - BAR_GAP * 2);
  const xCenter = (/** @type {number} */ i) => PAD.left + slot * i + slot / 2;

  const maxPop = Math.max(1, ...rows.map((r) => r.pop ?? 0));
  const priced = rows.filter((r) => r.price !== null && r.price !== undefined);
  const maxPrice = Math.max(1, ...priced.map((r) => /** @type {number} */ (r.price)));

  const popBase = PAD.top + PANEL_H;
  const priceTop = popBase + GAP_Y;
  const priceBase = priceTop + PANEL_H;

  /** @type {string[]} */
  const parts = [];
  parts.push(
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Population and price by grade" class="gcs-chart">`,
  );

  // Panel titles (text tokens, not series color).
  parts.push(`<text x="${PAD.left}" y="14" class="gcs-chart-title">Population</text>`);
  parts.push(`<text x="${PAD.left}" y="${priceTop - 8}" class="gcs-chart-title">Price (USD)</text>`);

  // Baselines.
  parts.push(`<line x1="${PAD.left}" y1="${popBase}" x2="${W - PAD.right}" y2="${popBase}" class="gcs-chart-axis"/>`);
  parts.push(`<line x1="${PAD.left}" y1="${priceBase}" x2="${W - PAD.right}" y2="${priceBase}" class="gcs-chart-axis"/>`);

  // ── Population bars ──────────────────────────────────────────────
  rows.forEach((r, i) => {
    const scanned = isSameGrade(r.grade, scannedGrade);
    const pop = r.pop ?? 0;
    const h = r.pop === null ? 0 : Math.max(pop > 0 ? 3 : 0, (pop / maxPop) * (PANEL_H - 14));
    const x = xCenter(i) - barW / 2;
    const y = popBase - h;
    if (h > 0) {
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" ` +
          `class="gcs-bar${scanned ? " gcs-bar-scanned" : ""}" data-grade="${esc(r.grade)}">` +
          `<title>${esc(r.grade)}: pop ${pop.toLocaleString("en-US")}</title></rect>`,
      );
    }
    if (scanned) {
      // Selective direct label: the scanned grade only.
      parts.push(
        `<text x="${xCenter(i).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" class="gcs-chart-label">${pop.toLocaleString("en-US")}</text>`,
      );
      parts.push(
        `<circle cx="${xCenter(i).toFixed(1)}" cy="${popBase + 12}" r="2.5" class="gcs-scanned-dot"/>`,
      );
    }
    // Shared x ticks under the price panel only (drawn below).
  });

  // ── Price dots + line (gaps where price is null) ────────────────
  const yPrice = (/** @type {number} */ p) => priceBase - Math.max(3, (p / maxPrice) * (PANEL_H - 14));
  let path = "";
  let pen = false;
  rows.forEach((r, i) => {
    if (r.price === null || r.price === undefined) {
      pen = false; // lift the pen — a gap, never zero
      return;
    }
    const x = xCenter(i);
    const y = yPrice(r.price);
    path += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  });
  if (path.includes("L")) parts.push(`<path d="${path}" class="gcs-price-line" fill="none"/>`);

  const pricedValues = priced.map((r) => /** @type {number} */ (r.price));
  const minPriced = Math.min(...pricedValues);
  rows.forEach((r, i) => {
    if (r.price === null || r.price === undefined) return;
    const scanned = isSameGrade(r.grade, scannedGrade);
    const x = xCenter(i);
    const y = yPrice(r.price);
    parts.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" class="gcs-price-dot${scanned ? " gcs-dot-scanned" : ""}" data-grade="${esc(r.grade)}">` +
        `<title>${esc(r.grade)}: ${esc(formatMoney(r.price))}</title></circle>`,
    );
    // Selective labels: scanned grade + the priced extremes.
    if (scanned || r.price === maxPrice || r.price === minPriced) {
      const anchor = i === 0 ? "start" : i === rows.length - 1 ? "end" : "middle";
      parts.push(
        `<text x="${x.toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="${anchor}" class="gcs-chart-label">${esc(formatMoney(r.price))}</text>`,
      );
    }
  });

  // ── Shared x ticks ───────────────────────────────────────────────
  rows.forEach((r, i) => {
    parts.push(
      `<text x="${xCenter(i).toFixed(1)}" y="${priceBase + 14}" text-anchor="middle" class="gcs-chart-tick">${esc(shortGrade(r.grade))}</text>`,
    );
  });

  parts.push("</svg>");
  return parts.join("");
}
