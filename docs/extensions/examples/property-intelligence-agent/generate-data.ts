#!/usr/bin/env bun
// Synthetic commercial real-estate accounting data.
//
// Seeded (default 42) so the Property Intelligence demo produces the same
// headlines every run. Invariants the generator guarantees — the agent and
// its tests rely on them:
//
//   • P003 (Riverside Commons) is the hero property. It carries:
//       – DSCR 1.22 vs covenant 1.15 (within 0.1 — covenant alert)
//       – NOI YTD actual $1.08M vs budget $1.30M (−16.9%, below the −15% bar)
//       – 2 leases with unbilled escalations (rent_roll billed < scheduled)
//       – CAM 2024 under-recovery of $13,000
//       – Insurance policy expiring in 22 days
//       – OpEx "Utilities" +25% over budget
//   • 2 leases expiring in the next 90 days, no renewal option exercised
//   • 1 tenant in default, 1 tenant 90+ days past due
//   • Second CAM under-recovery on P010 > $10K
//   • 1 additional unbilled escalation on P004 (3 total across portfolio)
//
// Every planted invariant is declared in the returned `planted` object so
// tests can assert on it directly without re-deriving from the CSVs.

import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

// ── Seeded PRNG (mulberry32) ────────────────────────────────────
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickFn(r: () => number) {
  return <T>(arr: readonly T[]): T => arr[Math.floor(r() * arr.length)]!;
}
const intFn = (r: () => number) => (min: number, max: number) =>
  Math.floor(r() * (max - min + 1)) + min;

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
const fmtMonth = (d: Date) => d.toISOString().slice(0, 7);
const addDays = (d: Date, n: number) => {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
};
const addMonths = (d: Date, n: number) => {
  const out = new Date(d);
  out.setMonth(out.getMonth() + n);
  return out;
};

// ── CSV helpers ─────────────────────────────────────────────────
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(","));
  return lines.join("\n") + "\n";
}

// ── Record types ────────────────────────────────────────────────
export interface PropertyRow {
  property_id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  type: "office" | "retail" | "industrial" | "mixed-use";
  sqft: number;
  units: number;
  acquisition_date: string;
  book_value: number;
  current_noi_ytd: number;
  budgeted_noi_ytd: number;
}

export interface LeaseRow {
  lease_id: string;
  property_id: string;
  tenant_name: string;
  unit: string;
  sqft: number;
  lease_start: string;
  lease_end: string;
  base_rent_monthly: number;
  escalation_pct: number;
  escalation_month: number; // 1-12
  renewal_option: "yes" | "exercised" | "no";
  status: "active" | "expiring" | "holdover" | "default" | "vacant";
}

export interface RentRollRow {
  month: string; // YYYY-MM
  lease_id: string;
  property_id: string;
  scheduled_rent: number;
  billed_rent: number;
  collected_rent: number;
}

export interface ArAgingRow {
  tenant_name: string;
  property_id: string;
  lease_id: string;
  current: number;
  days_30: number;
  days_60: number;
  days_90_plus: number;
  total_outstanding: number;
  last_payment_date: string;
}

export interface GlTxnRow {
  txn_id: string;
  property_id: string;
  date: string;
  account_code: string;
  account_name: string;
  category: string; // Revenue | OpEx | NOI
  amount: number;
  description: string;
}

export interface BudgetVarianceRow {
  property_id: string;
  category: string;
  period: string; // "YTD"
  budget_ytd: number;
  actual_ytd: number;
  variance_dollars: number;
  variance_pct: number;
}

export interface WorkOrderRow {
  wo_id: string;
  property_id: string;
  description: string;
  status: "open" | "in_progress" | "closed";
  estimated_cost: number;
  actual_cost: number;
  opened_date: string;
  closed_date: string;
  capex_flag: boolean;
}

export interface LoanRow {
  loan_id: string;
  property_id: string;
  lender: string;
  original_balance: number;
  current_balance: number;
  rate: number;
  maturity_date: string;
  dscr_current: number;
  dscr_covenant: number;
  next_payment_date: string;
}

export interface CamRecRow {
  property_id: string;
  reconciliation_year: number;
  status: "draft" | "issued" | "pending";
  estimated_recovery: number;
  billed_recovery: number;
  variance: number;
  true_up_issued: boolean;
}

export interface ComplianceRow {
  property_id: string;
  item: string;
  expiry_date: string;
  status: "current" | "expiring" | "expired";
  notes: string;
}

export interface DataSet {
  properties: PropertyRow[];
  leases: LeaseRow[];
  rentRoll: RentRollRow[];
  arAging: ArAgingRow[];
  glTransactions: GlTxnRow[];
  budgetVsActual: BudgetVarianceRow[];
  workOrders: WorkOrderRow[];
  loans: LoanRow[];
  camRecs: CamRecRow[];
  compliance: ComplianceRow[];
  planted: {
    heroProperty: string;
    dscrAlertProperty: string;
    dscrGap: number;
    noiVarianceProperty: string;
    noiVariancePct: number;
    unbilledEscalationLeases: string[];
    unbilledEscalationTotal: number;
    camUnderRecoveryProperties: string[];
    camUnderRecoveryTotal: number;
    expiringInsuranceProperty: string;
    expiringInsuranceDays: number;
    opexOverrunProperty: string;
    opexOverrunCategory: string;
    opexOverrunPct: number;
    expiringLeases: string[];
    tenantInDefault: { lease_id: string; tenant: string };
    tenantPastDue: { lease_id: string; tenant: string; days: number; amount: number };
  };
}

