// @ts-check
// ZXing wiring — continuous camera decode + still-image decode.
//
// ZXing loads from jsdelivr (the extension data route's CSP allows it).
// If the CDN is unreachable (offline demo) or getUserMedia is blocked
// (plain-HTTP LAN, platform Permissions-Policy), the SPA still works via
// image upload (when ZXing loaded), manual cert entry, and the simulate
// button — camera is an enhancement, not a dependency.

import { buildDecodeVariants } from "./decode-plan.js";

const ZXING_SRC = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";

// White quiet-zone border added around a `quietZone` tile, as a fraction of
// the scaled tile (L/R and T/B). MUST match TILE_PAD_X / TILE_PAD_Y in
// decode-plan.js — that module sizes the tile pass's pixel budget against
// exactly this padding.
const QUIET_PAD_X = 0.12;
const QUIET_PAD_Y = 0.4;

/** @type {Promise<any>|null} */
let zxingLoad = null;

/**
 * Load the ZXing UMD bundle once. Resolves with the global namespace.
 * @returns {Promise<any>}
 */
export function loadZxing() {
  const w = /** @type {any} */ (globalThis);
  if (w.ZXing) return Promise.resolve(w.ZXing);
  if (zxingLoad) return zxingLoad;
  zxingLoad = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = ZXING_SRC;
    s.crossOrigin = "anonymous";
    s.onload = () => (w.ZXing ? resolve(w.ZXing) : reject(new Error("ZXing global missing after load")));
    s.onerror = () => reject(new Error("ZXing failed to load (offline?)"));
    document.head.appendChild(s);
  });
  return zxingLoad;
}

/**
 * The barcode symbologies a PSA slab can carry:
 *   - ITF (Interleaved 2 of 5) — the linear barcode on the FRONT label.
 *   - QR — modern slabs also print a psacard.com/cert QR on the back.
 *   - Code 128 — some third-party/older labels; cheap to keep in the set.
 * @param {any} ZXing @returns {any[]} the POSSIBLE_FORMATS list
 */
function possibleFormats(ZXing) {
  return [ZXing.BarcodeFormat.ITF, ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.QR_CODE];
}

/** @param {any} ZXing @param {boolean} [tryHarder] @returns {Map<any, any>} decode hints */
function decodeHints(ZXing, tryHarder = false) {
  const hints = new Map();
  if (ZXing.DecodeHintType && ZXing.BarcodeFormat) {
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, possibleFormats(ZXing));
    if (tryHarder) hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  }
  return hints;
}

/** @param {any} ZXing @returns {any} continuous camera reader (ITF + Code 128 + QR) */
function makeReader(ZXing) {
  return new ZXing.BrowserMultiFormatReader(decodeHints(ZXing));
}

/**
 * Attempt one decode variant: draw its region to a canvas at its scale and
 * run ZXing's low-level pipeline against it. The low-level
 * MultiFormatReader + HybridBinarizer path is used deliberately — the
 * BrowserMultiFormatReader image helpers re-decode through their own
 * downsampling ladder, which decodes this ITF label only at knife-edge
 * resolutions; decoding the canvas we drew directly is deterministic.
 * @param {any} ZXing
 * @param {ImageBitmap|HTMLImageElement} source
 * @param {import("./decode-plan.js").DecodeVariant} v
 * @returns {string|null} decoded text, or null if this variant found nothing
 */
function tryDecodeVariant(ZXing, source, v) {
  const drawW = Math.max(1, Math.round(v.sw * v.scale));
  const drawH = Math.max(1, Math.round(v.sh * v.scale));
  // A quiet-zone variant is drawn INSET into a larger white canvas so a
  // small barcode gets the clean margin ITF needs to lock on; a plain
  // variant fills the whole canvas edge-to-edge (unchanged behaviour).
  const padX = v.quietZone ? Math.round(drawW * QUIET_PAD_X) : 0;
  const padY = v.quietZone ? Math.round(drawH * QUIET_PAD_Y) : 0;
  const canvas = document.createElement("canvas");
  canvas.width = drawW + 2 * padX;
  canvas.height = drawH + 2 * padY;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (v.quietZone) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, v.sx, v.sy, v.sw, v.sh, padX, padY, drawW, drawH);

  const hints = decodeHints(ZXing, v.tryHarder);
  const reader = new ZXing.MultiFormatReader();
  reader.setHints(hints);
  try {
    const luminance = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance));
    return String(reader.decode(bitmap, hints).getText());
  } catch {
    // NotFoundException for this variant — the caller tries the next one.
    return null;
  } finally {
    reader.reset?.();
  }
}

/**
 * Continuous scanner bound to a <video> element.
 * @param {{videoEl: HTMLVideoElement, onText: (text: string) => void, onError: (err: Error) => void}} opts
 */
export function createScanner({ videoEl, onText, onError }) {
  /** @type {any} */
  let reader = null;
  let running = false;

  return {
    get running() {
      return running;
    },

    /** Start (or restart) the camera + decode loop. */
    async start() {
      try {
        const ZXing = await loadZxing();
        if (!reader) reader = makeReader(ZXing);
        const callback = (/** @type {any} */ result) => {
          // ZXing fires with either a result or a NotFoundException per
          // frame; only results matter here.
          if (result?.getText) onText(String(result.getText()));
        };
        // Prefer the back camera. decodeFromConstraints exists on
        // current builds; fall back to the default device if not.
        if (typeof reader.decodeFromConstraints === "function") {
          await reader.decodeFromConstraints(
            { video: { facingMode: { ideal: "environment" } } },
            videoEl,
            callback,
          );
        } else {
          await reader.decodeFromVideoDevice(undefined, videoEl, callback);
        }
        running = true;
      } catch (err) {
        running = false;
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    },

    /** Stop the decode loop and release the camera. */
    stop() {
      running = false;
      try {
        reader?.reset();
      } catch {
        // releasing an already-released camera is fine
      }
    },

    /**
     * Decode a still image (file upload / native camera capture). Loads the
     * bitmap once, then walks the bounded variant ladder from decode-plan.js
     * — whole frame first, then upscaled horizontal bands — and returns the
     * first success. A thin ITF front-label barcode does not decode from the
     * raw full frame, so the band pass is what makes real PSA photos work.
     * @param {File} file
     * @returns {Promise<string>} decoded text
     */
    async decodeImageFile(file) {
      const ZXing = await loadZxing();
      const bitmap = await createImageBitmap(file);
      try {
        for (const variant of buildDecodeVariants(bitmap.width, bitmap.height)) {
          const text = tryDecodeVariant(ZXing, bitmap, variant);
          if (text !== null) return text;
        }
        throw new Error("No barcode found in image");
      } finally {
        bitmap.close?.();
      }
    },
  };
}
