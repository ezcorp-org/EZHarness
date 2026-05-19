import { afterAll, beforeAll, beforeEach, test, expect, spyOn } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { JsonRpcResponse, ToolCallResult } from "@ezcorp/sdk";
import { getChannel, JsonRpcError } from "@ezcorp/sdk/runtime";
import {
  findExpiringLeases,
  findUnbilledEscalations,
  findTenantsAtRisk,
  findCovenantStatus,
  findBudgetFlags,
  findComplianceAlerts,
  findCamUnderRecoveries,
  computeArSummary,
  computeNoiTrend,
  computeCapexSummary,
  computeCamStatus,
  computeRentRollSummary,
  handleRequest,
  tools,
} from "./index";
import { generate } from "./generate-data";

// ── In-test fs RPC stub ─────────────────────────────────────────────
//
// `readCsv` routes through `@ezcorp/sdk/runtime`'s `fsExists` + `fsRead`
// (Phase 3 host-mediated reverse-RPC). Bun unit tests run in-process
// with no host attached, so we stub `getChannel().request` for these
// methods and route them to real disk reads of the data/ fixtures.

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
    throw new JsonRpcError(-32601, `property-intelligence test stub: unexpected RPC method ${method}`);
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
  // Re-install stub — the global preload's afterEach drops the channel
  // singleton between tests.
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
const DATA = generate(42);
const TODAY = new Date("2026-04-23");

// ── Pure-logic tests ────────────────────────────────────────────

test("findExpiringLeases surfaces the 2 planted expiring leases within 90 days", () => {
  const results = findExpiringLeases(DATA.leases, TODAY, 90);
  const ids = results.map((r) => r.lease_id);
  expect(ids).toContain("L-102"); // P001, 78 days
  expect(ids).toContain("L-502"); // P005, 45 days
  // Both should have renewal_option=no
  for (const id of ["L-102", "L-502"]) {
    const row = results.find((r) => r.lease_id === id)!;
    expect(row.renewal_option).toBe("no");
    expect(row.days_until_end).toBeLessThanOrEqual(90);
  }
});

test("findExpiringLeases skips leases outside the window", () => {
  const strict = findExpiringLeases(DATA.leases, TODAY, 30);
  for (const r of strict) expect(r.days_until_end).toBeLessThanOrEqual(30);
});

test("findExpiringLeases respects property_id filter", () => {
  const onlyP001 = findExpiringLeases(DATA.leases, TODAY, 90, "P001");
  for (const r of onlyP001) expect(r.property_id).toBe("P001");
});

test("findUnbilledEscalations finds all 3 planted leases", () => {
  const issues = findUnbilledEscalations(DATA.leases, DATA.rentRoll);
  const leaseIds = new Set(issues.map((i) => i.lease_id));
  for (const id of ["L-301", "L-302", "L-401"]) expect(leaseIds.has(id)).toBe(true);
  // Every issue must have scheduled > billed.
  for (const i of issues) expect(i.scheduled_rent).toBeGreaterThan(i.billed_rent);
});

test("findUnbilledEscalations total matches planted invariant", () => {
  const issues = findUnbilledEscalations(DATA.leases, DATA.rentRoll);
  const total = issues.reduce((s, i) => s + i.delta, 0);
  expect(total).toBe(DATA.planted.unbilledEscalationTotal);
  // Planted total is meaningful — not zero, not astronomical.
  expect(total).toBeGreaterThan(10_000);
  expect(total).toBeLessThan(50_000);
});

test("findUnbilledEscalations scoped to P003 returns only L-301/L-302", () => {
  const p003 = findUnbilledEscalations(DATA.leases, DATA.rentRoll, "P003");
  const leaseIds = new Set(p003.map((i) => i.lease_id));
  expect(leaseIds.has("L-301")).toBe(true);
  expect(leaseIds.has("L-302")).toBe(true);
  expect(leaseIds.has("L-401")).toBe(false);
});

test("findTenantsAtRisk surfaces the tenant in default + 90+ past due", () => {
  const atRisk = findTenantsAtRisk(DATA.arAging, DATA.leases, 60);
  const bylease = new Map(atRisk.map((t) => [t.lease_id, t]));
  expect(bylease.has("L-501")).toBe(true);
  expect(bylease.has("L-701")).toBe(true);
  const defaulted = bylease.get("L-501")!;
  expect(defaulted.status).toBe("default");
  expect(defaulted.risk_level).toBe("critical");
  const pastDue = bylease.get("L-701")!;
  expect(pastDue.oldest_bucket).toBe("90+");
  expect(pastDue.total_outstanding).toBeGreaterThanOrEqual(40_000);
});