// ── Property fixtures ───────────────────────────────────────────
const PROPERTY_SEEDS: Array<{
  id: string; name: string; address: string; city: string; state: string;
  type: PropertyRow["type"]; sqft: number; units: number;
}> = [
  { id: "P001", name: "Oakwood Office Plaza",      address: "2400 Camelback Rd",   city: "Phoenix",       state: "AZ", type: "office",     sqft: 142_000, units: 18 },
  { id: "P002", name: "Midtown Retail Center",     address: "1200 S Congress Ave", city: "Austin",        state: "TX", type: "retail",     sqft:  88_000, units: 22 },
  { id: "P003", name: "Riverside Commons",         address: "800 Riverside Dr",    city: "Nashville",     state: "TN", type: "mixed-use",  sqft: 215_000, units: 36 },
  { id: "P004", name: "Crossroads Industrial Park",address: "4500 Trade Center Dr",city: "Dallas",        state: "TX", type: "industrial", sqft: 310_000, units:  8 },
  { id: "P005", name: "Summit Corporate Center",   address: "1700 Broadway",       city: "Denver",        state: "CO", type: "office",     sqft: 198_000, units: 24 },
  { id: "P006", name: "Cedar Hills Plaza",         address: "9400 SW Barbur Blvd", city: "Portland",      state: "OR", type: "retail",     sqft:  62_000, units: 14 },
  { id: "P007", name: "Harbor Logistics Hub",      address: "2800 Pier E St",      city: "Long Beach",    state: "CA", type: "industrial", sqft: 420_000, units:  6 },
  { id: "P008", name: "Brookside Office Park",     address: "6100 Fairview Rd",    city: "Charlotte",     state: "NC", type: "office",     sqft:  94_000, units: 12 },
  { id: "P009", name: "Parkview Retail Center",    address: "11400 Lake Underhill",city: "Orlando",       state: "FL", type: "retail",     sqft:  72_000, units: 18 },
  { id: "P010", name: "Millbrook Crossing",        address: "500 Nicollet Mall",   city: "Minneapolis",   state: "MN", type: "mixed-use",  sqft: 155_000, units: 28 },
];

const OFFICE_TENANTS = [
  "Harbor & Finch LLP", "Meridian Consulting Group", "Northstar Analytics",
  "Pivot Health Partners", "Crescent Capital Advisors", "Lumen Digital Labs",
  "Ironwood Architecture", "Sterling Benefits Group", "Caldera Biotech Inc.",
  "Vantage Wealth Management", "Brightpath Engineering", "Oakridge Tax Services",
];

const RETAIL_TENANTS = [
  "Copperleaf Home Goods", "Blue Anchor Coffee Co.", "Pacific Table Bistro",
  "Mercer & Co. Apparel", "Wildflower Wellness", "Stonefire Pizzeria",
  "Third Avenue Books", "Studio Velo Cycling", "The Daily Grocer",
  "Bluebird Bakery", "Atlas Outfitters", "Lantern & Leaf",
];

const INDUSTRIAL_TENANTS = [
  "Apex Logistics Inc.", "Coastal Imports Co.", "Quartz Manufacturing LLC",
  "Redwood Distribution", "Sierra Freight Solutions", "Keystone Packaging",
  "Summit Fulfillment", "Trident Cold Storage",
];

const MIXED_TENANTS = [
  ...OFFICE_TENANTS.slice(0, 6), ...RETAIL_TENANTS.slice(0, 6),
];

function tenantPool(t: PropertyRow["type"]): string[] {
  switch (t) {
    case "office":     return OFFICE_TENANTS;
    case "retail":     return RETAIL_TENANTS;
    case "industrial": return INDUSTRIAL_TENANTS;
    case "mixed-use":  return MIXED_TENANTS;
  }
}

const LENDERS = [
  "First Federal Commercial Bank", "Pinnacle Real Estate Capital",
  "Atlantic Mutual Lending", "Summit CRE Partners", "Bridgeway Financial",
];

const OPEX_CATEGORIES = [
  "Repairs & Maintenance", "Utilities", "Insurance", "Property Taxes",
  "Management Fees", "Landscaping", "Security", "Administrative",
];

