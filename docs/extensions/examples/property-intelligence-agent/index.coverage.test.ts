import { afterAll, afterEach, beforeAll, beforeEach, test, expect, spyOn } from "bun:test";
import type { JsonRpcResponse, ToolCallResult } from "@ezcorp/sdk";
import { getChannel, JsonRpcError } from "@ezcorp/sdk/runtime";
import { handleRequest } from "./index";
import { generate } from "./generate-data";

// ── Programmable in-memory fs RPC stub ──────────────────────────────
//
// The shared `index.test.ts` stub routes `ezcorp/fs.{exists,read}` to the
// real `data/` fixtures on disk. These per-tool coverage tests need to drive
// the *empty* and *single-property* branches that the seeded fixtures never
// hit (e.g. "no leases on file", a property whose only tenant is in default),
// plus the write-side of `regenerate-data`. So this stub serves CSV bodies
// from an in-memory map keyed by basename and records writes/mkdirs, letting
// each test install its own dataset.

type CsvMap = Record<string, string>;

const ORIG_FS_ALLOWED = process.env.EZCORP_FS_ALLOWED;

let files: CsvMap = {};
let writes: Array<{ path: string; content: string }> = [];
let mkdirs: string[] = [];
// When set, the read stub throws this for the matching basename (covers the
// generic-error catch branch in handleRequest where a handler rejects with a
// non-JsonRpcError).
let throwOnRead: { name: string; error: Error } | null = null;

const basename = (p: string): string => p.split("/").pop() ?? p;

