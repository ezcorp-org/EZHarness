/**
 * ExcelJS-backed reader for Excel (.xlsx) workbooks attached to chat.
 *
 * Three render modes — `manifest`, `sheet`, `range` — all produce
 * markdown-table output (LLM table-QA accuracy is materially better on
 * markdown tables vs. CSV per published evals). Defensive defaults:
 * hidden sheets are skipped, formulas surface their cached results,
 * dates are emitted as ISO 8601, merged cells forward-fill the master
 * value, and trailing empty rows/columns are trimmed.
 *
 * Output is double-capped: per-sheet row count (default 1000, max 5000)
 * and total markdown size (256 KB). Either trip emits an HTML comment
 * marker so the LLM can see truncation happened and call again with a
 * narrower range or a higher cap.
 *
 * Per-sheet column-count fallback: tables with more than 50 columns
 * degrade markdown alignment to the point of unreadability, so they
 * render as a fenced CSV block instead.
 */

import type * as ExcelJS from "exceljs";

export const MAX_OUTPUT_BYTES = 256 * 1024;
export const DEFAULT_MAX_ROWS = 1000;
export const ABSOLUTE_MAX_ROWS = 5000;
const MARKDOWN_COLUMN_THRESHOLD = 50;

type ExcelJSModule = typeof import("exceljs");
let cachedModule: ExcelJSModule | undefined;
async function loadExcelJS(): Promise<ExcelJSModule> {
  if (!cachedModule) cachedModule = (await import("exceljs")) as unknown as ExcelJSModule;
  return cachedModule;
}

export class XlsxParseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "XlsxParseError";
  }
}

/**
 * Decode an `ez-attachment://` handle that the host runtime has already
 * substituted to a `data:<mime>;base64,<bytes>` URI. The parser doesn't
 * verify the MIME type — that gate happens at upload time via the
 * core validator's magic-byte sniff.
 */
export function decodeDataUri(input: string): Uint8Array {
  if (!input.startsWith("data:")) {
    throw new XlsxParseError(
      "BAD_SOURCE",
      "Expected a `data:` URI (the runtime should substitute attachment handles before this tool runs)",
    );
  }
  const comma = input.indexOf(",");
  if (comma < 0) throw new XlsxParseError("BAD_SOURCE", "Malformed data URI: no payload");
  const meta = input.slice(5, comma);
  const payload = input.slice(comma + 1);
  if (!meta.includes(";base64")) {
    throw new XlsxParseError("BAD_SOURCE", "data URI must be base64-encoded");
  }
  return Uint8Array.from(Buffer.from(payload, "base64"));
}

export async function parseWorkbook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const ExcelJSPkg = await loadExcelJS();
  const wb = new ExcelJSPkg.Workbook();
  try {
    // ExcelJS expects an ArrayBuffer; build one from the Uint8Array slice.
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await wb.xlsx.load(ab as ArrayBuffer);
  } catch (err) {
    throw new XlsxParseError("UNREADABLE", `Failed to parse workbook: ${(err as Error).message}`);
  }
  rejectExternalReferences(wb);
  return wb;
}

function rejectExternalReferences(wb: ExcelJS.Workbook): void {
  // External references can leak data via Excel's link-update mechanism
  // and are an exfiltration vector. Refuse to operate on workbooks that
  // declare any.
  const model = (wb as unknown as { model?: { externalReferences?: unknown[] } }).model;
  const refs = model?.externalReferences;
  if (Array.isArray(refs) && refs.length > 0) {
    throw new XlsxParseError(
      "EXTERNAL_REFERENCES",
      `Workbook contains ${refs.length} external reference(s); refusing to load.`,
    );
  }
}

interface VisibleSheet {
  ws: ExcelJS.Worksheet;
  rowCount: number;
  colCount: number;
}

function visibleSheets(wb: ExcelJS.Workbook): VisibleSheet[] {
  const out: VisibleSheet[] = [];
  wb.eachSheet((ws) => {
    if (ws.state !== "visible") return;
    const rowCount = ws.actualRowCount ?? ws.rowCount ?? 0;
    const colCount = ws.actualColumnCount ?? ws.columnCount ?? 0;
    out.push({ ws, rowCount, colCount });
  });
  return out;
}

