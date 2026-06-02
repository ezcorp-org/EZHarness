import { afterAll, beforeAll, beforeEach, test, expect, spyOn } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { JsonRpcResponse, ToolCallResult } from "@ezcorp/sdk";
import { getChannel, JsonRpcError } from "@ezcorp/sdk/runtime";
import { handleRequest, loadTimecards, tools } from "./index";
import { generate } from "./generate-data";

// ── In-test fs RPC stub ─────────────────────────────────────────────
//
// Mirrors index.test.ts's stub but also captures `fs.write` + `fs.mkdir`
// in memory so the `regenerate-data` tool can be exercised end-to-end
// without clobbering the shipped data/ fixtures on disk. Reads still go
// to the real fixtures so every other handler sees production numbers.

const ORIG_FS_ALLOWED = process.env.EZCORP_FS_ALLOWED;
let writes: Map<string, string>;

function installFsStub(): void {
  writes = new Map();
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
    if (method === "ezcorp/fs.mkdir") {
      return { ok: true };
    }
    if (method === "ezcorp/fs.write") {
      const content = p.content as string;
      writes.set(path, content);
      return { bytes: content.length, resolvedPath: path };
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

// JsonRpcResponse.result is typed as `unknown`. All handlers return
// ToolCallResult, so pull the first text block safely.
function textOf(res: JsonRpcResponse): string {
  const result = res.result as ToolCallResult | undefined;
  const first = result?.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text content");
  return first.text;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
  return handleRequest({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args },
  });
}

const DATA = generate(42);

// ── loadTimecards (exported, otherwise unused by built-in tools) ─────

test("loadTimecards parses the seeded timecard fixtures", async () => {
  const rows = await loadTimecards();
  expect(rows.length).toBeGreaterThan(0);
  const r = rows[0]!;
  expect(typeof r.hours).toBe("number");
  expect(typeof r.approved_flag).toBe("boolean");
  expect(r.project_id).toMatch(/^P-\d+/);
});

// ── get-project-details ─────────────────────────────────────────────

test("get-project-details returns the requested project", async () => {
  const res = await call("get-project-details", { project_id: "P-101" });
  const p = JSON.parse(textOf(res));
  expect(p.project_id).toBe("P-101");
  expect(p.name).toBe("Riverside Medical Center");
});

test("get-project-details errors when project_id is missing", async () => {
  const res = await call("get-project-details", {});
  expect(res.error?.code).toBe(-32602);
  expect(res.error?.message).toBe("project_id required");
});

test("get-project-details errors when project is not found", async () => {
  const res = await call("get-project-details", { project_id: "P-999" });
  expect(res.error?.code).toBe(-32602);
  expect(res.error?.message).toBe("Project P-999 not found");
});

// ── get-cost-ledger ─────────────────────────────────────────────────

test("get-cost-ledger returns all rows with no filters", async () => {
  const res = await call("get-cost-ledger", {});
  const rows = JSON.parse(textOf(res)) as Array<{ project_id: string }>;
  expect(rows.length).toBeGreaterThan(0);
});

test("get-cost-ledger filters by project_id and a date window", async () => {
  const res = await call("get-cost-ledger", {
    project_id: "P-101", start_date: "2026-01-01", end_date: "2026-12-31",
  });
  const rows = JSON.parse(textOf(res)) as Array<{ project_id: string; date: string }>;
  for (const r of rows) {
    expect(r.project_id).toBe("P-101");
    expect(r.date >= "2026-01-01").toBe(true);
    expect(r.date <= "2026-12-31").toBe(true);
  }
  // A start_date in the far future filters everything out.
  const empty = await call("get-cost-ledger", { start_date: "2099-01-01" });
  expect(JSON.parse(textOf(empty))).toHaveLength(0);
});

// ── get-change-orders status-only filter ────────────────────────────

test("get-change-orders filters by project_id alone", async () => {
  const res = await call("get-change-orders", { project_id: "P-108" });
  const rows = JSON.parse(textOf(res)) as Array<{ project_id: string }>;
  for (const r of rows) expect(r.project_id).toBe("P-108");
});

// ── get-billings ────────────────────────────────────────────────────

test("get-billings returns all rows with no filters", async () => {
  const res = await call("get-billings", {});
  expect((JSON.parse(textOf(res)) as unknown[]).length).toBeGreaterThan(0);
});

test("get-billings filters by project_id and status", async () => {
  const res = await call("get-billings", { project_id: "P-101", status: "paid" });
  const rows = JSON.parse(textOf(res)) as Array<{ project_id: string; status: string }>;
  for (const r of rows) {
    expect(r.project_id).toBe("P-101");
    expect(r.status).toBe("paid");
  }
});

// ── get-ar-aging ────────────────────────────────────────────────────

test("get-ar-aging returns rows sorted by amount descending", async () => {
  const res = await call("get-ar-aging", {});
  const rows = JSON.parse(textOf(res)) as Array<{ amount: number }>;
  expect(rows.length).toBeGreaterThan(0);
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i - 1]!.amount).toBeGreaterThanOrEqual(rows[i]!.amount);
  }
});

