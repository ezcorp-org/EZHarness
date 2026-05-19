import { test, expect, describe } from "bun:test";
import { extractPdfText } from "../chat/attachments/pdf-extract";

function buildMinimalPdf(text: string): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (s: string) => { const b = enc.encode(s); parts.push(b); pos += b.byteLength; };

  push("%PDF-1.4\n");
  offsets[1] = pos;
  push("1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n");
  offsets[2] = pos;
  push("2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n");
  offsets[3] = pos;
  push("3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>\nendobj\n");
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET\n`;
  offsets[4] = pos;
  push(`4 0 obj\n<</Length ${stream.length}>>\nstream\n${stream}endstream\nendobj\n`);
  offsets[5] = pos;
  push("5 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n");

  const xrefPos = pos;
  push("xref\n0 6\n");
  push("0000000000 65535 f \n");
  for (let i = 1; i <= 5; i++) push(String(offsets[i]).padStart(10, "0") + " 00000 n \n");
  push(`trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`);

  const total = parts.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.byteLength; }
  return out;
}

describe("extractPdfText", () => {
  test("extracts plain text from a minimal valid PDF", async () => {
    const pdf = buildMinimalPdf("Hello PDF world");
    const result = await extractPdfText(pdf);
    expect(result.pages).toBe(1);
    expect(result.text).toContain("Hello PDF world");
  });

  test("rejects garbage bytes that are not a valid PDF", async () => {
    const garbage = new TextEncoder().encode("this is definitely not a pdf");
    let caught: unknown;
    try { await extractPdfText(garbage); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
  });
});
