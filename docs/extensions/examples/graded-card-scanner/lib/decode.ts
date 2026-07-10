// ── decode.ts — host-side still-image barcode decode ────────────────
//
// Port of the phone app's proven decode strategy (app/lib/scanner.js)
// for the extension SUBPROCESS: no DOM, no canvas, no CDN. Pixels come
// from pngjs / jpeg-js; region extraction + scaling + quiet-zone padding
// are done over raw RGBA buffers; ZXing's low-level MultiFormatReader +
// HybridBinarizer pipeline decodes each attempt.
//
// The attempt LADDER is the app's — imported from
// app/lib/decode-plan.js (shared geometry, verified against real PSA
// slabs; certs 99075778 + 88127107): whole frame (± TRY_HARDER), three
// upscaled horizontal bands, then a fine quiet-zone-padded tile grid.
// The low-level reader path is deliberate: the Browser* helpers re-decode
// through their own downsampling ladder, which decodes thin ITF labels
// only at knife-edge resolutions; decoding the exact pixels we drew is
// deterministic.
//
// Formats: ITF (PSA front label), QR (modern slab backs — PSA/CGC URL
// payloads), Code 128 (older/third-party labels).

import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from "@zxing/library";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { buildDecodeVariants } from "../app/lib/decode-plan.js";

/** One region-attempt from the shared ladder (app/lib/decode-plan.js). */
export interface DecodeVariant {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  scale: number;
  tryHarder: boolean;
  quietZone: boolean;
}

/** Decoded raster: tightly-packed RGBA bytes. */
export interface RgbaImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

// White quiet-zone border added around a `quietZone` tile, as a fraction
// of the scaled tile (L/R and T/B). MUST match TILE_PAD_X / TILE_PAD_Y in
// decode-plan.js — that module sizes the tile pass's pixel budget against
// exactly this padding (same constants as app/lib/scanner.js).
export const QUIET_PAD_X = 0.12;
export const QUIET_PAD_Y = 0.4;

/** Decode PNG/JPEG bytes into an RGBA raster. Throws on other MIMEs. */
export function decodeImageBytes(bytes: Uint8Array, mimeType: string): RgbaImage {
  const mime = mimeType.toLowerCase();
  if (mime === "image/png") {
    const png = PNG.sync.read(Buffer.from(bytes));
    return { data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
  }
  if (mime === "image/jpeg" || mime === "image/jpg") {
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    return { data: decoded.data, width: decoded.width, height: decoded.height };
  }
  throw new Error(`unsupported image MIME "${mimeType}" — expected image/png or image/jpeg`);
}

/**
 * Extract one variant's region as a LUMINANCE plane: nearest-neighbor
 * scale to `variant.scale`, optionally inset into a white quiet-zone
 * border. Luma uses ZXing's own green-favouring average ((r+2g+b)/4) so
 * the binarizer sees the same distribution it was tuned for.
 */
export function extractLuminance(
  img: RgbaImage,
  variant: DecodeVariant,
): { luma: Uint8ClampedArray; width: number; height: number } {
  const drawW = Math.max(1, Math.round(variant.sw * variant.scale));
  const drawH = Math.max(1, Math.round(variant.sh * variant.scale));
  const padX = variant.quietZone ? Math.round(drawW * QUIET_PAD_X) : 0;
  const padY = variant.quietZone ? Math.round(drawH * QUIET_PAD_Y) : 0;
  const width = drawW + 2 * padX;
  const height = drawH + 2 * padY;
  // White canvas — the pad ring stays 255 (the clean margin ITF needs).
  const luma = new Uint8ClampedArray(width * height).fill(255);

  for (let y = 0; y < drawH; y++) {
    // Ratio mapping (center-of-pixel) handles up- AND down-scaling.
    const srcY = clampInt(variant.sy + ((y + 0.5) * variant.sh) / drawH, 0, img.height - 1);
    const outRow = (y + padY) * width + padX;
    const srcRow = srcY * img.width;
    for (let x = 0; x < drawW; x++) {
      const srcX = clampInt(variant.sx + ((x + 0.5) * variant.sw) / drawW, 0, img.width - 1);
      const p = (srcRow + srcX) * 4;
      const r = img.data[p]!;
      const g = img.data[p + 1]!;
      const b = img.data[p + 2]!;
      luma[outRow + x] = (r + 2 * g + b) >> 2;
    }
  }
  return { luma, width, height };
}

function clampInt(v: number, min: number, max: number): number {
  const i = Math.floor(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function decodeHints(tryHarder: boolean): Map<DecodeHintType, unknown> {
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.ITF,
    BarcodeFormat.CODE_128,
    BarcodeFormat.QR_CODE,
  ]);
  if (tryHarder) hints.set(DecodeHintType.TRY_HARDER, true);
  return hints;
}

/**
 * Attempt one decode variant against the raster. Returns the decoded
 * text, or null when this variant found nothing (NotFoundException —
 * the caller tries the next rung of the ladder).
 */
export function tryDecodeVariant(img: RgbaImage, variant: DecodeVariant): string | null {
  const { luma, width, height } = extractLuminance(img, variant);
  const hints = decodeHints(variant.tryHarder);
  const reader = new MultiFormatReader();
  try {
    const source = new RGBLuminanceSource(luma, width, height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    return String(reader.decode(bitmap, hints).getText());
  } catch {
    return null;
  } finally {
    reader.reset();
  }
}

/** Walk the shared ladder over a raster; first success wins. */
export function decodeSlabPixels(img: RgbaImage): string | null {
  for (const variant of buildDecodeVariants(img.width, img.height)) {
    const text = tryDecodeVariant(img, variant);
    if (text !== null) return text;
  }
  return null;
}

/**
 * Decode a slab photo's bytes: raster-decode (png/jpeg) then walk the
 * ladder. Returns null when no barcode/QR was found anywhere; throws
 * only for undecodable bytes / unsupported MIME.
 */
export function decodeSlabImage(bytes: Uint8Array, mimeType: string): string | null {
  return decodeSlabPixels(decodeImageBytes(bytes, mimeType));
}