test("get-ar-aging filters by min_days and min_amount", async () => {
  const res = await call("get-ar-aging", { min_days: 90, min_amount: 1 });
  const rows = JSON.parse(textOf(res)) as Array<{ days_outstanding: number; amount: number }>;
  for (const r of rows) {
    expect(r.days_outstanding).toBeGreaterThanOrEqual(90);
    expect(r.amount).toBeGreaterThanOrEqual(1);
  }
});

// ── get-subcontracts ────────────────────────────────────────────────

test("get-subcontracts returns all rows with no filter", async () => {
  const res = await call("get-subcontracts", {});
  expect((JSON.parse(textOf(res)) as unknown[]).length).toBeGreaterThan(0);
});

test("get-subcontracts filters by project_id", async () => {
  const res = await call("get-subcontracts", { project_id: "P-102" });
  const rows = JSON.parse(textOf(res)) as Array<{ project_id: string }>;
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) expect(r.project_id).toBe("P-102");
});

// ── compute-underbilling ────────────────────────────────────────────

test("compute-underbilling returns the gap for a known project", async () => {
  const res = await call("compute-underbilling", { project_id: "P-108" });
  const u = JSON.parse(textOf(res));
  expect(u.project_id).toBe("P-108");
  expect(u.underbilled_amount).toBeGreaterThan(0);
});

test("compute-underbilling errors without project_id", async () => {
  const res = await call("compute-underbilling", {});
  expect(res.error?.message).toBe("project_id required");
});

test("compute-underbilling errors for an unknown project", async () => {
  const res = await call("compute-underbilling", { project_id: "P-999" });
  expect(res.error?.message).toBe("Project P-999 not found");
});

// ── find-retainage-release-candidates ───────────────────────────────

test("find-retainage-release-candidates honors a custom threshold", async () => {
  const res = await call("find-retainage-release-candidates", { min_percent_complete: 0.5 });
  const rows = JSON.parse(textOf(res)) as Array<{ percent_complete: number }>;
  for (const r of rows) expect(r.percent_complete).toBeGreaterThanOrEqual(0.5);
});

test("find-retainage-release-candidates defaults the threshold to 0.95", async () => {
  const res = await call("find-retainage-release-candidates", {});
  const rows = JSON.parse(textOf(res)) as Array<{ percent_complete: number }>;
  for (const r of rows) expect(r.percent_complete).toBeGreaterThanOrEqual(0.95);
});

// ── detect-duplicate-invoices ───────────────────────────────────────

test("detect-duplicate-invoices surfaces the planted pair", async () => {
  const res = await call("detect-duplicate-invoices", {});
  const rows = JSON.parse(textOf(res)) as Array<{ invoice_a: string; invoice_b: string }>;
  const ids = rows.flatMap((r) => [r.invoice_a, r.invoice_b]);
  expect(ids).toContain("INV-40201");
  expect(ids).toContain("INV-40202");
});

