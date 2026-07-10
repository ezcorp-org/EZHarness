// Unit tests for the host-side decode module. DETERMINISTIC + OFFLINE:
// barcode images are GENERATED in-test — ITF via a hand-rolled renderer
// (Interleaved 2 of 5 is a simple narrow/wide bar code), QR via
// @zxing/library's own QRCodeWriter — so no fixture binaries and no
// network. Both the PNG and JPEG raster paths are exercised. The
// generators live in __tests__/helpers/barcode-render.ts (shared with
// the identify-composition suite).

import { describe, expect, test } from "bun:test";
import {
  blankImage,
  renderItfRgba,
  renderQrRgba,
  rgbaToJpeg,
  rgbaToPng,
} from "../__tests__/helpers/barcode-render";
import {
  QUIET_PAD_X,
  QUIET_PAD_Y,
  decodeImageBytes,
  decodeSlabImage,
  decodeSlabPixels,
  extractLuminance,
  tryDecodeVariant,
  type DecodeVariant,
} from "./decode";

// ── decodeImageBytes ────────────────────────────────────────────────

describe("decodeImageBytes", () => {
  test("PNG bytes → RGBA raster with the source dimensions", () => {
    const src = renderItfRgba("49392223");
    const img = decodeImageBytes(rgbaToPng(src), "image/png");
    expect(img.width).toBe(src.width);
    expect(img.height).toBe(src.height);
    expect(img.data.length).toBe(src.width * src.height * 4);
  });

  test("JPEG bytes → RGBA raster (both image/jpeg and image/jpg)", () => {
    const src = renderQrRgba("test");
    const bytes = rgbaToJpeg(src);
    const a = decodeImageBytes(bytes, "image/jpeg");
    expect(a.width).toBe(src.width);
    const b = decodeImageBytes(bytes, "IMAGE/JPG");
    expect(b.height).toBe(src.height);
  });

  test("unsupported MIME throws (caller error, not a silent null)", () => {
    expect(() => decodeImageBytes(new Uint8Array([1, 2, 3]), "application/pdf")).toThrow(
      "unsupported image MIME",
    );
  });
});

// ── extractLuminance ────────────────────────────────────────────────

describe("extractLuminance", () => {
  const img = renderItfRgba("49392223");
  const full: DecodeVariant = {
    sx: 0,
    sy: 0,
    sw: img.width,
    sh: img.height,
    scale: 1,
    tryHarder: false,
    quietZone: false,
  };

  test("scale 1, no pad: output matches the source dimensions with black/white luma", () => {
    const { luma, width, height } = extractLuminance(img, full);
    expect(width).toBe(img.width);
    expect(height).toBe(img.height);
    // Quiet margin (left edge) is white; a known bar pixel is black.
    expect(luma[0]).toBe(255);
    const values = new Set(Array.from(luma));
    expect(values.has(0)).toBe(true);
    expect(values.has(255)).toBe(true);
  });

  test("quietZone pads a white ring of the shared TILE_PAD fractions", () => {
    const v: DecodeVariant = { ...full, scale: 2, quietZone: true };
    const drawW = Math.round(img.width * 2);
    const drawH = Math.round(img.height * 2);
    const padX = Math.round(drawW * QUIET_PAD_X);
    const padY = Math.round(drawH * QUIET_PAD_Y);
    const { luma, width, height } = extractLuminance(img, v);
    expect(width).toBe(drawW + 2 * padX);
    expect(height).toBe(drawH + 2 * padY);
    // Every pixel in the top pad ring stays white.
    for (let x = 0; x < width; x += 7) {
      expect(luma[x]).toBe(255);
    }
  });

  test("downscale (scale < 1) keeps the plane within bounds", () => {
    const v: DecodeVariant = { ...full, scale: 0.5 };
    const { width, height, luma } = extractLuminance(img, v);
    expect(width).toBe(Math.max(1, Math.round(img.width * 0.5)));
    expect(height).toBe(Math.max(1, Math.round(img.height * 0.5)));
    expect(luma.length).toBe(width * height);
  });
});

// ── decode ladder ───────────────────────────────────────────────────

describe("tryDecodeVariant", () => {
  const img = renderItfRgba("49392223");

  test("decodes a clean full-frame ITF variant", () => {
    const v: DecodeVariant = {
      sx: 0,
      sy: 0,
      sw: img.width,
      sh: img.height,
      scale: 1,
      tryHarder: false,
      quietZone: false,
    };
    expect(tryDecodeVariant(img, v)).toBe("49392223");
  });

  test("decodes through the quiet-zone padded path too", () => {
    const v: DecodeVariant = {
      sx: 0,
      sy: 0,
      sw: img.width,
      sh: img.height,
      scale: 2,
      tryHarder: true,
      quietZone: true,
    };
    expect(tryDecodeVariant(img, v)).toBe("49392223");
  });

  test("returns null on a barcode-free region (NotFoundException path)", () => {
    const blank = blankImage(64, 48);
    const v: DecodeVariant = {
      sx: 0,
      sy: 0,
      sw: 64,
      sh: 48,
      scale: 1,
      tryHarder: false,
      quietZone: false,
    };
    expect(tryDecodeVariant(blank, v)).toBeNull();
  });
});

describe("decodeSlabPixels / decodeSlabImage", () => {
  test("ITF PNG (PSA front-label symbology) decodes to the cert digits", () => {
    const bytes = rgbaToPng(renderItfRgba("49392223"));
    expect(decodeSlabImage(bytes, "image/png")).toBe("49392223");
  });

  test("QR JPEG (modern slab back) decodes to the psacard URL payload", () => {
    const url = "https://www.psacard.com/cert/12345678";
    const bytes = rgbaToJpeg(renderQrRgba(url));
    expect(decodeSlabImage(bytes, "image/jpeg")).toBe(url);
  });

  test("an image with no barcode walks the FULL ladder and returns null", () => {
    // Small frame keeps the tile pass cheap; every rung must miss.
    expect(decodeSlabPixels(blankImage())).toBeNull();
  });

  test("undecodable mime propagates as a throw (tool layer maps to toolError)", () => {
    expect(() => decodeSlabImage(new Uint8Array([0]), "text/plain")).toThrow();
  });
});