test("findTenantsAtRisk with tight threshold keeps default + 90+", () => {
  const strict = findTenantsAtRisk(DATA.arAging, DATA.leases, 90);
  const leaseIds = new Set(strict.map((t) => t.lease_id));
  expect(leaseIds.has("L-501")).toBe(true); // default regardless of days
  expect(leaseIds.has("L-701")).toBe(true); // 90+ bucket
});

test("findCovenantStatus flags P003 as at-risk (gap within 0.10)", () => {
  const statuses = findCovenantStatus(DATA.loans, undefined, 0.1);
  const p003 = statuses.find((s) => s.property_id === "P003")!;
  expect(p003).toBeDefined();
  expect(p003.status).toBe("at-risk");
  expect(p003.gap).toBe(0.07);
  // P003 should be the most-at-risk loan in the portfolio (smallest gap).
  const healthy = statuses.filter((s) => s.status === "healthy");
  for (const h of healthy) expect(h.gap).toBeGreaterThan(0.1);
});

test("findBudgetFlags flags P003 Utilities at +25%", () => {
  const flags = findBudgetFlags(DATA.budgetVsActual, "P003", 15);
  const util = flags.find((f) => f.category === "Utilities");
  expect(util).toBeDefined();
  expect(util!.direction).toBe("over");
  expect(util!.variance_pct).toBeGreaterThanOrEqual(20);
});

test("findComplianceAlerts surfaces P003 insurance expiring in 22 days", () => {
  const alerts = findComplianceAlerts(DATA.compliance, TODAY, 30);
  const match = alerts.find(
    (a) => a.property_id === "P003" && a.item === "Commercial Property Insurance",
  );
  expect(match).toBeDefined();
  expect(match!.days_until_expiry).toBe(22);
  expect(match!.status).toBe("expiring");
});

test("findCamUnderRecoveries surfaces both planted CAM gaps", () => {
  const gaps = findCamUnderRecoveries(DATA.camRecs, 10_000);
  const props = new Set(gaps.map((g) => g.property_id));
  expect(props.has("P003")).toBe(true);
  expect(props.has("P010")).toBe(true);
  const total = gaps.reduce((s, g) => s + g.shortfall, 0);
  expect(total).toBeGreaterThanOrEqual(25_000);
});

test("computeArSummary aggregates buckets and ranks tenants", () => {
  const sum = computeArSummary(DATA.arAging);
  expect(sum.total_outstanding).toBeGreaterThan(0);
  expect(sum.days_90_plus).toBeGreaterThanOrEqual(47_500); // the planted L-701 figure
  expect(sum.top_tenants.length).toBeGreaterThan(0);
  // Top tenant dollar-wise should be Coastal Imports (default, $66K) OR Apex
  // (past-due, $47.5K) — both above most healthy tenants.
  const topNames = sum.top_tenants.slice(0, 2).map((t) => t.tenant_name);
  expect(topNames.some((n) => n.includes("Coastal Imports") || n.includes("Apex"))).toBe(true);
});

test("computeNoiTrend returns 12 monthly buckets for P003", () => {
  const p003 = DATA.properties.find((p) => p.property_id === "P003")!;
  const trend = computeNoiTrend(p003, DATA.glTransactions);
  expect(trend.monthly.length).toBeGreaterThanOrEqual(11);
  expect(trend.noi_variance_pct).toBeLessThan(-10);
  expect(trend.noi_ytd).toBe(1_080_000);
  expect(trend.noi_budget_ytd).toBe(1_300_000);
});

test("computeCapexSummary includes the planted $185K chiller on P003", () => {
  const summary = computeCapexSummary(DATA.workOrders, "P003");
  expect(summary.largest_open_wo).toBeDefined();
  expect(summary.largest_open_wo!.wo_id).toBe("WO-9999");
  expect(summary.largest_open_wo!.estimated_cost).toBe(185_000);
  expect(summary.open_capex_count).toBeGreaterThan(0);
});

test("computeCamStatus flags P003 2024 under-recovery", () => {
  const s = computeCamStatus(DATA.camRecs, "P003")!;
  expect(s).toBeDefined();
  expect(s.latest_year).toBe(2024);
  expect(s.under_recovered).toBe(true);
  expect(s.variance).toBe(-13_000);
  expect(s.true_up_issued).toBe(false);
});

test("computeRentRollSummary respects month window", () => {
  const sum = computeRentRollSummary(DATA.rentRoll, "P003", 12);
  expect(sum.months_included).toBeLessThanOrEqual(12);
  expect(sum.total_scheduled).toBeGreaterThanOrEqual(sum.total_billed);
  expect(sum.billing_gap).toBeGreaterThan(0); // planted escalations
});

