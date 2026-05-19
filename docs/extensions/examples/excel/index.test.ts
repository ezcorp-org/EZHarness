import { test, expect, describe } from "bun:test";
import { buildHandlers } from "./index";

async function makeWorkbook(): Promise<Uint8Array> {
  const ExcelJS = (await import("exceljs")) as typeof import("exceljs");
  const wb = new ExcelJS.Workbook();
  const sales = wb.addWorksheet("Sales");
  sales.addRow(["Date", "Region", "Amount"]);
  sales.addRow(["2026-01-01", "EMEA", 100]);
  sales.addRow(["2026-01-02", "AMER", 200]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

function dataUri(bytes: Uint8Array, mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

describe("read-spreadsheet handler", () => {
  test("mode=manifest succeeds and returns the sheet name", async () => {
    const handlers = buildHandlers();
    const handler = handlers["read-spreadsheet"]!;
    const bytes = await makeWorkbook();
    const result = await handler({ source: dataUri(bytes), mode: "manifest" });
    expect(result.isError).toBeFalsy();
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Sales");
    expect(text).toContain("Dimensions:");
  });

  test("mode=sheet returns markdown table for the named sheet", async () => {
    const handlers = buildHandlers();
    const handler = handlers["read-spreadsheet"]!;
    const bytes = await makeWorkbook();
    const result = await handler({ source: dataUri(bytes), mode: "sheet", sheet: "Sales" });
    expect(result.isError).toBeFalsy();
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("# Sheet: Sales");
    expect(text).toContain("EMEA");
    expect(text).toContain("AMER");
  });

  test("mode=range scopes output to the A1 window", async () => {
    const handlers = buildHandlers();
    const handler = handlers["read-spreadsheet"]!;
    const bytes = await makeWorkbook();
    const result = await handler({
      source: dataUri(bytes),
      mode: "range",
      sheet: "Sales",
      range: "B1:B3",
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("EMEA");
    expect(text).toContain("AMER");
    expect(text).not.toContain("100");
  });

  test("missing source surfaces toolError", async () => {
    const handlers = buildHandlers();
    const handler = handlers["read-spreadsheet"]!;
    const result = await handler({ mode: "manifest" });
    expect(result.isError).toBe(true);
  });

  test("invalid mode surfaces toolError", async () => {
    const handlers = buildHandlers();
    const handler = handlers["read-spreadsheet"]!;
    const bytes = await makeWorkbook();
    const result = await handler({ source: dataUri(bytes), mode: "wrong" });
    expect(result.isError).toBe(true);
  });

  test("mode=sheet without sheet arg surfaces toolError", async () => {
    const handlers = buildHandlers();
    const handler = handlers["read-spreadsheet"]!;
    const bytes = await makeWorkbook();
    const result = await handler({ source: dataUri(bytes), mode: "sheet" });
    expect(result.isError).toBe(true);
  });

  test("mode=range without range arg surfaces toolError", async () => {
    const handlers = buildHandlers();
    const handler = handlers["read-spreadsheet"]!;
    const bytes = await makeWorkbook();
    const result = await handler({ source: dataUri(bytes), mode: "range", sheet: "Sales" });
    expect(result.isError).toBe(true);
  });

  test("non-data-URI source surfaces toolError", async () => {
    const handlers = buildHandlers();
    const handler = handlers["read-spreadsheet"]!;
    const result = await handler({ source: "ez-attachment://abc", mode: "manifest" });
    expect(result.isError).toBe(true);
  });

  test("garbage bytes surface toolError with code", async () => {
    const handlers = buildHandlers();
    const handler = handlers["read-spreadsheet"]!;
    const bytes = new TextEncoder().encode("not a workbook");
    const result = await handler({ source: dataUri(bytes), mode: "manifest" });
    expect(result.isError).toBe(true);
  });
});