// ── draft-billing-memo ──────────────────────────────────────────────

test("draft-billing-memo renders a memo with a dollar total", async () => {
  const res = await call("draft-billing-memo", {
    project_id: "P-101",
    items: [
      { description: "CO-1: extra steel", amount: 12_000 },
      { description: "CO-2: rework", amount: 3_500 },
    ],
  });
  const md = textOf(res);
  expect(md).toContain("# Billing Memo — Riverside Medical Center (P-101)");
  expect(md).toContain("Maya Chen");
  expect(md).toContain("$15,500");
});

test("draft-billing-memo errors when project_id or items are missing", async () => {
  const res = await call("draft-billing-memo", { project_id: "P-101" });
  expect(res.error?.message).toBe("project_id and items required");
});

test("draft-billing-memo errors for an unknown project", async () => {
  const res = await call("draft-billing-memo", { project_id: "P-999", items: [] });
  expect(res.error?.message).toBe("Project P-999 not found");
});

// ── draft-collection-email ──────────────────────────────────────────

test("draft-collection-email renders aged invoices and a slug subject", async () => {
  const res = await call("draft-collection-email", {
    customer: "Acme Health System",
    invoices: [
      { invoice_id: "INV-1", amount: 50_000, days_outstanding: 95 },
      { invoice_id: "INV-2", amount: 20_000, days_outstanding: 40 },
    ],
  });
  const md = textOf(res);
  expect(md).toContain("Collection Follow-up");
  expect(md).toContain("ap@acmehealthsystem.example");
  expect(md).toContain("$70,000");
  // maxDays >= 90 triggers the "materially aged" clause.
  expect(md).toContain("materially aged");
});

test("draft-collection-email omits the materially-aged clause under 90 days", async () => {
  const res = await call("draft-collection-email", {
    customer: "Beta Corp",
    invoices: [{ invoice_id: "INV-3", amount: 1_000, days_outstanding: 30 }],
  });
  expect(textOf(res)).not.toContain("materially aged");
});

test("draft-collection-email errors when customer or invoices are missing", async () => {
  const res = await call("draft-collection-email", { customer: "Acme" });
  expect(res.error?.message).toBe("customer and invoices required");
});

// ── draft-pm-message ────────────────────────────────────────────────

test("draft-pm-message renders the issue and recommended action", async () => {
  const res = await call("draft-pm-message", {
    project_id: "P-101",
    issue: "Underbilled by $120K against % complete.",
    recommended_action: "Get the next pay app out this week.",
  });
  const md = textOf(res);
  expect(md).toContain("Maya Chen");
  expect(md).toContain("Underbilled by $120K");
  expect(md).toContain("Get the next pay app out this week.");
});

test("draft-pm-message errors when a required field is missing", async () => {
  const res = await call("draft-pm-message", { project_id: "P-101", issue: "x" });
  expect(res.error?.message).toBe("project_id, issue, recommended_action required");
});

test("draft-pm-message errors for an unknown project", async () => {
  const res = await call("draft-pm-message", {
    project_id: "P-999", issue: "x", recommended_action: "y",
  });
  expect(res.error?.message).toBe("Project P-999 not found");
});

// ── regenerate-data ─────────────────────────────────────────────────

test("regenerate-data writes the dataset with the default seed", async () => {
  const res = await call("regenerate-data", {});
  const out = JSON.parse(textOf(res));
  expect(out.seed).toBe(42);
  expect(out.rowCount).toBeDefined();
  expect(out.planted.duplicatePair).toEqual(["INV-40201", "INV-40202"]);
  // Seven CSVs written through the captured fs.write stub (none to real disk).
  expect(writes.size).toBe(7);
});

test("regenerate-data honors a custom seed", async () => {
  const res = await call("regenerate-data", { seed: 7 });
  const out = JSON.parse(textOf(res));
  expect(out.seed).toBe(7);
});