// ── RPC smoke tests ─────────────────────────────────────────────

test("handleRequest rejects unknown methods", async () => {
  const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "unknown" });
  expect(res.error?.code).toBe(-32601);
});

test("list-properties returns 10 properties", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "list-properties", arguments: {} },
  });
  const parsed = JSON.parse(textOf(res));
  expect(parsed).toHaveLength(10);
  expect(parsed.map((p: { property_id: string }) => p.property_id)).toContain("P003");
});

test("get-property returns P003 with hero-property invariants", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "get-property", arguments: { property_id: "P003" } },
  });
  const p = JSON.parse(textOf(res));
  expect(p.property_id).toBe("P003");
  expect(p.current_noi_ytd).toBe(1_080_000);
  expect(p.budgeted_noi_ytd).toBe(1_300_000);
});

test("get-expiring-leases returns the 2 planted leases", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "get-expiring-leases", arguments: { days_ahead: 90 } },
  });
  const rows = JSON.parse(textOf(res));
  const ids = rows.map((r: { lease_id: string }) => r.lease_id);
  expect(ids).toContain("L-102");
  expect(ids).toContain("L-502");
});

test("get-tenants-at-risk returns both planted tenants", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "get-tenants-at-risk", arguments: { threshold_days: 60 } },
  });
  const rows = JSON.parse(textOf(res));
  const ids = rows.map((r: { lease_id: string }) => r.lease_id);
  expect(ids).toContain("L-501");
  expect(ids).toContain("L-701");
});

test("find-unbilled-escalations RPC hits all 3 planted leases", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "find-unbilled-escalations", arguments: {} },
  });
  const rows = JSON.parse(textOf(res));
  const ids = new Set(rows.map((r: { lease_id: string }) => r.lease_id));
  expect(ids.has("L-301")).toBe(true);
  expect(ids.has("L-302")).toBe(true);
  expect(ids.has("L-401")).toBe(true);
});

test("get-covenant-status portfolio-wide flags P003", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "get-covenant-status", arguments: {} },
  });
  const rows = JSON.parse(textOf(res));
  const p003 = rows.find((r: { property_id: string }) => r.property_id === "P003");
  expect(p003.status).toBe("at-risk");
});

test("get-cam-status for P003 returns the $13K under-recovery", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 8, method: "tools/call",
    params: { name: "get-cam-status", arguments: { property_id: "P003" } },
  });
  const body = JSON.parse(textOf(res));
  expect(body.status).toBeDefined();
  expect(body.status.under_recovered).toBe(true);
  expect(body.status.variance).toBe(-13_000);
});

test("get-compliance within 30 days returns P003 insurance", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 9, method: "tools/call",
    params: { name: "get-compliance", arguments: { days_ahead: 30 } },
  });
  const rows = JSON.parse(textOf(res));
  const p003Ins = rows.find(
    (r: { property_id: string; item: string }) =>
      r.property_id === "P003" && r.item === "Commercial Property Insurance",
  );
  expect(p003Ins).toBeDefined();
  expect(p003Ins.days_until_expiry).toBe(22);
});

test("get-budget-vs-actual for P003 flags Utilities overrun", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 10, method: "tools/call",
    params: { name: "get-budget-vs-actual", arguments: { property_id: "P003" } },
  });
  const body = JSON.parse(textOf(res));
  const util = body.flags.find((f: { category: string }) => f.category === "Utilities");
  expect(util).toBeDefined();
  expect(util.direction).toBe("over");
});

test("get-rent-roll for P003 returns summary with billing gap", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 11, method: "tools/call",
    params: { name: "get-rent-roll", arguments: { property_id: "P003", months: 12 } },
  });
  const body = JSON.parse(textOf(res));
  expect(body.summary.billing_gap).toBeGreaterThan(0);
});

test("draft-email produces a DRAFT-labeled output and does not send", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 12, method: "tools/call",
    params: {
      name: "draft-email",
      arguments: {
        recipient: "ap@apexlogistics.example",
        subject: "Past-due balance",
        body: "Following up on the $47,500 outstanding on L-701.",
      },
    },
  });
  const body = textOf(res);
  expect(body).toContain("[DRAFT — NOT SENT]");
  expect(body).toContain("L-701");
  expect(body).toContain("ap@apexlogistics.example");
});

test("draft-memo labels output as DRAFT", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 13, method: "tools/call",
    params: {
      name: "draft-memo",
      arguments: { title: "Covenant Watch — P003", body: "DSCR 1.22 vs covenant 1.15.", audience: "CFO" },
    },
  });
  const body = textOf(res);
  expect(body).toContain("DRAFT");
  expect(body).toContain("Covenant Watch");
});