function installStub(): void {
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((async (
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    const p = (params ?? {}) as Record<string, unknown>;
    const path = p.path as string;
    const name = basename(path);
    if (method === "ezcorp/fs.exists") {
      // The data dir itself (no `.csv` suffix) is reported present so
      // writeDataSet skips mkdir unless a test asks otherwise.
      if (!name.endsWith(".csv")) return { exists: !mkdirs.includes(path) ? true : true };
      return { exists: name in files };
    }
    if (method === "ezcorp/fs.read") {
      if (throwOnRead && throwOnRead.name === name) throw throwOnRead.error;
      if (!(name in files)) {
        throw new JsonRpcError(-32000, `ENOENT: ${path}`);
      }
      const text = files[name]!;
      const bytes = new TextEncoder().encode(text);
      const body = btoa(String.fromCharCode.apply(null, Array.from(bytes)));
      return { encoding: "utf-8", body, bytes: bytes.byteLength, resolvedPath: path };
    }
    if (method === "ezcorp/fs.write") {
      writes.push({ path, content: p.content as string });
      return { bytes: (p.content as string).length, resolvedPath: path };
    }
    if (method === "ezcorp/fs.mkdir") {
      mkdirs.push(path);
      return { resolvedPath: path };
    }
    throw new JsonRpcError(-32601, `coverage stub: unexpected RPC method ${method}`);
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
  files = {};
  writes = [];
  mkdirs = [];
  throwOnRead = null;
  installStub();
});
afterEach(() => {
  throwOnRead = null;
});

// ── CSV builder ─────────────────────────────────────────────────────
function csv(header: string, rows: string[]): string {
  return [header, ...rows].join("\n") + "\n";
}

const HEADERS = {
  properties:
    "property_id,name,address,city,state,type,sqft,units,acquisition_date,book_value,current_noi_ytd,budgeted_noi_ytd",
  leases:
    "lease_id,property_id,tenant_name,unit,sqft,lease_start,lease_end,base_rent_monthly,escalation_pct,escalation_month,renewal_option,status",
  rent_roll: "month,lease_id,property_id,scheduled_rent,billed_rent,collected_rent",
  ar_aging:
    "tenant_name,property_id,lease_id,current,days_30,days_60,days_90_plus,total_outstanding,last_payment_date",
  gl_transactions:
    "txn_id,property_id,date,account_code,account_name,category,amount,description",
  budget_vs_actual:
    "property_id,category,period,budget_ytd,actual_ytd,variance_dollars,variance_pct",
  work_orders:
    "wo_id,property_id,description,status,estimated_cost,actual_cost,opened_date,closed_date,capex_flag",
  loans:
    "loan_id,property_id,lender,original_balance,current_balance,rate,maturity_date,dscr_current,dscr_covenant,next_payment_date",
  cam_recs:
    "property_id,reconciliation_year,status,estimated_recovery,billed_recovery,variance,true_up_issued",
  compliance: "property_id,item,expiry_date,status,notes",
} as const;

/** All ten CSVs as header-only (zero rows) — the "empty portfolio" fixture. */
function emptyDataset(): CsvMap {
  const out: CsvMap = {};
  for (const [k, header] of Object.entries(HEADERS)) {
    out[`${k}.csv`] = csv(header, []);
  }
  return out;
}

function textOf(res: JsonRpcResponse): string {
  const result = res.result as ToolCallResult | undefined;
  const first = result?.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text content");
  return first.text;
}

function call(name: string, args: Record<string, unknown> = {}, id = 1) {
  return handleRequest({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

// ── Per-tool happy-path + validation coverage ───────────────────────
//
// These hit the handler bodies that the seeded suite never exercises plus
// each tool's `property_id required` guard.

test("get-leases filters by property_id and status_filter", async () => {
  files = {
    "leases.csv": csv(HEADERS.leases, [
      "L-1,PX,Acme,101,1000,2020-01-01,2027-01-01,5000,3,1,yes,active",
      "L-2,PX,Beta,102,1000,2020-01-01,2024-01-01,4000,3,1,no,expired",
      "L-3,PY,Gamma,201,1000,2020-01-01,2027-01-01,3000,3,1,yes,active",
    ]),
  };
  const all = JSON.parse(textOf(await call("get-leases")));
  expect(all).toHaveLength(3);
  const px = JSON.parse(textOf(await call("get-leases", { property_id: "PX" })));
  expect(px.every((r: { property_id: string }) => r.property_id === "PX")).toBe(true);
  const active = JSON.parse(
    textOf(await call("get-leases", { property_id: "PX", status_filter: "active" })),
  );
  expect(active).toHaveLength(1);
  expect(active[0].lease_id).toBe("L-1");
});

test("get-ar-aging returns summary + scoped rows", async () => {
  files = {
    "ar_aging.csv": csv(HEADERS.ar_aging, [
      "Acme,PX,L-1,1000,0,0,0,1000,2026-04-01",
      "Beta,PY,L-2,0,0,5000,0,5000,2026-01-01",
    ]),
  };
  const portfolio = JSON.parse(textOf(await call("get-ar-aging")));
  expect(portfolio.summary.tenant_count).toBe(2);
  expect(portfolio.rows).toHaveLength(2);
  const scoped = JSON.parse(textOf(await call("get-ar-aging", { property_id: "PX" })));
  expect(scoped.rows).toHaveLength(1);
  expect(scoped.summary.total_outstanding).toBe(1000);
});

test("get-gl-summary aggregates by category + account, requires property_id", async () => {
  expect((await call("get-gl-summary")).error?.code).toBe(-32602);
  files = {
    "gl_transactions.csv": csv(HEADERS.gl_transactions, [
      "T1,PX,2026-01-15,4000,Rental Income,Revenue,10000,Jan rent",
      "T2,PX,2026-01-20,5000,Repairs,OpEx,-2500,Plumbing",
      "T3,PX,2026-02-10,4000,Rental Income,Revenue,10000,Feb rent",
      "T4,PY,2026-01-15,4000,Rental Income,Revenue,9999,Other property",
    ]),
  };
  const body = JSON.parse(textOf(await call("get-gl-summary", { property_id: "PX" })));
  expect(body.property_id).toBe("PX");
  expect(body.txn_count).toBe(3);
  expect(body.revenue_ytd).toBe(20000);
  expect(body.opex_ytd).toBe(2500);
  expect(body.noi_implied).toBe(17500);
  // by_account ranked by abs amount: Rental Income (20000) first.
  expect(body.by_account[0].account_code).toBe("4000");
});

test("get-noi-trend requires property_id and rejects unknown property", async () => {
  expect((await call("get-noi-trend")).error?.code).toBe(-32602);
  files = {
    "properties.csv": csv(HEADERS.properties, [
      "PX,Tower,1 St,City,ST,office,1000,1,2020-01-01,1000000,120000,100000",
    ]),
    "gl_transactions.csv": csv(HEADERS.gl_transactions, [
      "T1,PX,2026-01-15,4000,Rental Income,Revenue,10000,Jan",
      "T2,PX,2026-01-20,5000,Repairs,OpEx,-2500,Repair",
    ]),
  };
  expect((await call("get-noi-trend", { property_id: "P999" })).error?.code).toBe(-32602);
  const body = JSON.parse(textOf(await call("get-noi-trend", { property_id: "PX" })));
  expect(body.property_id).toBe("PX");
  expect(body.noi_ytd).toBe(120000);
  expect(body.monthly).toHaveLength(1);
  expect(body.monthly[0].noi).toBe(7500);
});

test("get-work-orders sorts by cost and honors open_only + requires id", async () => {
  expect((await call("get-work-orders")).error?.code).toBe(-32602);
  files = {
    "work_orders.csv": csv(HEADERS.work_orders, [
      "WO-1,PX,Roof,open,5000,0,2026-01-01,,true",
      "WO-2,PX,HVAC,closed,9000,9000,2026-01-01,2026-02-01,true",
      "WO-3,PY,Other,open,1000,0,2026-01-01,,false",
    ]),
  };
  const all = JSON.parse(textOf(await call("get-work-orders", { property_id: "PX" })));
  expect(all).toHaveLength(2);
  expect(all[0].wo_id).toBe("WO-2"); // 9000 sorts first
  const open = JSON.parse(
    textOf(await call("get-work-orders", { property_id: "PX", open_only: true })),
  );
  expect(open).toHaveLength(1);
  expect(open[0].wo_id).toBe("WO-1");
});

test("get-capex-summary requires property_id and totals capex", async () => {
  expect((await call("get-capex-summary")).error?.code).toBe(-32602);
  files = {
    "work_orders.csv": csv(HEADERS.work_orders, [
      "WO-1,PX,Roof,open,5000,1000,2026-01-01,,true",
      "WO-2,PX,Paint,open,2000,0,2026-01-01,,false",
    ]),
  };
  const body = JSON.parse(textOf(await call("get-capex-summary", { property_id: "PX" })));
  expect(body.total_estimated_capex).toBe(5000); // only capex_flag=true
  expect(body.open_capex_count).toBe(1);
  expect(body.largest_open_wo.wo_id).toBe("WO-1");
});

test("get-loan-info requires property_id and returns scoped loans", async () => {
  expect((await call("get-loan-info")).error?.code).toBe(-32602);
  files = {
    "loans.csv": csv(HEADERS.loans, [
      "LN-1,PX,Bank A,1000000,900000,0.05,2030-01-01,1.30,1.15,2026-05-01",
      "LN-2,PY,Bank B,500000,400000,0.04,2029-01-01,1.40,1.20,2026-05-01",
    ]),
  };
  const rows = JSON.parse(textOf(await call("get-loan-info", { property_id: "PX" })));
  expect(rows).toHaveLength(1);
  expect(rows[0].loan_id).toBe("LN-1");
});

// ── regenerate-data: write path ─────────────────────────────────────

test("regenerate-data generates and writes all ten CSVs", async () => {
  const res = await call("regenerate-data", { seed: 7 });
  const body = JSON.parse(textOf(res));
  expect(body.seed).toBe(7);
  expect(body.planted).toBeDefined();
  // Ten CSV files written through the host fs RPC.
  const written = writes.map((w) => basename(w.path));
  expect(written).toContain("properties.csv");
  expect(written).toContain("compliance.csv");
  expect(written).toHaveLength(10);
});

test("regenerate-data defaults to seed 42 when omitted", async () => {
  const body = JSON.parse(textOf(await call("regenerate-data", {})));
  expect(body.seed).toBe(42);
});

// ── readCsv missing-file branch ─────────────────────────────────────

test("missing data file surfaces a JsonRpcError through handleRequest", async () => {
  // No files installed → fsExists returns false → readCsv throws.
  const res = await call("list-properties");
  expect(res.error?.code).toBe(-32000);
  expect(res.error?.message).toContain("Missing data file");
  expect(res.error?.message).toContain("Run regenerate-data");
});

// ── handleRequest error branches ────────────────────────────────────

test("handleRequest rejects an unknown tool name", async () => {
  const res = await call("no-such-tool");
  expect(res.error?.code).toBe(-32601);
  expect(res.error?.message).toContain("Unknown tool");
});

test("handleRequest maps a non-JsonRpcError handler throw to -32000", async () => {
  // Force fsRead to throw a plain Error (not JsonRpcError) for properties.csv.
  files = { "properties.csv": csv(HEADERS.properties, []) };
  throwOnRead = { name: "properties.csv", error: new Error("disk exploded") };
  const res = await call("list-properties");
  expect(res.error?.code).toBe(-32000);
  expect(res.error?.message).toBe("disk exploded");
});

// ── Empty-portfolio briefing: every "no rows" section branch ────────

test("generate-daily-briefing renders empty-state placeholders for a clean portfolio", async () => {
  files = emptyDataset();
  const md = textOf(await call("generate-daily-briefing"));
  expect(md).toContain("_No leases expiring in the next 90 days._");
  expect(md).toContain("_No tenants at risk._");
  expect(md).toContain("_All loans are healthy against their covenants._");
  expect(md).toContain("_No compliance items due within 60 days._");
});

// ── Single-property deep-dive: empty branches ───────────────────────

test("generate-property-deep-dive renders empty-state placeholders for a clean property", async () => {
  files = emptyDataset();
  files["properties.csv"] = csv(HEADERS.properties, [
    "PX,Clean Tower,1 Main,Metro,ST,office,50000,5,2019-06-01,8000000,500000,500000",
  ]);
  const md = textOf(await call("generate-property-deep-dive", { property_id: "PX" }));
  expect(md).toContain("# Property Deep Dive — Clean Tower (PX)");
  expect(md).toContain("_None._"); // no expiring leases
  expect(md).toContain("No categories variant > 15% from budget.");
  expect(md).toContain("No CAM reconciliations on file.");
  expect(md).toContain("_No loans on file._");
  expect(md).toContain("_No compliance items due in the next 90 days._");
  expect(md).toContain("_No material risks identified._");
  expect(md).toContain("_No material opportunities identified._");
  expect(md).toContain("_No actions drafted — property clean._");
});

// ── Single-property deep-dive: rich branches the seed P003 case misses ──

test("generate-property-deep-dive surfaces scoped tenant-risk + covenant + CAM true-up actions", async () => {
  files = emptyDataset();
  files["properties.csv"] = csv(HEADERS.properties, [
    "PX,Risky Plaza,2 Center,Metro,ST,retail,80000,12,2018-03-01,12000000,900000,1000000",
  ]);
  // A tenant in default scoped to PX → tenantsAtRisk → risk row + AR table +
  // collection-email draft action.
  files["leases.csv"] = csv(HEADERS.leases, [
    "L-PX1,PX,Coastal Imports,101,4000,2019-01-01,2028-01-01,8000,3,1,no,default",
  ]);
  files["ar_aging.csv"] = csv(HEADERS.ar_aging, [
    "Coastal Imports,PX,L-PX1,0,0,0,66000,66000,2026-01-15",
  ]);
  // A loan in covenant breach → covenant risk loop + covenant memo action.
  files["loans.csv"] = csv(HEADERS.loans, [
    "LN-PX,PX,Bank Z,10000000,9000000,0.06,2031-01-01,1.05,1.20,2026-05-01",
  ]);
  // A CAM rec under-recovered with no true-up → CAM opportunity + true-up memo.
  files["cam_recs.csv"] = csv(HEADERS.cam_recs, [
    "PX,2024,reconciled,80000,60000,-20000,false",
  ]);
  const md = textOf(await call("generate-property-deep-dive", { property_id: "PX" }));
  // Tenant-at-risk risk + AR table row.
  expect(md).toContain("Coastal Imports at risk (L-PX1)");
  expect(md).toContain("| Coastal Imports | L-PX1 |");
  // Covenant breach surfaced as a ranked risk.
  expect(md).toContain("Covenant breach on LN-PX");
  // CAM true-up opportunity + drafted memo.
  expect(md).toContain("Issue CAM true-up for 2024");
  expect(md).toContain("### Draft Memo — CAM 2024 True-Up: Risky Plaza");
  // Collection email draft for the at-risk tenant.
  expect(md).toContain("### Draft Email — Collection: Coastal Imports");
  // Covenant watch memo draft.
  expect(md).toContain("### Draft Memo — Covenant Watch: LN-PX");
});

// ── Sanity: the seeded generator still drives the on-disk fixtures ───
// (keeps this file self-contained against generate-data's shape.)
test("generate(7) produces a non-empty dataset shape", () => {
  const data = generate(7);
  expect(data.properties.length).toBeGreaterThan(0);
  expect(data.planted).toBeDefined();
});
