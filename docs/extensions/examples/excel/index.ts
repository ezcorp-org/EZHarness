#!/usr/bin/env bun
// excel — read .xlsx workbooks attached to chat. Operates on attachment
// handles substituted by the host runtime; never opens disk paths.
// See ./README.md for the user-facing story.

import {
  createToolDispatcher,
  getChannel,
  toolError,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import {
  decodeDataUri,
  parseWorkbook,
  renderManifest,
  renderRange,
  renderSheet,
  XlsxParseError,
} from "./parser";

interface ReadSpreadsheetArgs {
  source?: unknown;
  mode?: unknown;
  sheet?: unknown;
  range?: unknown;
  maxRows?: unknown;
  filename?: unknown; // optional display name forwarded to renderManifest
}

export const makeReadSpreadsheetHandler = (): ToolHandler => async (rawArgs) => {
  const args = rawArgs as ReadSpreadsheetArgs;
  const { source, mode } = args;
  if (typeof source !== "string" || source.length === 0) {
    return toolError("`source` is required and must be the attachment handle.");
  }
  if (mode !== "manifest" && mode !== "sheet" && mode !== "range") {
    return toolError("`mode` must be one of: manifest, sheet, range.");
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeDataUri(source);
  } catch (err) {
    if (err instanceof XlsxParseError) return toolError(err.message, err.code);
    return toolError(`Failed to decode source: ${(err as Error).message}`);
  }

  let wb;
  try {
    wb = await parseWorkbook(bytes);
  } catch (err) {
    if (err instanceof XlsxParseError) return toolError(err.message, err.code);
    return toolError(`Workbook parse failed: ${(err as Error).message}`);
  }

  const filename = typeof args.filename === "string" ? args.filename : undefined;
  const maxRows = typeof args.maxRows === "number" ? args.maxRows : undefined;

  try {
    if (mode === "manifest") return toolResult(renderManifest(wb, filename));
    if (mode === "sheet") {
      if (typeof args.sheet !== "string" || args.sheet.length === 0) {
        return toolError("`sheet` is required for mode=sheet.");
      }
      return toolResult(renderSheet(wb, args.sheet, maxRows));
    }
    // mode === "range"
    if (typeof args.sheet !== "string" || args.sheet.length === 0) {
      return toolError("`sheet` is required for mode=range.");
    }
    if (typeof args.range !== "string" || args.range.length === 0) {
      return toolError("`range` is required for mode=range (e.g. 'A1:F100').");
    }
    return toolResult(renderRange(wb, args.sheet, args.range, maxRows));
  } catch (err) {
    if (err instanceof XlsxParseError) return toolError(err.message, err.code);
    return toolError(`Render failed: ${(err as Error).message}`);
  }
};

export function buildHandlers(): Record<string, ToolHandler> {
  return { "read-spreadsheet": makeReadSpreadsheetHandler() };
}

export function start(): void {
  const ch = getChannel();
  createToolDispatcher(buildHandlers());
  ch.start();
}

if (import.meta.main) start();