test("create-task returns a draft task JSON", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 14, method: "tools/call",
    params: {
      name: "create-task",
      arguments: {
        assignee: "Billing Team",
        description: "Issue catch-up invoices for L-301 / L-302 / L-401.",
        due_date: "2026-04-30",
        priority: "high",
      },
    },
  });
  const body = JSON.parse(textOf(res));
  expect(body.status).toBe("draft");
  expect(body.assignee).toBe("Billing Team");
});

// ── End-to-end synthesis tests ──────────────────────────────────

test("generate-daily-briefing surfaces every headline category + drafts", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 20, method: "tools/call",
    params: { name: "generate-daily-briefing", arguments: {} },
  });
  const md = textOf(res);
  // Section anchors
  expect(md).toContain("Daily Portfolio Briefing");
  expect(md).toContain("Top Exceptions");
  expect(md).toContain("Expiring Leases");
  expect(md).toContain("AR Risk");
  expect(md).toContain("Covenant Alerts");
  expect(md).toContain("Compliance Alerts");
  expect(md).toContain("Recommended Actions");
  // Planted issues must surface by ID
  expect(md).toContain("L-102");
  expect(md).toContain("L-502");
  expect(md).toContain("L-501");
  expect(md).toContain("L-701");
  // Dollar formatting appears
  expect(md).toMatch(/\$\d{1,3}(?:,\d{3})+/);
  // At least 2 drafted actions (spec: briefing must include ≥2 drafts).
  const draftCount = (md.match(/\[DRAFT — NOT SENT\]/g) ?? []).length;
  expect(draftCount).toBeGreaterThanOrEqual(2);
});

test("generate-property-deep-dive for P003 hits every required section", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 21, method: "tools/call",
    params: { name: "generate-property-deep-dive", arguments: { property_id: "P003" } },
  });
  const md = textOf(res);
  // Every section the spec requires.
  for (const header of [
    "# Property Deep Dive — Riverside Commons (P003)",
    "## Overview", "## Lease Summary", "## Expiring Lease Risk",
    "## AR & Tenant Risk", "## Financial Performance", "## CAM Status",
    "## Operations", "## Debt & Covenants", "## Compliance",
    "## Top Risks", "## Top Opportunities", "## Recommended Actions",
  ]) {
    expect(md).toContain(header);
  }
  // Planted hero invariants must appear.
  expect(md).toContain("1.22"); // DSCR
  expect(md).toContain("1.15"); // covenant
  expect(md).toContain("L-301"); // unbilled escalation
  expect(md).toContain("L-302");
  expect(md).toContain("WO-9999"); // largest open capex
  expect(md).toContain("Utilities"); // budget flag
  // Ranked items counts (spec: ≥3 risks, ≥2 opportunities, ≥3 drafted actions).
  const risks = md.match(/^\d+\. \*\*[^*]+\*\* —/gm) ?? [];
  expect(risks.length).toBeGreaterThanOrEqual(5); // 3 risks + 2 opps minimum
  const drafts = (md.match(/\[DRAFT — NOT SENT\]/g) ?? []).length;
  expect(drafts).toBeGreaterThanOrEqual(3);
});

test("generate-property-deep-dive rejects unknown property", async () => {
  const res = await handleRequest({
    jsonrpc: "2.0", id: 22, method: "tools/call",
    params: { name: "generate-property-deep-dive", arguments: { property_id: "P999" } },
  });
  expect(res.error?.code).toBe(-32602);
});

// ── Manifest sanity ─────────────────────────────────────────────

test("manifest declares the expected tools, agent, and skill", async () => {
  const manifest = (await import(import.meta.dir + "/ezcorp.config.ts")).default;
  expect(manifest.schemaVersion).toBe(2);
  expect(manifest.name).toBe("property-intelligence-agent");
  expect(manifest.persistent).toBe(true);
  const toolNames = (manifest.tools as Array<{ name: string }>).map((t) => t.name);
  for (const expected of [
    "list-properties", "get-property",
    "get-leases", "get-expiring-leases", "get-rent-roll", "find-unbilled-escalations",
    "get-ar-aging", "get-tenants-at-risk",
    "get-gl-summary", "get-budget-vs-actual", "get-noi-trend",
    "get-work-orders", "get-capex-summary",
    "get-loan-info", "get-covenant-status", "get-cam-status", "get-compliance",
    "draft-email", "draft-memo", "create-task",
    "generate-daily-briefing", "generate-property-deep-dive",
    "regenerate-data",
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