// ── handleRequest error branches ────────────────────────────────────

test("handleRequest rejects unknown tools", async () => {
  const res = await call("does-not-exist");
  expect(res.error?.code).toBe(-32601);
  expect(res.error?.message).toContain("Unknown tool");
});

test("handleRequest maps a thrown JsonRpcError to a JSON-RPC error", async () => {
  const res = await call("get-cost-ledger");
  // Default read succeeds; now force a missing-file JsonRpcError by
  // pointing readCsv at a non-existent fixture via a fresh stub.
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((async (method: string) => {
    if (method === "ezcorp/fs.exists") return { exists: false };
    throw new JsonRpcError(-32601, "unexpected");
  }) as ReturnType<typeof getChannel>["request"]);
  const missing = await call("list-projects");
  expect(missing.error?.code).toBe(-32000);
  expect(missing.error?.message).toContain("Missing data file");
  expect(res.result).toBeDefined();
});

test("handleRequest maps a non-JsonRpcError throw to code -32000", async () => {
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((async () => {
    throw new Error("boom");
  }) as ReturnType<typeof getChannel>["request"]);
  const res = await call("list-projects");
  expect(res.error?.code).toBe(-32000);
  expect(res.error?.message).toBe("boom");
});

// ── generate-morning-briefing — "no duplicates" branch ──────────────

test("generate-morning-briefing reports no anomalies when none exist", async () => {
  // Serve fixtures normally, except billings.csv, which we replace with a
  // header-only CSV so detectDuplicateInvoices yields an empty set.
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((async (method: string, params: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const path = p.path as string;
    if (method === "ezcorp/fs.exists") return { exists: existsSync(path) };
    if (method === "ezcorp/fs.read") {
      let text: string;
      if (path.endsWith("billings.csv")) {
        text = "invoice_id,project_id,invoice_date,amount,retainage_withheld,status,due_date,paid_date\n";
      } else {
        text = readFileSync(path, "utf-8");
      }
      const bytes = new TextEncoder().encode(text);
      const body = btoa(String.fromCharCode.apply(null, Array.from(bytes)));
      return { encoding: "utf-8", body, bytes: bytes.byteLength, resolvedPath: path };
    }
    throw new JsonRpcError(-32601, `unexpected ${method}`);
  }) as ReturnType<typeof getChannel>["request"]);
  const res = await call("generate-morning-briefing");
  expect(textOf(res)).toContain("_None detected._");
});

// ── parseCsv quoting branches via a hand-crafted fixture ────────────

test("parseCsv handles quoted fields with embedded commas and escaped quotes", async () => {
  const csv =
    'project_id,name,customer,contract_value,start_date,end_date,percent_complete,status,pm_name,pm_email\n' +
    'P-201,"North, Tower","He said ""hi""",1000,2026-01-01,2026-02-01,0.5,active,"A, B",a@x.example\n';
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((async (method: string, params: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const path = p.path as string;
    if (method === "ezcorp/fs.exists") return { exists: true };
    if (method === "ezcorp/fs.read") {
      const bytes = new TextEncoder().encode(path.endsWith("projects.csv") ? csv : "");
      const body = btoa(String.fromCharCode.apply(null, Array.from(bytes)));
      return { encoding: "utf-8", body, bytes: bytes.byteLength, resolvedPath: path };
    }
    throw new JsonRpcError(-32601, `unexpected ${method}`);
  }) as ReturnType<typeof getChannel>["request"]);
  const res = await call("get-project-details", { project_id: "P-201" });
  const proj = JSON.parse(textOf(res));
  expect(proj.name).toBe("North, Tower");
  expect(proj.customer).toBe('He said "hi"');
  expect(proj.pm_name).toBe("A, B");
});

// Silence the unused-import lint by asserting the seeded fixture is real.
test("seeded fixture exposes the expected eight projects", () => {
  expect(DATA.projects).toHaveLength(8);
  expect(tools["list-projects"]).toBeDefined();
});
