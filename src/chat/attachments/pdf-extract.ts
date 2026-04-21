/**
 * PDF text extraction using pdf-parse (pdfjs-dist under the hood).
 *
 * Used when delivering a PDF attachment to a model: we extract page-joined
 * text and inline it as a pi-ai TextContent part, since pi-ai has no native
 * PDF content type. Fails closed on password-protected / malformed PDFs.
 */

import { PDFParse } from "pdf-parse";

export interface PdfExtractResult {
  text: string;
  pages: number;
}

export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtractResult> {
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    return { text: result.text, pages: result.total };
  } finally {
    await parser.destroy().catch(() => {});
  }
}