const OPEX_ACCOUNTS: Record<string, { code: string; name: string }> = {
  "Repairs & Maintenance": { code: "6100", name: "Repairs & Maintenance Expense" },
  "Utilities":             { code: "6200", name: "Utilities Expense" },
  "Insurance":             { code: "6300", name: "Insurance Expense" },
  "Property Taxes":        { code: "6400", name: "Property Tax Expense" },
  "Management Fees":       { code: "6500", name: "Management Fee Expense" },
  "Landscaping":           { code: "6600", name: "Landscaping Expense" },
  "Security":              { code: "6700", name: "Security Expense" },
  "Administrative":        { code: "6800", name: "Admin Expense" },
};

const REVENUE_ACCOUNTS = [
  { code: "4100", name: "Base Rent Income",  category: "Revenue" },
  { code: "4200", name: "CAM Recovery Income", category: "Revenue" },
  { code: "4300", name: "Other Income",        category: "Revenue" },
];

// ── Main generator ──────────────────────────────────────────────
export function generate(seed = 42, today: Date = new Date("2026-04-23")): DataSet {
  const r = rng(seed);
  const pick = pickFn(r);
  const int = intFn(r);

  // ── Properties ────────────────────────────────────────────────
  const properties: PropertyRow[] = PROPERTY_SEEDS.map((p) => {
    const bookValue = p.sqft * int(180, 420);
    const grossRentAnnual = p.sqft * int(18, 52);
    const noiAnnual = Math.round(grossRentAnnual * (0.55 + r() * 0.15));
    const noiYtd = Math.round(noiAnnual * (4 / 12)); // 4 months into year
    const budgetedNoiYtd = Math.round(noiYtd * (0.98 + r() * 0.06));
    return {
      property_id: p.id,
      name: p.name,
      address: p.address,
      city: p.city,
      state: p.state,
      type: p.type,
      sqft: p.sqft,
      units: p.units,
      acquisition_date: fmtDate(addDays(today, -int(800, 2800))),
      book_value: bookValue,
      current_noi_ytd: noiYtd,
      budgeted_noi_ytd: budgetedNoiYtd,
    };
  });

  // ── Leases ────────────────────────────────────────────────────
  //
  // Each property gets (units × ~0.6) active leases so there's some vacancy.
  // Lease end dates are spread 6mo-5yr out. A planted handful land inside
  // 90 days for the expiring-leases signal.
  const leases: LeaseRow[] = [];
  let leaseNum = 100;
  for (const p of properties) {
    const pool = tenantPool(p.type);
    const nLeases = Math.max(3, Math.floor(p.units * (0.55 + r() * 0.2)));
    const tenantSet = new Set<string>();
    for (let i = 0; i < nLeases; i++) {
      let tenant = pick(pool);
      let guard = 0;
      while (tenantSet.has(tenant) && guard++ < 20) tenant = pick(pool);
      tenantSet.add(tenant);
      const unit = `${p.property_id.slice(1)}-${String(i + 1).padStart(2, "0")}`;
      const leaseSqft = Math.floor(p.sqft / nLeases) + int(-400, 800);
      const annualPsf = p.type === "industrial"
        ? int(8, 15)
        : p.type === "retail"
          ? int(22, 48)
          : p.type === "office"
            ? int(26, 55)
            : int(20, 50);
      const baseRent = Math.round((leaseSqft * annualPsf) / 12);
      const startOffset = -int(180, 1200);
      const leaseStart = addDays(today, startOffset);
      const termMonths = int(24, 84);
      const leaseEnd = addMonths(leaseStart, termMonths);
      const escPct = [0.025, 0.03, 0.035, 0.04][int(0, 3)]!;
      const escMonth = leaseStart.getUTCMonth() + 1;
      const renewal: LeaseRow["renewal_option"] = r() < 0.6 ? "yes" : "no";
      // Status reflects lease_end relative to today.
      const daysToEnd = Math.floor((leaseEnd.getTime() - today.getTime()) / (24 * 3600 * 1000));
      const status: LeaseRow["status"] =
        daysToEnd < 0 ? "holdover" : daysToEnd < 120 ? "expiring" : "active";
      leases.push({
        lease_id: `L-${leaseNum++}`,
        property_id: p.property_id,
        tenant_name: tenant,
        unit,
        sqft: leaseSqft,
        lease_start: fmtDate(leaseStart),
        lease_end: fmtDate(leaseEnd),
        base_rent_monthly: baseRent,
        escalation_pct: escPct,
        escalation_month: escMonth,
        renewal_option: renewal,
        status,
      });
    }
  }

  // ── Plant specific leases we'll reference by ID ──────────────
  //
  // Overwrite a small number of leases with deterministic fixtures so
  // downstream tests (and the agent) can point at known IDs.
  function findLeaseOnProperty(pid: string, idx = 0): LeaseRow {
    const owned = leases.filter((l) => l.property_id === pid);
    const target = owned[idx];
    if (!target) throw new Error(`No lease #${idx} on ${pid}`);
    return target;
  }

  // Hero P003: two leases with unbilled escalations. Give them known IDs
  // and hefty rent so the demo dollar figures are impressive.
  const heroLease1 = findLeaseOnProperty("P003", 0);
  heroLease1.lease_id = "L-301";
  heroLease1.tenant_name = "Meridian Consulting Group";
  heroLease1.base_rent_monthly = 45_000;
  heroLease1.escalation_pct = 0.04;
  heroLease1.escalation_month = 1;
  heroLease1.lease_start = "2024-01-01";
  heroLease1.lease_end = fmtDate(addMonths(new Date("2024-01-01"), 60));
  heroLease1.status = "active";
  heroLease1.renewal_option = "yes";
  heroLease1.sqft = 18_500;
  heroLease1.unit = "301-A";

  const heroLease2 = findLeaseOnProperty("P003", 1);
  heroLease2.lease_id = "L-302";
  heroLease2.tenant_name = "Copperleaf Home Goods";
  heroLease2.base_rent_monthly = 32_000;
  heroLease2.escalation_pct = 0.035;
  heroLease2.escalation_month = 1;
  heroLease2.lease_start = "2024-01-01";
  heroLease2.lease_end = fmtDate(addMonths(new Date("2024-01-01"), 72));
  heroLease2.status = "active";
  heroLease2.renewal_option = "yes";
  heroLease2.sqft = 12_400;
  heroLease2.unit = "302-R";

  // P004: third unbilled escalation (smaller, adds portfolio breadth).
  const p4Lease = findLeaseOnProperty("P004", 0);
  p4Lease.lease_id = "L-401";
  p4Lease.tenant_name = "Redwood Distribution";
  p4Lease.base_rent_monthly = 18_000;
  p4Lease.escalation_pct = 0.03;
  p4Lease.escalation_month = 1;
  p4Lease.lease_start = "2023-01-01";
  p4Lease.lease_end = fmtDate(addMonths(new Date("2023-01-01"), 84));
  p4Lease.status = "active";
  p4Lease.renewal_option = "yes";

  // P005: lease expiring in 45 days, no renewal.
  const p5ExpLease = findLeaseOnProperty("P005", 1);
  p5ExpLease.lease_id = "L-502";
  p5ExpLease.tenant_name = "Sterling Benefits Group";
  p5ExpLease.base_rent_monthly = 28_500;
  p5ExpLease.escalation_pct = 0.03;
  p5ExpLease.lease_start = fmtDate(addDays(today, -1400));
  p5ExpLease.lease_end = fmtDate(addDays(today, 45));
  p5ExpLease.status = "expiring";
  p5ExpLease.renewal_option = "no";

  // P005: tenant in default.
  const p5DefLease = findLeaseOnProperty("P005", 0);
  p5DefLease.lease_id = "L-501";
  p5DefLease.tenant_name = "Coastal Imports Co.";
  p5DefLease.base_rent_monthly = 22_000;
  p5DefLease.status = "default";
  p5DefLease.renewal_option = "no";
  p5DefLease.lease_end = fmtDate(addDays(today, 240));

  // P001: second expiring lease (78 days, no renewal).
  const p1ExpLease = findLeaseOnProperty("P001", 0);
  p1ExpLease.lease_id = "L-102";
  p1ExpLease.tenant_name = "Harbor & Finch LLP";
  p1ExpLease.base_rent_monthly = 34_000;
  p1ExpLease.lease_end = fmtDate(addDays(today, 78));
  p1ExpLease.status = "expiring";
  p1ExpLease.renewal_option = "no";

  // P007: tenant 92 days past due on L-701.
  const p7Lease = findLeaseOnProperty("P007", 0);
  p7Lease.lease_id = "L-701";
  p7Lease.tenant_name = "Apex Logistics Inc.";
  p7Lease.base_rent_monthly = 47_500;
  p7Lease.status = "active";

  // ── Rent roll ────────────────────────────────────────────────
  //
  // 12 months back per active lease. Scheduled rent respects the escalation
  // schedule. For most leases billed = scheduled = collected. Planted
  // escalation misses show up as billed < scheduled in the last N months.
  const rentRoll: RentRollRow[] = [];
  const firstMonth = addMonths(today, -11);

  function scheduledFor(lease: LeaseRow, monthDate: Date): number {
    // How many full years have elapsed since lease_start anchored to the
    // escalation month? Each full year applies one escalation.
    const start = new Date(lease.lease_start);
    let years = monthDate.getUTCFullYear() - start.getUTCFullYear();
    const crossedEscMonth = monthDate.getUTCMonth() + 1 >= lease.escalation_month;
    if (!crossedEscMonth) years -= 1;
    years = Math.max(0, years);
    return Math.round(lease.base_rent_monthly * Math.pow(1 + lease.escalation_pct, years));
  }

  for (const l of leases) {
    if (l.status === "vacant") continue;
    for (let i = 0; i < 12; i++) {
      const m = addMonths(firstMonth, i);
      if (new Date(l.lease_start) > m) continue;
      if (new Date(l.lease_end) < m && l.status !== "holdover") continue;
      const scheduled = scheduledFor(l, m);
      // Default: billed = scheduled, collected = scheduled (healthy).
      let billed = scheduled;
      let collected = scheduled;
      // Default tenants collect nothing for the last 3 months.
      if (l.status === "default" && i >= 9) collected = 0;
      rentRoll.push({
        month: fmtMonth(m),
        lease_id: l.lease_id,
        property_id: l.property_id,
        scheduled_rent: scheduled,
        billed_rent: billed,
        collected_rent: collected,
      });
    }
  }

  // Plant unbilled escalations. For L-301 / L-302 / L-401 the escalation
  // on 2026-01 was never applied to billings: scheduled ticked up, billed
  // stayed flat at the prior year's rate.
  function plantMissedEscalation(leaseId: string, months: string[]) {
    for (const month of months) {
      const row = rentRoll.find((x) => x.lease_id === leaseId && x.month === month);
      if (!row) continue;
      const lease = leases.find((l) => l.lease_id === leaseId)!;
      const priorYearDate = addMonths(new Date(month + "-01"), -12);
      row.billed_rent = scheduledFor(lease, priorYearDate);
      row.collected_rent = row.billed_rent;
    }
  }
  const missedMonths2026 = ["2026-01", "2026-02", "2026-03", "2026-04"];
  plantMissedEscalation("L-301", missedMonths2026);
  plantMissedEscalation("L-302", missedMonths2026);
  plantMissedEscalation("L-401", missedMonths2026);

  // Compute the unbilled-escalation total we expect the agent to surface.
  let unbilledEscalationTotal = 0;
  for (const id of ["L-301", "L-302", "L-401"]) {
    for (const m of missedMonths2026) {
      const row = rentRoll.find((x) => x.lease_id === id && x.month === m);
      if (row) unbilledEscalationTotal += row.scheduled_rent - row.billed_rent;
    }
  }

  // ── AR aging ──────────────────────────────────────────────────
  const arAging: ArAgingRow[] = [];
  // Healthy tenants: small current balance only.
  for (const l of leases) {
    if (l.status === "vacant") continue;
    const isDefault = l.status === "default";
    const isPastDue = l.lease_id === "L-701";
    if (isDefault) continue; // handled below
    if (isPastDue) continue; // handled below
    // Most tenants are current; some have modest current-bucket AR.
    const current = r() < 0.4 ? Math.round(l.base_rent_monthly * (r() * 0.3)) : 0;
    if (current === 0) continue;
    arAging.push({
      tenant_name: l.tenant_name,
      property_id: l.property_id,
      lease_id: l.lease_id,
      current,
      days_30: 0,
      days_60: 0,
      days_90_plus: 0,
      total_outstanding: current,
      last_payment_date: fmtDate(addDays(today, -int(5, 25))),
    });
  }
  // Planted: tenant in default on L-501.
  arAging.push({
    tenant_name: "Coastal Imports Co.",
    property_id: "P005",
    lease_id: "L-501",
    current: 22_000,
    days_30: 22_000,
    days_60: 22_000,
    days_90_plus: 0,
    total_outstanding: 66_000,
    last_payment_date: fmtDate(addDays(today, -78)),
  });
  // Planted: tenant 92 days past due on L-701.
  arAging.push({
    tenant_name: "Apex Logistics Inc.",
    property_id: "P007",
    lease_id: "L-701",
    current: 0,
    days_30: 0,
    days_60: 0,
    days_90_plus: 47_500,
    total_outstanding: 47_500,
    last_payment_date: fmtDate(addDays(today, -112)),
  });

  // ── Loans ────────────────────────────────────────────────────
  const loans: LoanRow[] = properties.map((p, i) => {
    const original = Math.round(p.book_value * (0.55 + r() * 0.2));
    const current = Math.round(original * (0.75 + r() * 0.22));
    const rate = 0.045 + r() * 0.025;
    const maturity = fmtDate(addDays(today, int(180, 2400)));
    const dscr = 1.25 + r() * 0.45;
    const covenant = 1.15 + r() * 0.05;
    return {
      loan_id: `LN-${String(i + 1).padStart(3, "0")}`,
      property_id: p.property_id,
      lender: pick(LENDERS),
      original_balance: original,
      current_balance: current,
      rate: Math.round(rate * 10000) / 10000,
      maturity_date: maturity,
      dscr_current: Math.round(dscr * 100) / 100,
      dscr_covenant: Math.round(covenant * 100) / 100,
      next_payment_date: fmtDate(addDays(today, int(3, 28))),
    };
  });

  // Plant P003 DSCR at 1.22, covenant 1.15 (0.07 gap — within 0.1).
  const p3Loan = loans.find((l) => l.property_id === "P003")!;
  p3Loan.dscr_current = 1.22;
  p3Loan.dscr_covenant = 1.15;
  p3Loan.lender = "Atlantic Mutual Lending";
  p3Loan.current_balance = 28_500_000;
  p3Loan.original_balance = 32_000_000;
  p3Loan.rate = 0.0515;
  p3Loan.maturity_date = fmtDate(addDays(today, 820));
  const dscrGap = Math.round((p3Loan.dscr_current - p3Loan.dscr_covenant) * 100) / 100;

  // ── Budget vs Actual ─────────────────────────────────────────
  //
  // Per-property per-category YTD aggregates. Most rows sit near budget;
  // P003 gets a planted Utilities overrun (+25%) and an NOI variance of
  // −17% (derived from the planted current_noi_ytd vs budgeted_noi_ytd).
  const budgetVsActual: BudgetVarianceRow[] = [];
  function variance(budget: number, actual: number) {
    const vDollars = Math.round(actual - budget);
    const vPct = budget === 0 ? 0 : Math.round((vDollars / budget) * 10000) / 100;
    return { vDollars, vPct };
  }
  for (const p of properties) {
    // Revenue line.
    const revBudget = Math.round(p.sqft * 32 * (4 / 12));
    const revActual = Math.round(revBudget * (0.97 + r() * 0.06));
    const rev = variance(revBudget, revActual);
    budgetVsActual.push({
      property_id: p.property_id,
      category: "Total Revenue",
      period: "YTD",
      budget_ytd: revBudget,
      actual_ytd: revActual,
      variance_dollars: rev.vDollars,
      variance_pct: rev.vPct,
    });
    // OpEx categories.
    for (const cat of OPEX_CATEGORIES) {
      const baseline = Math.round(p.sqft * (1.2 + r() * 0.9) * (4 / 12));
      const budget = baseline;
      const actual = Math.round(budget * (0.93 + r() * 0.14));
      const v = variance(budget, actual);
      budgetVsActual.push({
        property_id: p.property_id,
        category: cat,
        period: "YTD",
        budget_ytd: budget,
        actual_ytd: actual,
        variance_dollars: v.vDollars,
        variance_pct: v.vPct,
      });
    }
    // NOI summary.
    const noiV = variance(p.budgeted_noi_ytd, p.current_noi_ytd);
    budgetVsActual.push({
      property_id: p.property_id,
      category: "NOI",
      period: "YTD",
      budget_ytd: p.budgeted_noi_ytd,
      actual_ytd: p.current_noi_ytd,
      variance_dollars: noiV.vDollars,
      variance_pct: noiV.vPct,
    });
  }

  // Plant P003 NOI variance at −17% and Utilities at +25%.
  const p3 = properties.find((p) => p.property_id === "P003")!;
  p3.budgeted_noi_ytd = 1_300_000;
  p3.current_noi_ytd = 1_080_000;
  const p3Noi = budgetVsActual.find(
    (b) => b.property_id === "P003" && b.category === "NOI",
  )!;
  p3Noi.budget_ytd = 1_300_000;
  p3Noi.actual_ytd = 1_080_000;
  p3Noi.variance_dollars = -220_000;
  p3Noi.variance_pct = -16.92;
  const noiVariancePct = p3Noi.variance_pct;

  const p3Util = budgetVsActual.find(
    (b) => b.property_id === "P003" && b.category === "Utilities",
  )!;
  p3Util.budget_ytd = 52_000;
  p3Util.actual_ytd = 65_000;
  p3Util.variance_dollars = 13_000;
  p3Util.variance_pct = 25;

  // ── GL transactions ──────────────────────────────────────────
  //
  // 6-12 postings per property per month across the last 12 months. Random
  // amounts within category baselines. Keeps the file sizable without the
  // precision of real sub-ledger-matching.
  const glTransactions: GlTxnRow[] = [];
  let txnNum = 50_000;
  for (const p of properties) {
    for (let mi = 0; mi < 12; mi++) {
      const monthDate = addMonths(firstMonth, mi);
      // Revenue entries — 1 per revenue account per month.
      for (const rev of REVENUE_ACCOUNTS) {
        const magnitude = rev.code === "4100"
          ? Math.round(p.sqft * 2.5 * (0.9 + r() * 0.2))
          : rev.code === "4200"
            ? Math.round(p.sqft * 0.4 * (0.9 + r() * 0.2))
            : Math.round(int(500, 8_000));
        glTransactions.push({
          txn_id: `T-${txnNum++}`,
          property_id: p.property_id,
          date: fmtDate(new Date(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), int(1, 28))),
          account_code: rev.code,
          account_name: rev.name,
          category: rev.category,
          amount: magnitude,
          description: `${rev.name} — ${fmtMonth(monthDate)}`,
        });
      }
      // OpEx entries — varied postings across categories.
      const nPostings = int(5, 11);
      for (let k = 0; k < nPostings; k++) {
        const cat = pick(OPEX_CATEGORIES);
        const acct = OPEX_ACCOUNTS[cat]!;
        const amount = Math.round(int(400, 9_500) * (0.9 + r() * 0.3));
        glTransactions.push({
          txn_id: `T-${txnNum++}`,
          property_id: p.property_id,
          date: fmtDate(new Date(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), int(1, 28))),
          account_code: acct.code,
          account_name: acct.name,
          category: "OpEx",
          amount: -amount,
          description: `${cat} — ${fmtMonth(monthDate)}`,
        });
      }
    }
  }

  // ── Work orders ──────────────────────────────────────────────
  const workOrders: WorkOrderRow[] = [];
  let woNum = 9000;
  const WO_DESCRIPTIONS = [
    "HVAC rooftop unit compressor replacement", "Parking lot crack sealing",
    "Lobby lighting retrofit to LED", "Roof membrane leak repair",
    "Elevator modernization phase 1", "Tenant buildout — new suite",
    "Exterior paint refresh", "Fire panel annual service",
    "Boiler efficiency tune-up", "Landscape irrigation overhaul",
    "Restroom fixture replacement", "Signage update — new tenant",
    "Security camera firmware upgrade", "Waterproofing — foundation wall",
  ];
  for (const p of properties) {
    const n = int(6, 12);
    for (let i = 0; i < n; i++) {
      const isCapex = r() < 0.3;
      const openedDaysAgo = int(5, 180);
      const status: WorkOrderRow["status"] = r() < 0.55 ? "closed" : r() < 0.7 ? "open" : "in_progress";
      const estimated = isCapex ? int(15_000, 180_000) : int(350, 14_000);
      const actual = status === "closed"
        ? Math.round(estimated * (0.85 + r() * 0.3))
        : 0;
      const closed = status === "closed"
        ? fmtDate(addDays(today, -int(0, openedDaysAgo - 1)))
        : "";
      workOrders.push({
        wo_id: `WO-${woNum++}`,
        property_id: p.property_id,
        description: pick(WO_DESCRIPTIONS),
        status,
        estimated_cost: estimated,
        actual_cost: actual,
        opened_date: fmtDate(addDays(today, -openedDaysAgo)),
        closed_date: closed,
        capex_flag: isCapex,
      });
    }
  }
  // Plant one large open capex WO on the hero property.
  workOrders.push({
    wo_id: "WO-9999",
    property_id: "P003",
    description: "Chiller replacement — Building A main loop",
    status: "in_progress",
    estimated_cost: 185_000,
    actual_cost: 42_000,
    opened_date: fmtDate(addDays(today, -38)),
    closed_date: "",
    capex_flag: true,
  });

  // ── CAM reconciliations ──────────────────────────────────────
  const camRecs: CamRecRow[] = [];
  for (const p of properties) {
    // Prior year reconciliation.
    const estimated = Math.round(p.sqft * 0.5 * (0.9 + r() * 0.2));
    const billed = Math.round(estimated * (0.97 + r() * 0.05));
    const v = billed - estimated;
    camRecs.push({
      property_id: p.property_id,
      reconciliation_year: 2023,
      status: "issued",
      estimated_recovery: estimated,
      billed_recovery: billed,
      variance: v,
      true_up_issued: true,
    });
    // Current-year reconciliation (2024) — in progress.
    const est24 = Math.round(p.sqft * 0.52 * (0.9 + r() * 0.2));
    const bill24 = Math.round(est24 * (0.96 + r() * 0.06));
    camRecs.push({
      property_id: p.property_id,
      reconciliation_year: 2024,
      status: "pending",
      estimated_recovery: est24,
      billed_recovery: bill24,
      variance: bill24 - est24,
      true_up_issued: false,
    });
  }
  // Plant P003 2024 under-recovery of $13,000.
  const p3Cam = camRecs.find((c) => c.property_id === "P003" && c.reconciliation_year === 2024)!;
  p3Cam.estimated_recovery = 85_000;
  p3Cam.billed_recovery = 72_000;
  p3Cam.variance = -13_000;
  p3Cam.true_up_issued = false;
  // Plant P010 2024 under-recovery of $12,000.
  const p10Cam = camRecs.find((c) => c.property_id === "P010" && c.reconciliation_year === 2024)!;
  p10Cam.estimated_recovery = 45_000;
  p10Cam.billed_recovery = 33_000;
  p10Cam.variance = -12_000;
  p10Cam.true_up_issued = false;

  // ── Compliance ───────────────────────────────────────────────
  const compliance: ComplianceRow[] = [];
  const COMPLIANCE_ITEMS = [
    { item: "Commercial Property Insurance", window: [260, 340] as const },
    { item: "Property Tax Payment",          window: [60, 260] as const },
    { item: "Fire Sprinkler Inspection",     window: [90, 340] as const },
    { item: "Elevator Certification",        window: [120, 360] as const },
    { item: "HVAC Annual Certification",     window: [140, 320] as const },
  ];
  for (const p of properties) {
    for (const c of COMPLIANCE_ITEMS) {
      // Skip elevator cert on single-story industrial.
      if (c.item === "Elevator Certification" && p.type === "industrial") continue;
      const daysAhead = int(c.window[0], c.window[1]);
      const expiry = addDays(today, daysAhead);
      const status: ComplianceRow["status"] =
        daysAhead < 0 ? "expired" : daysAhead < 45 ? "expiring" : "current";
      compliance.push({
        property_id: p.property_id,
        item: c.item,
        expiry_date: fmtDate(expiry),
        status,
        notes: daysAhead < 45 ? "Renewal paperwork required" : "",
      });
    }
  }
  // Plant P003 insurance expiring in 22 days.
  const p3Ins = compliance.find(
    (c) => c.property_id === "P003" && c.item === "Commercial Property Insurance",
  )!;
  p3Ins.expiry_date = fmtDate(addDays(today, 22));
  p3Ins.status = "expiring";
  p3Ins.notes = "URGENT — carrier quote pending, broker meeting scheduled";

  return {
    properties,
    leases,
    rentRoll,
    arAging,
    glTransactions,
    budgetVsActual,
    workOrders,
    loans,
    camRecs,
    compliance,
    planted: {
      heroProperty: "P003",
      dscrAlertProperty: "P003",
      dscrGap,
      noiVarianceProperty: "P003",
      noiVariancePct,
      unbilledEscalationLeases: ["L-301", "L-302", "L-401"],
      unbilledEscalationTotal,
      camUnderRecoveryProperties: ["P003", "P010"],
      camUnderRecoveryTotal: 13_000 + 12_000,
      expiringInsuranceProperty: "P003",
      expiringInsuranceDays: 22,
      opexOverrunProperty: "P003",
      opexOverrunCategory: "Utilities",
      opexOverrunPct: 25,
      expiringLeases: ["L-102", "L-502"],
      tenantInDefault: { lease_id: "L-501", tenant: "Coastal Imports Co." },
      tenantPastDue: { lease_id: "L-701", tenant: "Apex Logistics Inc.", days: 112, amount: 47_500 },
    },
  };
}

