// Shared IN-TEST barcode/image generators — DETERMINISTIC + OFFLINE.
// ITF is rendered by a hand-rolled Interleaved-2-of-5 renderer (a simple
// narrow/wide bar code), QR via @zxing/library's own QRCodeWriter — so
// no fixture binaries and no network. Used by lib/decode.test.ts (the
// decode-ladder unit suite) and __tests__/identify-composition.test.ts
// (the real end-to-end pipeline composition test). Test-only helper —
// not product code.

import { BarcodeFormat, EncodeHintType, QRCodeWriter } from "@zxing/library";
import jpeg from "jpeg-js";
import { encode as encodePng } from "fast-png";
import type { RgbaImage } from "../../lib/decode";

/** ITF digit patterns (n = narrow, w = wide) — standard Interleaved 2 of 5. */
const ITF_DIGITS: Record<string, string> = {
  "0": "nnwwn",
  "1": "wnnnw",
  "2": "nwnnw",
  "3": "wwnnn",
  "4": "nnwnw",
  "5": "wnwnn",
  "6": "nwwnn",
  "7": "nnnww",
  "8": "wnnwn",
  "9": "nwnwn",
};

/** Render an ITF barcode (even digit count) as an RGBA raster with quiet margins. */
export function renderItfRgba(digits: string, unitPx = 3, heightPx = 80, quietUnits = 12): RgbaImage {
  if (digits.length % 2 !== 0) throw new Error("ITF needs an even digit count");
  const NARROW = 1;
  const WIDE = 3;
  const seq: Array<{ bar: boolean; units: number }> = [
    // start: narrow bar/space/bar/space
    { bar: true, units: NARROW },
    { bar: false, units: NARROW },
    { bar: true, units: NARROW },
    { bar: false, units: NARROW },
  ];
  for (let i = 0; i < digits.length; i += 2) {
    const bars = ITF_DIGITS[digits[i]!]!;
    const spaces = ITF_DIGITS[digits[i + 1]!]!;
    for (let j = 0; j < 5; j++) {
      seq.push({ bar: true, units: bars[j] === "w" ? WIDE : NARROW });
      seq.push({ bar: false, units: spaces[j] === "w" ? WIDE : NARROW });
    }
  }
  // stop: wide bar, narrow space, narrow bar
  seq.push({ bar: true, units: WIDE }, { bar: false, units: NARROW }, { bar: true, units: NARROW });

  const totalUnits = seq.reduce((a, s) => a + s.units, 0) + 2 * quietUnits;
  const width = totalUnits * unitPx;
  const data = new Uint8Array(width * heightPx * 4).fill(255);
  let xUnits = quietUnits;
  for (const s of seq) {
    if (s.bar) {
      const x0 = xUnits * unitPx;
      const x1 = (xUnits + s.units) * unitPx;
      for (let y = 0; y < heightPx; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * width + x) * 4;
          data[p] = 0;
          data[p + 1] = 0;
          data[p + 2] = 0;
        }
      }
    }
    xUnits += s.units;
  }
  return { data, width, height: heightPx };
}

/** Render a QR code for `contents` as an RGBA raster (zxing's own writer). */
export function renderQrRgba(contents: string, size = 240): RgbaImage {
  const hints = new Map<EncodeHintType, unknown>();
  hints.set(EncodeHintType.MARGIN, 4);
  const matrix = new QRCodeWriter().encode(
    contents,
    BarcodeFormat.QR_CODE,
    size,
    size,
    hints as never,
  );
  const w = matrix.getWidth();
  const h = matrix.getHeight();
  const data = new Uint8Array(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (matrix.get(x, y)) {
        const p = (y * w + x) * 4;
        data[p] = 0;
        data[p + 1] = 0;
        data[p + 2] = 0;
      }
    }
  }
  return { data, width: w, height: h };
}

export function rgbaToPng(img: RgbaImage): Uint8Array {
  // fast-png (pure JS, no `fs`) — mirrors the runtime decoder swap in
  // lib/decode.ts; pngjs pulls node:fs which the extension sandbox poisons.
  return encodePng({ width: img.width, height: img.height, data: img.data, channels: 4 });
}

export function rgbaToJpeg(img: RgbaImage, quality = 95): Uint8Array {
  const out = jpeg.encode(
    { data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), width: img.width, height: img.height },
    quality,
  );
  return new Uint8Array(out.data);
}

export function blankImage(width = 200, height = 150): RgbaImage {
  return { data: new Uint8Array(width * height * 4).fill(255), width, height };
}