/**
 * Coerce one cell to its display string. Forward-fill the master value
 * for merged children, prefer cached formula results over formula text,
 * and emit dates as ISO 8601.
 */
function cellToString(cell: ExcelJS.Cell): string {
  // Merged children carry no value of their own — read the master.
  if (cell.isMerged && cell.master && cell.master !== cell) {
    return cellToString(cell.master);
  }
  const v = cell.value;
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return v;

  // Formula cell: prefer cached result, fall back to formula text.
  const formulaResult = (v as { result?: unknown }).result;
  if (formulaResult !== undefined) {
    if (formulaResult instanceof Date) return formulaResult.toISOString();
    if (typeof formulaResult === "object" && formulaResult !== null && "error" in formulaResult) {
      return `#${(formulaResult as { error: string }).error}`;
    }
    return String(formulaResult);
  }
  if ((v as { formula?: string }).formula !== undefined) {
    return `=${(v as { formula: string }).formula}`;
  }
  // Rich text: concatenate runs.
  if ((v as { richText?: Array<{ text: string }> }).richText) {
    return ((v as { richText: Array<{ text: string }> }).richText)
      .map((r) => r.text)
      .join("");
  }
  // Hyperlink cell: prefer the visible text.
  if ((v as { text?: string }).text !== undefined) return (v as { text: string }).text;
  return "";
}

interface ExtractedSheet {
  name: string;
  rows: string[][]; // [row][col] — already trimmed + capped
  totalRows: number; // actualRowCount in source workbook
  totalCols: number;
  truncatedRows: boolean;
}

function extractSheet(
  ws: ExcelJS.Worksheet,
  rowLimit: number,
  rowOffset = 1,
  rowEnd?: number,
  colStart = 1,
  colEnd?: number,
): ExtractedSheet {
  const totalRows = ws.actualRowCount ?? ws.rowCount ?? 0;
  const totalCols = ws.actualColumnCount ?? ws.columnCount ?? 0;
  const lastRow = Math.min(rowEnd ?? totalRows, totalRows);
  const lastCol = Math.min(colEnd ?? totalCols, totalCols);
  const rows: string[][] = [];
  let truncatedRows = false;

  for (let r = rowOffset; r <= lastRow; r++) {
    if (rows.length >= rowLimit) {
      truncatedRows = true;
      break;
    }
    const row = ws.getRow(r);
    const cells: string[] = [];
    let lastNonEmpty = -1;
    for (let c = colStart; c <= lastCol; c++) {
      const s = cellToString(row.getCell(c));
      cells.push(s);
      if (s !== "") lastNonEmpty = c - colStart;
    }
    // Trim trailing empties only when colEnd is open (manifest/sheet mode);
    // for explicit ranges keep every column.
    if (colEnd === undefined) {
      cells.length = lastNonEmpty < 0 ? 0 : lastNonEmpty + 1;
    }
    if (cells.length === 0 && colEnd === undefined) continue;
    rows.push(cells);
  }

  return {
    name: ws.name,
    rows,
    totalRows,
    totalCols,
    truncatedRows,
  };
}

function renderTable(rows: string[][]): string {
  if (rows.length === 0) return "_(empty)_";
  const colCount = rows.reduce((n, r) => Math.max(n, r.length), 0);
  if (colCount === 0) return "_(empty)_";
  if (colCount > MARKDOWN_COLUMN_THRESHOLD) {
    return ["```csv", ...rows.map((r) => r.map(escapeCsv).join(",")), "```"].join("\n");
  }
  const norm = rows.map((r) => {
    const out = r.slice();
    while (out.length < colCount) out.push("");
    return out.map(escapeCell);
  });
  const header = norm[0]!;
  const sep = header.map(() => "---");
  const body = norm.slice(1);
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ];
  return lines.join("\n");
}

