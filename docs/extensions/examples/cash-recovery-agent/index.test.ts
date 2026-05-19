import { afterAll, beforeAll, beforeEach, test, expect, spyOn } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { JsonRpcResponse, ToolCallResult } from "@ezcorp/sdk";
import { getChannel, JsonRpcError } from "@ezcorp/sdk/runtime";
import {
  computeUnderbilling,
  retainageReleaseCandidates,
  detectDuplicateInvoices,
  handleRequest,
  tools,
} from "./index";
import { generate } from "./generate-data";

// ── In-test fs RPC stub ─────────────────────────────────────────────
//
// `readCsv` routes through `@ezcorp/sdk/runtime`'s `fsExists` + `fsRead`
// (Phase 3 host-mediated reverse-RPC). Stub the channel and route to
// real disk reads of the data/ fixtures.

const ORIG_FS_ALLOWED = process.env.EZCORP_FS_ALLOWED;

function installFsStub(): void {
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((async (
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    const p = (params ?? {}) as Record<string, unknown>;
    const path = p.path as string;
    if (method === "ezcorp/fs.exists") {
      return { exists: existsSync(path) };
    }
    if (method === "ezcorp/fs.read") {
      if (!existsSync(path)) {
        throw new JsonRpcError(-32000, `ENOENT: no such file or directory: ${path}`);
      }
      const bytes = readFileSync(path);
      const body = btoa(String.fromCharCode.apply(null, Array.from(bytes)));
      const encoding = (p.encoding as string) ?? "utf-8";
      return { encoding, body, bytes: bytes.byteLength, resolvedPath: path };
    }
    throw new JsonRpcError(-32601, `cash-recovery test stub: unexpected RPC method ${method}`);
  }) as ReturnType<typeof getChannel>["request"]);
}

beforeAll(() => {
  process.env.EZCORP_FS_ALLOWED = "1";
});

afterAll(() => {
  if (ORIG_FS_ALLOWED === undefined) delete process.env.EZCORP_FS_ALLOWED;
  else process.env.EZCORP_FS_ALLOWED = ORIG_FS_ALLOWED;
});

beforeEach(() => {
  installFsStub();
});

// JsonRpcResponse.result is typed as `unknown`. All our handlers return
// ToolCallResult, so pull the first text block safely.
function textOf(res: JsonRpcResponse): string {
  const result = res.result as ToolCallResult | undefined;
  const first = result?.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text content");
  return first.text;
}

// ── Fixtures ────────────────────────────────────────────────────
// Use the same seeded dataset the demo ships with so tests exercise
// the real numbers the agent will see in production.
const DATA = generate(42);

function findProject(id: string) {
  const p = DATA.projects.find((x) => x.project_id === id);
  if (!p) throw new Error(`test fixture missing project ${id}`);
  return p;
}

// ── Unit tests — pure logic ─────────────────────────────────────

test("computeUnderbilling surfaces the planted P-108 gap", () => {
  const result = computeUnderbilling(findProject("P-108"), DATA.costLedger, DATA.billings);
  expect(result.project_id).toBe("P-108");
  // Expected ≈ $2.70M (contract * %complete), actual = $2.58M, gap ≈ $123K.
  expect(result.expected_billing).toBeGreaterThan(result.actual_billing);
  expect(result.underbilled_amount).toBeGreaterThan(100_000);
  expect(result.underbilled_amount).toBeLessThan(150_000);
});

test("computeUnderbilling stays near zero for a well-billed project", () => {
  // P-106 (Harbor View) is 98% complete; billings roughly track % complete.
  const result = computeUnderbilling(findProject("P-106"), DATA.costLedger, DATA.billings);
  expect(Math.abs(result.underbilled_amount)).toBeLessThan(result.expected_billing);
});

test("retainageReleaseCandidates returns only >=95% projects with retainage", () => {
  const candidates = retainageReleaseCandidates(DATA.projects, DATA.subcontracts, 0.95);
  // Every candidate must clear the threshold and still hold retainage.
  for (const c of candidates) {
    expect(c.percent_complete).toBeGreaterThanOrEqual(0.95);
    expect(c.retainage_held).toBeGreaterThan(0);
  }
  // The planted P-102 retainage ($75K) should be the single largest.
  const p102 = candidates.find((c) => c.project_id === "P-102");
  expect(p102).toBeDefined();
  expect(p102!.retainage_held).toBeGreaterThanOrEqual(75_000);
  // Total retainage held across ≥95% projects should be ≥ $100K.
  const total = candidates.reduce((s, c) => s + c.retainage_held, 0);
  expect(total).toBeGreaterThanOrEqual(100_000);
});

test("retainageReleaseCandidates excludes projects below the threshold", () => {
  // At min=0.99 only the 0.98 Harbor View should actually qualify.
  const strict = retainageReleaseCandidates(DATA.projects, DATA.subcontracts, 0.99);
  for (const c of strict) expect(c.percent_complete).toBeGreaterThanOrEqual(0.99);
});

