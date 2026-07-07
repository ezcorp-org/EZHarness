// @ts-check
// Pure decode geometry — the bounded variant ladder still-image decoding
// walks. No DOM, no ZXing: given the source pixel dimensions it returns an
// ordered list of regions to draw + attempt, and scanner.js does the
// drawing/decoding.
//
// Why a ladder (verified against two real PSA slabs — certs 99075778 and
// 88127107):
//   - PSA front labels are ITF (Interleaved 2 of 5), a THIN linear barcode.
//   - Decoding the full ~1200×1600 frame directly never succeeds, and
//     TRY_HARDER on a full-resolution frame can wedge the renderer.
//   - Some slabs (99075778) decode from a WIDE band that happens to present
//     a clean-enough scan line. Others (88127107) have a SMALL barcode
//     buried in label text with no clean quiet zone in any wide band; those
//     only decode from a FINE tile that isolates the barcode and surrounds
//     it with a white quiet-zone border (added by scanner.js).
// So the ladder is the UNION, attempted in order, first success wins:
//   1–2. whole frame (downscaled ≤ MAX_LONG_SIDE), without then with TRY_HARDER
//   3–5. three overlapping horizontal bands upscaled toward ×3 (budget-capped)
//   6+.  a fine overlapping tile grid, each tile `quietZone`-padded

const MAX_LONG_SIDE = 1200; // full-frame variants never exceed this on the long side
const PIXEL_BUDGET = 2_500_000; // no drawn band canvas exceeds this — keeps TRY_HARDER off huge frames
const MAX_UPSCALE = 3; // a band is never magnified beyond ×3
const BAND_OVERLAP = 0.15; // neighbouring bands share ~15% so a barcode on a seam is whole in one

const TILE_W_FRAC = 0.34; // tile width as a fraction of the frame
const TILE_H_FRAC = 0.12; // tile height as a fraction of the frame
const TILE_SHORT_TARGET = 700; // upscale each tile so its short side lands near this
const TILE_MIN_SCALE = 2; // tiles are always magnified at least ×2…
const TILE_MAX_SCALE = 6; // …and at most ×6
const TILE_PAD_X = 0.12; // quiet-zone pad added by scanner.js — L/R, as a fraction of the scaled tile
const TILE_PAD_Y = 0.4; // quiet-zone pad added by scanner.js — T/B, as a fraction of the scaled tile
const TILE_PADDED_BUDGET = 2_500_000; // skip the whole tile pass if a padded tile would exceed this
const MAX_TILES = 80; // hard cap on tiles so worst-case latency stays bounded

/**
 * @typedef {object} DecodeVariant
 * @property {number} sx source-x of the region to draw (px)
 * @property {number} sy source-y of the region to draw (px)
 * @property {number} sw source width of the region (px)
 * @property {number} sh source height of the region (px)
 * @property {number} scale factor to multiply the region by when drawing (≥1 upscales)
 * @property {boolean} tryHarder pass ZXing's TRY_HARDER hint for this attempt
 * @property {boolean} quietZone draw onto a larger white canvas so the region has a quiet border
 */

/**
 * Origin coordinates for a 1-D scan of overlapping windows: `step`-spaced
 * starts that keep each `tile`-wide window inside `span`, plus a final
 * window flush to the far edge so nothing near the edge is missed.
 * @param {number} step @param {number} span @param {number} tile
 * @returns {number[]}
 */
function tileOrigins(step, span, tile) {
  const out = [];
  for (let p = 0; p + tile < span; p += step) out.push(p);
  out.push(Math.max(0, span - tile)); // final window flush to the edge
  return [...new Set(out)];
}

/**
 * Build the ordered decode-attempt ladder for a source of the given size.
 * @param {number} width source pixel width
 * @param {number} height source pixel height
 * @returns {DecodeVariant[]} ordered variants (empty for a non-positive size)
 */
export function buildDecodeVariants(width, height) {
  if (!(width > 0) || !(height > 0)) return [];

  // 1–2: the whole frame, downscaled so the long side ≤ MAX_LONG_SIDE (never
  // upscaled here). First without, then with TRY_HARDER — a crisp QR or an
  // already-tight capture decodes cheaply before we start banding.
  const longest = Math.max(width, height);
  const fullScale = longest > MAX_LONG_SIDE ? MAX_LONG_SIDE / longest : 1;
  /** @type {DecodeVariant[]} */
  const variants = [
    { sx: 0, sy: 0, sw: width, sh: height, scale: fullScale, tryHarder: false, quietZone: false },
    { sx: 0, sy: 0, sw: width, sh: height, scale: fullScale, tryHarder: true, quietZone: false },
  ];

  // 3–5: three overlapping horizontal bands (vertical thirds, each grown by
  // BAND_OVERLAP into its neighbours) upscaled toward ×3 but capped so the
  // drawn canvas stays within PIXEL_BUDGET.
  const third = height / 3;
  const overlap = third * BAND_OVERLAP;
  const bands = [
    { sy: 0, sh: third + overlap },
    { sy: third - overlap, sh: third + 2 * overlap },
    { sy: 2 * third - overlap, sh: third + overlap },
  ];
  for (const band of bands) {
    const sy = Math.min(height - 1, Math.max(0, Math.floor(band.sy)));
    const sh = Math.max(1, Math.min(height - sy, Math.round(band.sh)));
    const budgetScale = Math.sqrt(PIXEL_BUDGET / (width * sh));
    const scale = Math.max(1, Math.min(MAX_UPSCALE, budgetScale));
    variants.push({ sx: 0, sy, sw: width, sh, scale, tryHarder: true, quietZone: false });
  }

  // 6+: a fine overlapping tile grid, each tile upscaled and quiet-zone
  // padded by scanner.js so a SMALL barcode buried in label text gets a
  // clean white border to decode against. The 50%-overlap grid is inherently
  // bounded (~80 tiles for any in-budget frame — see MAX_TILES), so no
  // step-coarsening is needed; the padded-pixel guard drops the whole pass
  // for a frame so large a padded tile would blow the budget.
  const tileW = Math.max(1, Math.round(TILE_W_FRAC * width));
  const tileH = Math.max(1, Math.round(TILE_H_FRAC * height));
  const tileScale = Math.max(TILE_MIN_SCALE, Math.min(TILE_MAX_SCALE, TILE_SHORT_TARGET / Math.min(tileW, tileH)));
  const scaledW = Math.round(tileW * tileScale);
  const scaledH = Math.round(tileH * tileScale);
  const paddedPx =
    (scaledW + 2 * Math.round(scaledW * TILE_PAD_X)) * (scaledH + 2 * Math.round(scaledH * TILE_PAD_Y));
  if (paddedPx <= TILE_PADDED_BUDGET) {
    const stepX = Math.max(1, Math.round(tileW / 2));
    const stepY = Math.max(1, Math.round(tileH / 2));
    /** @type {DecodeVariant[]} */
    const tiles = [];
    for (const sy of tileOrigins(stepY, height, tileH)) {
      for (const sx of tileOrigins(stepX, width, tileW)) {
        const sw = Math.min(tileW, width - sx);
        const sh = Math.min(tileH, height - sy);
        tiles.push({ sx, sy, sw, sh, scale: tileScale, tryHarder: true, quietZone: true });
      }
    }
    for (const tile of tiles.slice(0, MAX_TILES)) variants.push(tile);
  }
  return variants;
}