function escapeCell(s: string): string {
  // Markdown table cells: escape pipes and collapse newlines so the
  // table doesn't break across rows.
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function escapeCsv(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function clampRowLimit(maxRows: number | undefined): number {
  if (typeof maxRows !== "number" || !Number.isFinite(maxRows)) return DEFAULT_MAX_ROWS;
  const n = Math.floor(maxRows);
  if (n < 1) return 1;
  if (n > ABSOLUTE_MAX_ROWS) return ABSOLUTE_MAX_ROWS;
  return n;
}

function applyByteCap(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= MAX_OUTPUT_BYTES) return s;
  // Truncate by repeatedly dropping the last 5% until under cap. Cheap
  // and good enough — we never serve precise-cut output.
  let out = s;
  while (Buffer.byteLength(out, "utf8") > MAX_OUTPUT_BYTES) {
    out = out.slice(0, Math.floor(out.length * 0.95));
  }
  return `${out}\n\n<!-- truncated: output exceeded ${MAX_OUTPUT_BYTES.toLocaleString()} byte cap -->`;
}

// ── Render: manifest ────────────────────────────────────────────────

export function renderManifest(wb: ExcelJS.Workbook, filename?: string): string {
  const sheets = visibleSheets(wb);
  if (sheets.length === 0) {
    return `# Workbook${filename ? `: ${filename}` : ""}\n\n_(no visible sheets)_`;
  }
  const blocks: string[] = [];
  blocks.push(`# Workbook${filename ? `: ${filename}` : ""}`);
  for (const { ws, rowCount, colCount } of sheets) {
    const sample = extractSheet(ws, 5);
    let block = `\n## Sheet: ${ws.name}\n`;
    block += `- Dimensions: ${rowCount} rows × ${colCount} columns\n`;
    if (sample.rows.length > 0) {
      block += `- Sample (first ${sample.rows.length} rows):\n\n${renderTable(sample.rows)}`;
    } else {
      block += `- _(empty)_`;
    }
    blocks.push(block);
  }
  return applyByteCap(blocks.join("\n"));
}

// ── Render: full sheet ──────────────────────────────────────────────

export function renderSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  maxRows: number | undefined,
): string {
  const ws = findVisibleSheet(wb, sheetName);
  const limit = clampRowLimit(maxRows);
  const extracted = extractSheet(ws, limit);
  let body = `# Sheet: ${ws.name}\n\n${renderTable(extracted.rows)}`;
  if (extracted.truncatedRows) {
    body += `\n\n<!-- truncated: shown ${extracted.rows.length} of ${extracted.totalRows} rows; raise maxRows or query a narrower range -->`;
  }
  return applyByteCap(body);
}

// ── Render: A1 range ────────────────────────────────────────────────

interface ParsedRange {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

const A1_RANGE = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i;

export function parseA1Range(rangeText: string): ParsedRange {
  const m = A1_RANGE.exec(rangeText.trim());
  if (!m) {
    throw new XlsxParseError(
      "BAD_RANGE",
      `Range must be A1:B2 form (got "${rangeText}"). Single cells and full-column refs are not supported.`,
    );
  }
  const [, c1, r1, c2, r2] = m;
  return {
    rowStart: Math.min(Number(r1), Number(r2)),
    rowEnd: Math.max(Number(r1), Number(r2)),
    colStart: Math.min(colLetterToNumber(c1!), colLetterToNumber(c2!)),
    colEnd: Math.max(colLetterToNumber(c1!), colLetterToNumber(c2!)),
  };
}

function colLetterToNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - "A".charCodeAt(0) + 1);
  }
  return n;
}

export function renderRange(
  wb: ExcelJS.Workbook,
  sheetName: string,
  rangeText: string,
  maxRows: number | undefined,
): string {
  const ws = findVisibleSheet(wb, sheetName);
  const range = parseA1Range(rangeText);
  const limit = clampRowLimit(maxRows);
  const extracted = extractSheet(ws, limit, range.rowStart, range.rowEnd, range.colStart, range.colEnd);
  let body = `# Sheet: ${ws.name} (range ${rangeText.toUpperCase()})\n\n${renderTable(extracted.rows)}`;
  if (extracted.truncatedRows) {
    body += `\n\n<!-- truncated: range exceeds maxRows=${limit}; rerun with a smaller window -->`;
  }
  return applyByteCap(body);
}

function findVisibleSheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const ws = wb.getWorksheet(name);
  if (!ws) {
    throw new XlsxParseError("NO_SUCH_SHEET", `Sheet "${name}" not found in workbook.`);
  }
  if (ws.state !== "visible") {
    throw new XlsxParseError("HIDDEN_SHEET", `Sheet "${name}" is hidden; refusing to read.`);
  }
  return ws;
}
