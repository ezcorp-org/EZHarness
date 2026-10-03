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
const contractRequire = createRequire(rootRequire.resolve("@ezcorp/extension-contract"));
const schemaRequire = createRequire(contractRequire.resolve("ts-json-schema-generator"));
const schemaMinimatchRequire = createRequire(schemaRequire.resolve("minimatch"));
const archiverRequire = createRequire(excelRequire.resolve("archiver"));
const readGlobRequire = createRequire(archiverRequire.resolve("readdir-glob"));
const readGlobMinimatchRequire = createRequire(readGlobRequire.resolve("minimatch"));
const archiveUtilsRequire = createRequire(archiverRequire.resolve("archiver-utils"));
const globRequire = createRequire(archiveUtilsRequire.resolve("glob"));
const legacyMinimatchRequire = createRequire(globRequire.resolve("minimatch"));
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

test("AJV resolves fast-uri with consistent percent-encoded host normalization", () => {
  const ajvRequire = createRequire(contractRequire.resolve("ajv"));
  const uri = ajvRequire("fast-uri") as { parse: (value: string) => { host?: string }; equal: (left: string, right: string) => boolean };
  expect(ajvRequire("fast-uri/package.json").version).toBe("3.1.8");
  // 3.1.6 returned A.com and incorrectly reported these hosts as unequal.
  expect(uri.parse("//%41.com").host).toBe("a.com");
  expect(uri.equal("//%41.com", "//a.com")).toBe(true);
});

test("the MCP rate limiter resolves ip-address with corrected IPv6 classification", () => {
  const aiKitRequire = createRequire(rootRequire.resolve("@ezcorp/ai-kit"));
  const mcpRequire = createRequire(aiKitRequire.resolve("@modelcontextprotocol/sdk/server/mcp.js"));
  const rateLimitRequire = createRequire(mcpRequire.resolve("express-rate-limit"));
  const ip = rateLimitRequire("ip-address") as {
    Address4: new (value: string) => { isInSubnet: (other: unknown) => boolean };
    Address6: new (value: string) => { isInSubnet: (other: unknown) => boolean; isLinkLocal: () => boolean };
  };
  expect(rateLimitRequire("ip-address/package.json").version).toBe("10.7.3");
  // 10.4.0 treated the unrelated IPv6 address as inside this IPv4 subnet.
  expect(new ip.Address6("a00::1").isInSubnet(new ip.Address4("10.0.0.0/8"))).toBe(false);
  expect(new ip.Address6("fea0::1").isLinkLocal()).toBe(true);
});

test("schema glob and ExcelJS archiver use bounded brace expansion in each supported major", () => {
  const callers: Array<[ReturnType<typeof createRequire>, string]> = [
    [schemaMinimatchRequire, "5.0.12"],
    [readGlobMinimatchRequire, "2.1.7"],
    [legacyMinimatchRequire, "1.1.21"],
  ];
  const adverse = `{a}${"}".repeat(1000)},z}`;
  for (const [caller, version] of callers) {
    expect(caller("brace-expansion/package.json").version).toBe(version);
    const module = caller("brace-expansion") as ((pattern: string) => string[]) | { expand: (pattern: string) => string[] };
    const expand = typeof module === "function" ? module : module.expand;
    expect(expand("file-{a,b}.txt")).toEqual(["file-a.txt", "file-b.txt"]);
    // Vulnerable 1.1.18, 2.1.4, and 5.0.9 expanded this rewrite chain.
    expect(expand(adverse)).toEqual([adverse]);
  }
});
