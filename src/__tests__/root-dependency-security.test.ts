import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Resolve from each real caller. A clean root lockfile is not enough if an old
// nested copy remains available to the package that actually requires it.
const rootRequire = createRequire(import.meta.url);
const drizzleRequire = createRequire(rootRequire.resolve("drizzle-kit"));
const loaderRequire = createRequire(drizzleRequire.resolve("@esbuild-kit/esm-loader"));
const coreRequire = createRequire(loaderRequire.resolve("@esbuild-kit/core-utils"));
const excelRequire = createRequire(rootRequire.resolve("exceljs"));
type EsbuildApi = {
  version: string;
  context: (options: {
    entryPoints: string[];
    outdir: string;
    bundle: boolean;
  }) => Promise<{ serve: (options: { host: string; port: number; servedir: string }) => Promise<{ port: number }>; dispose: () => Promise<void> }>;
};

test("Drizzle's legacy TypeScript loader resolves patched esbuild and still transforms TypeScript", () => {
  const esbuild = coreRequire("esbuild") as EsbuildApi;
  const core = loaderRequire("@esbuild-kit/core-utils") as {
    transformSync: (source: string, fileName: string) => { code: string };
  };
  expect(esbuild.version).toBe("0.28.1");
  expect((drizzleRequire("esbuild") as Pick<EsbuildApi, "version">).version).toBe(esbuild.version);
  const transformed = core.transformSync("export const answer: number = 42;", "config.ts");
  expect(transformed.code).toMatch(/const answer\s*=\s*42/);
});

test("the esbuild server used by Drizzle's loader does not expose wildcard CORS", async () => {
  const esbuild = coreRequire("esbuild") as EsbuildApi;
  const dir = mkdtempSync(join(tmpdir(), "ez-esbuild-cors-"));
  const entry = join(dir, "app.js");
  writeFileSync(entry, "console.log('ready')");
  let context: Awaited<ReturnType<EsbuildApi["context"]>> | undefined;
  try {
    context = await esbuild.context({ entryPoints: [entry], outdir: join(dir, "out"), bundle: true });
    const server = await context.serve({ host: "127.0.0.1", port: 0, servedir: join(dir, "out") });
    const response = await fetch(`http://127.0.0.1:${server.port}/app.js`, {
      headers: { Origin: "https://untrusted.example" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("console.log");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  } finally {
    try {
      await context?.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("ExcelJS resolves a patched UUID with bounds checks and keeps its v4 caller working", () => {
  const uuid = excelRequire("uuid") as { v5: (name: string, namespace: string, buffer: Uint8Array, offset: number) => unknown };
  expect(() => uuid.v5("name", "6ba7b810-9dad-11d1-80b4-00c04fd430c8", new Uint8Array(8), 0)).toThrow(RangeError);

  const CfRuleExtXform = excelRequire("exceljs/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform") as
    new () => { prepare: (rule: { type: string; iconSet: string; x14Id?: string }) => void };
  const rule: { type: string; iconSet: string; x14Id?: string } = { type: "iconSet", iconSet: "3Triangles" };
  new CfRuleExtXform().prepare(rule);
  expect(rule.x14Id).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/);
});

test("ExcelJS writes and reads a workbook through its patched UUID dependency", async () => {
  const ExcelJS = excelRequire("exceljs") as typeof import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Report");
  worksheet.getCell("A1").value = 42;
  worksheet.addConditionalFormatting({
    ref: "A1:A1",
    rules: [{ type: "iconSet", priority: 1, iconSet: "3Triangles", cfvo: [{ type: "percent", value: 0 }, { type: "percent", value: 50 }, { type: "percent", value: 100 }] }],
  });
  const bytes = await workbook.xlsx.writeBuffer();
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  const restoredSheet = restored.getWorksheet("Report");
  if (!restoredSheet) throw new Error("ExcelJS did not restore the worksheet");
  expect(restoredSheet.getCell("A1").value).toBe(42);
  expect((restoredSheet.model as { conditionalFormattings?: unknown[] }).conditionalFormattings).toHaveLength(1);
});