// ── Writer ──────────────────────────────────────────────────────
export async function writeDataSet(
  outDir: string,
  data: DataSet,
): Promise<{ files: string[]; rowCount: Record<string, number> }> {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const writes: [string, string][] = [
    ["properties.csv",       toCsv(data.properties as unknown as Record<string, unknown>[])],
    ["leases.csv",           toCsv(data.leases as unknown as Record<string, unknown>[])],
    ["rent_roll.csv",        toCsv(data.rentRoll as unknown as Record<string, unknown>[])],
    ["ar_aging.csv",         toCsv(data.arAging as unknown as Record<string, unknown>[])],
    ["gl_transactions.csv",  toCsv(data.glTransactions as unknown as Record<string, unknown>[])],
    ["budget_vs_actual.csv", toCsv(data.budgetVsActual as unknown as Record<string, unknown>[])],
    ["work_orders.csv",      toCsv(data.workOrders as unknown as Record<string, unknown>[])],
    ["loans.csv",            toCsv(data.loans as unknown as Record<string, unknown>[])],
    ["cam_recs.csv",         toCsv(data.camRecs as unknown as Record<string, unknown>[])],
    ["compliance.csv",       toCsv(data.compliance as unknown as Record<string, unknown>[])],
  ];
  const files: string[] = [];
  const rowCount: Record<string, number> = {};
  for (const [name, body] of writes) {
    const path = join(outDir, name);
    await Bun.write(path, body);
    files.push(path);
    rowCount[name] = Math.max(0, body.trimEnd().split("\n").length - 1);
  }
  return { files, rowCount };
}