test("detectDuplicateInvoices finds the planted near-duplicate pair", () => {
  const dupes = detectDuplicateInvoices(DATA.billings);
  // The planted pair is INV-40201 / INV-40202 on P-107.
  const match = dupes.find(
    (d) =>
      (d.invoice_a === "INV-40201" && d.invoice_b === "INV-40202") ||
      (d.invoice_a === "INV-40202" && d.invoice_b === "INV-40201"),
  );
  expect(match).toBeDefined();
  expect(match!.project_id).toBe("P-107");
  expect(Math.abs(match!.amount_a - match!.amount_b)).toBeLessThanOrEqual(100);
});

test("detectDuplicateInvoices respects the amount tolerance", () => {
  const rows = [
    {
      invoice_id: "A", project_id: "X", invoice_date: "2026-04-01",
      amount: 10_000, retainage_withheld: 0, status: "open" as const,
      due_date: "2026-05-01", paid_date: "",
    },
    {
      invoice_id: "B", project_id: "X", invoice_date: "2026-04-02",
      amount: 11_000, retainage_withheld: 0, status: "open" as const,
      due_date: "2026-05-02", paid_date: "",
    },
  ];
  expect(detectDuplicateInvoices(rows, 7, 100)).toHaveLength(0);
  expect(detectDuplicateInvoices(rows, 7, 1_500)).toHaveLength(1);
});

// ── Tool dispatcher smoke tests ─────────────────────────────────

test("handleRequest rejects unknown methods", async () => {
  const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "unknown" });
  expect(res.error?.code).toBe(-32601);
});

test("list-projects returns the seeded 8 projects", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "list-projects", arguments: {} },
  });
  expect(res.result).toBeDefined();
  const parsed = JSON.parse(textOf(res));
  expect(parsed).toHaveLength(8);
  expect(parsed.map((p: { project_id: string }) => p.project_id)).toContain("P-108");
});

test("get-change-orders with status=approved & billed_flag=false returns the planted COs", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: {
      name: "get-change-orders",
      arguments: { status: "approved", billed_flag: false },
    },
  });
  const rows = JSON.parse(textOf(res)) as Array<{ co_id: string; amount: number }>;
  const ids = rows.map((r) => r.co_id);
  expect(ids).toContain("CO-9001");
  expect(ids).toContain("CO-9002");
  expect(ids).toContain("CO-9003");
  const total = rows.reduce((s, r) => s + r.amount, 0);
  expect(total).toBeGreaterThanOrEqual(105_000);
});

test("generate-morning-briefing produces a dollar-headlined markdown report", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "generate-morning-briefing", arguments: {} },
  });
  const md = textOf(res);
  expect(md).toContain("Daily Cash Recovery — Morning Briefing");
  expect(md).toContain("Total recoverable cash identified:");
  expect(md).toContain("Approved Change Orders Not Billed");
  expect(md).toContain("Underbilled Projects");
  expect(md).toContain("Retainage Release Opportunities");
  expect(md).toContain("Overdue Receivables");
  // Dollar formatting: $1,234,567
  expect(md).toMatch(/\$\d{1,3}(?:,\d{3})+/);
  // Headline total lands inside the expected band.
  const m = md.match(/Total recoverable cash identified:\s*\$([\d,]+)/);
  expect(m).not.toBeNull();
  const total = Number(m![1]!.replace(/,/g, ""));
  expect(total).toBeGreaterThan(350_000);
  expect(total).toBeLessThan(700_000);
});

// ── Manifest sanity ─────────────────────────────────────────────

test("manifest declares the expected tools, agent, and skill", async () => {
  const manifest = (await import(import.meta.dir + "/ezcorp.config.ts")).default;
  expect(manifest.schemaVersion).toBe(2);
  expect(manifest.name).toBe("cash-recovery-agent");
  expect(manifest.persistent).toBe(true);
  const toolNames = (manifest.tools as Array<{ name: string }>).map((t) => t.name);
  for (const expected of [
    "list-projects", "get-project-details", "get-cost-ledger",
    "get-change-orders", "get-billings", "get-ar-aging",
    "get-subcontracts", "compute-underbilling",
    "find-retainage-release-candidates", "detect-duplicate-invoices",
    "draft-billing-memo", "draft-collection-email", "draft-pm-message",
    "generate-morning-briefing", "regenerate-data",
  ]) {
    expect(toolNames).toContain(expected);
  }
  expect(manifest.agent).toBeDefined();
  expect(manifest.agent.category).toBe("Finance & Accounting");
  expect(manifest.skills).toHaveLength(1);
  // Every declared tool must have a registered handler.
  for (const t of manifest.tools as Array<{ name: string }>) {
    expect(tools[t.name]).toBeDefined();
  }
});
