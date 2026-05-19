/**
 * PDF text extraction using pdf-parse (pdfjs-dist under the hood).
 *
 * Used when delivering a PDF attachment to a model: we extract page-joined
 * text and inline it as a pi-ai TextContent part, since pi-ai has no native
 * PDF content type. Fails closed on password-protected / malformed PDFs.
 */

interface PdfExtractResult {
  text: string;
  pages: number;
}

// pdfjs-dist runs `new DOMMatrix()` (and uses ImageData / Path2D for canvas
// render paths) at module top level. The bun:1-slim base has none of those
// browser globals, so without stubs the static import crashes at module
// init — taking down whatever module statically imports us. We only ever
// call `getText()`, which operates on text streams and never paints to a
// canvas, so no-op classes are safe; their methods would only be invoked
// on the rendering path, which we don't take. Idempotent: only fills slots
// that are still missing.
function ensurePdfjsGlobals(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") {
    g.DOMMatrix = class DOMMatrix {
      constructor(_init?: unknown) { /* no-op stub */ }
    };
  }
  if (typeof g.ImageData === "undefined") {
    g.ImageData = class ImageData {
      constructor(_w?: unknown, _h?: unknown) { /* no-op stub */ }
    };
  }
  if (typeof g.Path2D === "undefined") {
    g.Path2D = class Path2D {
      constructor(_path?: unknown) { /* no-op stub */ }
    };
  }
}

export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtractResult> {
  ensurePdfjsGlobals();
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    return { text: result.text, pages: result.total };
  } finally {
    await parser.destroy().catch(() => {});
  }
}
