// @ts-check
import * as ZXing from "@zxing/library";
import { buildDecodeVariants } from "./decode-plan.js";
import { canvasBridge } from "./bridge.js";

// White quiet-zone border added around a `quietZone` tile, as a fraction of
// the scaled tile (L/R and T/B). MUST match TILE_PAD_X / TILE_PAD_Y in
// decode-plan.js — that module sizes the tile pass's pixel budget against
// exactly this padding.
const QUIET_PAD_X = 0.12;
const QUIET_PAD_Y = 0.4;

export function loadZxing() { return Promise.resolve(ZXing); }

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
 * Continuous scanner uses frames from the trusted host camera.
 * @param {{videoEl: HTMLImageElement, onText: (text: string) => void, onError: (err: Error) => void, bridge?:ReturnType<typeof canvasBridge>}} opts
 */
export function createScanner({ videoEl, onText, onError, bridge = canvasBridge() }) {
  let running = false;
  let opening = false;
  let decoding = false;
  let generation = 0;
  /** @type {string|null} */
  let sessionId = null;

  const decode = async (/** @type {Blob} */ file) => {
    if (file.size > 10 * 1024 * 1024) throw new Error("Image exceeds 10 MiB.");
    const bitmap = await createImageBitmap(file);
    try {
      if (bitmap.width * bitmap.height > 24_000_000) throw new Error("Image resolution exceeds 24 megapixels.");
      for (const variant of buildDecodeVariants(bitmap.width, bitmap.height)) {
        const text = tryDecodeVariant(ZXing, bitmap, variant);
        if (text !== null) return text;
      }
      throw new Error("No barcode found in image");
    } finally { bitmap.close(); }
  };

  const unsubscribe = bridge.subscribeCamera(async event => {
    if (!sessionId || event.sessionId !== sessionId) return;
    if (event.type === "ezcorp.canvas.camera-stopped") {
      running = false;
      sessionId = null;
      videoEl.removeAttribute("src");
      onError(new Error(typeof event.reason === "string" ? event.reason : "Camera stopped."));
      return;
    }
    if (!running || decoding || typeof event.dataUrl !== "string" || event.dataUrl.length > 700_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(event.dataUrl)) return;
    videoEl.src = event.dataUrl;
    decoding = true;
    try {
      const bytes = Uint8Array.from(atob(event.dataUrl.slice(event.dataUrl.indexOf(",") + 1)), character => character.charCodeAt(0));
      const text = await decode(new Blob([bytes], { type: "image/jpeg" }));
      if (running && event.sessionId === sessionId) onText(text);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "No barcode found in image") onError(error instanceof Error ? error : new Error(String(error)));
    } finally { decoding = false; }
  });

  const stop = () => {
    generation += 1;
    running = false;
    opening = false;
    videoEl.removeAttribute("src");
    const previous = sessionId;
    sessionId = null;
    if (previous) void bridge.request("camera.stop", { sessionId: previous }).catch(error => onError(error));
  };

  return {
    get running() { return running; },
    async start() {
      if (running || opening) return;
      opening = true;
      const requested = ++generation;
      try {
        const result = await bridge.request("camera.start", {});
        if (typeof result?.sessionId !== "string" || result.sessionId.length > 128) throw new Error("Invalid camera session.");
        if (requested !== generation) {
          await bridge.request("camera.stop", { sessionId: result.sessionId });
          return;
        }
        sessionId = result.sessionId;
        running = true;
      } catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
      finally { opening = false; }
    },
    stop,
    dispose() { stop(); unsubscribe(); },
    decodeImageFile: decode,
  };
}