// CLI entrypoint: `bun generate-data.ts [--seed=N] [--out=path]`
if (import.meta.main) {
  let seed = 42;
  let out = join(import.meta.dir, "data");
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--seed=")) seed = Number(arg.split("=")[1]);
    if (arg.startsWith("--out=")) out = arg.split("=")[1]!;
  }
  const data = generate(seed);
  const { files, rowCount } = await writeDataSet(out, data);
  console.log(`Wrote ${files.length} files to ${out}`);
  for (const [k, v] of Object.entries(rowCount)) console.log(`  ${k.padEnd(22)} ${v} rows`);
  console.log("\nPlanted invariants:");
  const p = data.planted;
  console.log(`  hero property             ${p.heroProperty}`);
  console.log(`  DSCR alert on ${p.dscrAlertProperty}       gap ${p.dscrGap} (covenant within 0.1)`);
  console.log(`  NOI variance on ${p.noiVarianceProperty}    ${p.noiVariancePct}%`);
  console.log(`  unbilled escalations      $${p.unbilledEscalationTotal.toLocaleString()} across ${p.unbilledEscalationLeases.join(", ")}`);
  console.log(`  CAM under-recovery        $${p.camUnderRecoveryTotal.toLocaleString()} on ${p.camUnderRecoveryProperties.join(", ")}`);
  console.log(`  insurance expiring        ${p.expiringInsuranceProperty} in ${p.expiringInsuranceDays} days`);
  console.log(`  OpEx overrun              ${p.opexOverrunProperty} — ${p.opexOverrunCategory} +${p.opexOverrunPct}%`);
  console.log(`  expiring leases           ${p.expiringLeases.join(", ")} (no renewal)`);
  console.log(`  tenant in default         ${p.tenantInDefault.lease_id} (${p.tenantInDefault.tenant})`);
  console.log(`  tenant past due           ${p.tenantPastDue.lease_id} (${p.tenantPastDue.tenant}) ${p.tenantPastDue.days}d $${p.tenantPastDue.amount.toLocaleString()}`);
}
