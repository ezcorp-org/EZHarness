#!/usr/bin/env bun
// property-intelligence-agent — tool server.
//
// Reads 10 CSVs shipped in ./data/ and exposes the analytical tools the
// Property Intelligence Agent calls. Follows the same JSON-RPC dispatcher
// pattern as cash-recovery-agent: declare a handler map, register it with
// `createToolDispatcher`, let the SDK's channel run the stdin loop.
//
// Everything this extension needs is contained in this directory — no
// cross-project imports, no external services, no API keys.

import type { JsonRpcRequest, JsonRpcResponse, ToolCallResult } from "@ezcorp/sdk";
import {
  createToolDispatcher,
  fsExists,
  fsRead,
  getChannel,
  JsonRpcError,
  toolResult,
  toolError,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import { join } from "node:path";
import {
  generate as generateData,
  writeDataSet,
  type PropertyRow,
  type LeaseRow,
  type RentRollRow,
  type ArAgingRow,
  type GlTxnRow,
  type BudgetVarianceRow,
  type WorkOrderRow,
  type LoanRow,
  type CamRecRow,
  type ComplianceRow,
} from "./generate-data";

// ── Paths ───────────────────────────────────────────────────────
const EXT_DIR = import.meta.dir;
const DATA_DIR = join(EXT_DIR, "data");

// Reference date for "today." Matches the generator seed so expiring-
// lease / compliance math is stable in tests. Real harness deployments
// should override this by regenerating data against the current date.
const TODAY = new Date("2026-04-23");

// ── CSV parser (no external deps) ───────────────────────────────
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (ch === "\r") { /* skip */ }
      else cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0]!;
  return rows.slice(1)
    .filter((r) => r.some((v) => v.length > 0))
    .map((r) => {
      const out: Record<string, string> = {};
      headers.forEach((h, i) => { out[h] = r[i] ?? ""; });
      return out;
    });
}

async function readCsv(name: string): Promise<Record<string, string>[]> {
  const path = join(DATA_DIR, name);
  if (!(await fsExists(path))) {
    throw new JsonRpcError(-32000, `Missing data file: ${name}. Run regenerate-data.`);
  }
  const text = (await fsRead(path)) as string;
  return parseCsv(text);
}

// ── Row coercion ────────────────────────────────────────────────
const num = (v: string | undefined, fallback = 0): number => {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v: string | undefined): boolean => v === "true" || v === "1";

async function loadProperties(): Promise<PropertyRow[]> {
  return (await readCsv("properties.csv")).map((r) => ({
    property_id: r.property_id!, name: r.name!, address: r.address!,
    city: r.city!, state: r.state!,
    type: r.type as PropertyRow["type"],
    sqft: num(r.sqft), units: num(r.units),
    acquisition_date: r.acquisition_date!,
    book_value: num(r.book_value),
    current_noi_ytd: num(r.current_noi_ytd),
    budgeted_noi_ytd: num(r.budgeted_noi_ytd),
  }));
}
async function loadLeases(): Promise<LeaseRow[]> {
  return (await readCsv("leases.csv")).map((r) => ({
    lease_id: r.lease_id!, property_id: r.property_id!,
    tenant_name: r.tenant_name!, unit: r.unit!, sqft: num(r.sqft),
    lease_start: r.lease_start!, lease_end: r.lease_end!,
    base_rent_monthly: num(r.base_rent_monthly),
    escalation_pct: num(r.escalation_pct),
    escalation_month: num(r.escalation_month),
    renewal_option: (r.renewal_option as LeaseRow["renewal_option"]) ?? "no",
    status: (r.status as LeaseRow["status"]) ?? "active",
  }));
}
async function loadRentRoll(): Promise<RentRollRow[]> {
  return (await readCsv("rent_roll.csv")).map((r) => ({
    month: r.month!, lease_id: r.lease_id!, property_id: r.property_id!,
    scheduled_rent: num(r.scheduled_rent),
    billed_rent: num(r.billed_rent),
    collected_rent: num(r.collected_rent),
  }));
}
async function loadArAging(): Promise<ArAgingRow[]> {
  return (await readCsv("ar_aging.csv")).map((r) => ({
    tenant_name: r.tenant_name!, property_id: r.property_id!,
    lease_id: r.lease_id!,
    current: num(r.current), days_30: num(r.days_30),
    days_60: num(r.days_60), days_90_plus: num(r.days_90_plus),
    total_outstanding: num(r.total_outstanding),
    last_payment_date: r.last_payment_date!,
  }));
}
async function loadGlTransactions(): Promise<GlTxnRow[]> {
  return (await readCsv("gl_transactions.csv")).map((r) => ({
    txn_id: r.txn_id!, property_id: r.property_id!, date: r.date!,
    account_code: r.account_code!, account_name: r.account_name!,
    category: r.category!, amount: num(r.amount),
    description: r.description!,
  }));
}
async function loadBudgetVsActual(): Promise<BudgetVarianceRow[]> {
  return (await readCsv("budget_vs_actual.csv")).map((r) => ({
    property_id: r.property_id!, category: r.category!, period: r.period!,
    budget_ytd: num(r.budget_ytd), actual_ytd: num(r.actual_ytd),
    variance_dollars: num(r.variance_dollars),
    variance_pct: num(r.variance_pct),
  }));
}
async function loadWorkOrders(): Promise<WorkOrderRow[]> {
  return (await readCsv("work_orders.csv")).map((r) => ({
    wo_id: r.wo_id!, property_id: r.property_id!,
    description: r.description!,
    status: (r.status as WorkOrderRow["status"]) ?? "open",
    estimated_cost: num(r.estimated_cost),
    actual_cost: num(r.actual_cost),
    opened_date: r.opened_date!, closed_date: r.closed_date ?? "",
    capex_flag: bool(r.capex_flag),
  }));
}
async function loadLoans(): Promise<LoanRow[]> {
  return (await readCsv("loans.csv")).map((r) => ({
    loan_id: r.loan_id!, property_id: r.property_id!, lender: r.lender!,
    original_balance: num(r.original_balance),
    current_balance: num(r.current_balance),
    rate: num(r.rate),
    maturity_date: r.maturity_date!,
    dscr_current: num(r.dscr_current),
    dscr_covenant: num(r.dscr_covenant),
    next_payment_date: r.next_payment_date!,
  }));
}
async function loadCamRecs(): Promise<CamRecRow[]> {
  return (await readCsv("cam_recs.csv")).map((r) => ({
    property_id: r.property_id!,
    reconciliation_year: num(r.reconciliation_year),
    status: (r.status as CamRecRow["status"]) ?? "pending",
    estimated_recovery: num(r.estimated_recovery),
    billed_recovery: num(r.billed_recovery),
    variance: num(r.variance),
    true_up_issued: bool(r.true_up_issued),
  }));
}
async function loadCompliance(): Promise<ComplianceRow[]> {
  return (await readCsv("compliance.csv")).map((r) => ({
    property_id: r.property_id!, item: r.item!,
    expiry_date: r.expiry_date!,
    status: (r.status as ComplianceRow["status"]) ?? "current",
    notes: r.notes ?? "",
  }));
}

// ── Formatting helpers ──────────────────────────────────────────
const $ = (n: number): string => {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(Math.round(n));
  return `${sign}$${abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
};
const pct = (n: number, digits = 1): string =>
  `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
const daysBetween = (a: Date, b: Date) =>
  Math.floor((a.getTime() - b.getTime()) / (24 * 3600 * 1000));

// ── Pure analytic helpers (exported for unit tests) ─────────────

export interface ExpiringLease {
  lease_id: string;
  property_id: string;
  tenant_name: string;
  lease_end: string;
  days_until_end: number;
  base_rent_monthly: number;
  annual_rent: number;
  renewal_option: LeaseRow["renewal_option"];
  status: LeaseRow["status"];
}

export function findExpiringLeases(
  leases: LeaseRow[],
  today: Date,
  daysAhead: number,
  propertyId?: string,
): ExpiringLease[] {
  const out: ExpiringLease[] = [];
  for (const l of leases) {
    if (propertyId && l.property_id !== propertyId) continue;
    if (l.renewal_option === "exercised") continue;
    const end = new Date(l.lease_end);
    const days = daysBetween(end, today);
    if (days < 0 || days > daysAhead) continue;
    out.push({
      lease_id: l.lease_id, property_id: l.property_id,
      tenant_name: l.tenant_name, lease_end: l.lease_end,
      days_until_end: days,
      base_rent_monthly: l.base_rent_monthly,
      annual_rent: l.base_rent_monthly * 12,
      renewal_option: l.renewal_option,
      status: l.status,
    });
  }
  return out.sort((a, b) => a.days_until_end - b.days_until_end);
}

export interface EscalationIssue {
  lease_id: string;
  property_id: string;
  tenant_name: string;
  month: string;
  scheduled_rent: number;
  billed_rent: number;
  delta: number;
}

export function findUnbilledEscalations(
  leases: LeaseRow[],
  rentRoll: RentRollRow[],
  propertyId?: string,
  tolerance = 1,
): EscalationIssue[] {
  const tenantByLease = new Map(leases.map((l) => [l.lease_id, l] as const));
  const out: EscalationIssue[] = [];
  for (const row of rentRoll) {
    if (propertyId && row.property_id !== propertyId) continue;
    const delta = row.scheduled_rent - row.billed_rent;
    if (delta <= tolerance) continue;
    const lease = tenantByLease.get(row.lease_id);
    out.push({
      lease_id: row.lease_id,
      property_id: row.property_id,
      tenant_name: lease?.tenant_name ?? "(unknown)",
      month: row.month,
      scheduled_rent: row.scheduled_rent,
      billed_rent: row.billed_rent,
      delta,
    });
  }
  return out.sort((a, b) => b.delta - a.delta);
}

export interface TenantRisk {
  tenant_name: string;
  property_id: string;
  lease_id: string;
  total_outstanding: number;
  oldest_bucket: "current" | "0-30" | "31-60" | "61-90" | "90+";
  days_past_due_max: number;
  last_payment_date: string;
  status: LeaseRow["status"];
  risk_level: "critical" | "high" | "medium";
}

export function findTenantsAtRisk(
  arAging: ArAgingRow[],
  leases: LeaseRow[],
  thresholdDays = 60,
): TenantRisk[] {
  const leaseById = new Map(leases.map((l) => [l.lease_id, l] as const));
  const out: TenantRisk[] = [];
  for (const a of arAging) {
    const lease = leaseById.get(a.lease_id);
    const status = lease?.status ?? "active";
    let oldest: TenantRisk["oldest_bucket"] = "current";
    let maxDays = 0;
    if (a.days_90_plus > 0) { oldest = "90+"; maxDays = 90; }
    else if (a.days_60 > 0) { oldest = "61-90"; maxDays = 60; }
    else if (a.days_30 > 0) { oldest = "31-60"; maxDays = 30; }
    else if (a.current > 0) { oldest = "0-30"; maxDays = 0; }
    const isDefault = status === "default";
    const isPastThreshold = maxDays >= thresholdDays;
    if (!isDefault && !isPastThreshold) continue;
    const riskLevel: TenantRisk["risk_level"] =
      isDefault ? "critical" : maxDays >= 90 ? "critical" : maxDays >= 60 ? "high" : "medium";
    out.push({
      tenant_name: a.tenant_name,
      property_id: a.property_id,
      lease_id: a.lease_id,
      total_outstanding: a.total_outstanding,
      oldest_bucket: oldest,
      days_past_due_max: maxDays,
      last_payment_date: a.last_payment_date,
      status,
      risk_level: riskLevel,
    });
  }
  return out.sort((a, b) => b.total_outstanding - a.total_outstanding);
}

export interface CovenantStatus {
  loan_id: string;
  property_id: string;
  lender: string;
  dscr_current: number;
  dscr_covenant: number;
  gap: number;
  status: "breach" | "at-risk" | "healthy";
}

export function findCovenantStatus(
  loans: LoanRow[],
  propertyId?: string,
  warnThreshold = 0.1,
): CovenantStatus[] {
  const out: CovenantStatus[] = [];
  for (const l of loans) {
    if (propertyId && l.property_id !== propertyId) continue;
    const gap = Math.round((l.dscr_current - l.dscr_covenant) * 100) / 100;
    const status: CovenantStatus["status"] =
      gap < 0 ? "breach" : gap <= warnThreshold ? "at-risk" : "healthy";
    out.push({
      loan_id: l.loan_id, property_id: l.property_id, lender: l.lender,
      dscr_current: l.dscr_current, dscr_covenant: l.dscr_covenant,
      gap, status,
    });
  }
  return out.sort((a, b) => a.gap - b.gap);
}

export interface ArSummary {
  total_outstanding: number;
  current: number;
  days_30: number;
  days_60: number;
  days_90_plus: number;
  at_risk_dollars: number;
  tenant_count: number;
  top_tenants: Array<{ tenant_name: string; property_id: string; total_outstanding: number; bucket: string }>;
}

export function computeArSummary(
  arAging: ArAgingRow[],
  propertyId?: string,
): ArSummary {
  const rows = propertyId ? arAging.filter((a) => a.property_id === propertyId) : arAging;
  const totals = { current: 0, days_30: 0, days_60: 0, days_90_plus: 0, total: 0 };
  for (const r of rows) {
    totals.current += r.current;
    totals.days_30 += r.days_30;
    totals.days_60 += r.days_60;
    totals.days_90_plus += r.days_90_plus;
    totals.total += r.total_outstanding;
  }
  const atRisk = totals.days_60 + totals.days_90_plus;
  const ranked = [...rows]
    .sort((a, b) => b.total_outstanding - a.total_outstanding)
    .slice(0, 10)
    .map((r) => ({
      tenant_name: r.tenant_name,
      property_id: r.property_id,
      total_outstanding: r.total_outstanding,
      bucket: r.days_90_plus > 0 ? "90+" : r.days_60 > 0 ? "61-90" : r.days_30 > 0 ? "31-60" : "current",
    }));
  return {
    total_outstanding: Math.round(totals.total),
    current: Math.round(totals.current),
    days_30: Math.round(totals.days_30),
    days_60: Math.round(totals.days_60),
    days_90_plus: Math.round(totals.days_90_plus),
    at_risk_dollars: Math.round(atRisk),
    tenant_count: rows.length,
    top_tenants: ranked,
  };
}

export interface BudgetFlag {
  property_id: string;
  category: string;
  budget_ytd: number;
  actual_ytd: number;
  variance_dollars: number;
  variance_pct: number;
  direction: "over" | "under";
}

export function findBudgetFlags(
  bva: BudgetVarianceRow[],
  propertyId?: string,
  pctThreshold = 15,
): BudgetFlag[] {
  const out: BudgetFlag[] = [];
  for (const b of bva) {
    if (propertyId && b.property_id !== propertyId) continue;
    if (b.category === "Total Revenue" || b.category === "NOI") continue;
    if (Math.abs(b.variance_pct) < pctThreshold) continue;
    out.push({
      property_id: b.property_id,
      category: b.category,
      budget_ytd: b.budget_ytd,
      actual_ytd: b.actual_ytd,
      variance_dollars: b.variance_dollars,
      variance_pct: b.variance_pct,
      direction: b.variance_dollars > 0 ? "over" : "under",
    });
  }
  return out.sort((a, b) => Math.abs(b.variance_dollars) - Math.abs(a.variance_dollars));
}

export interface NoiTrend {
  property_id: string;
  noi_ytd: number;
  noi_budget_ytd: number;
  noi_variance_dollars: number;
  noi_variance_pct: number;
  monthly: Array<{ month: string; revenue: number; opex: number; noi: number }>;
}

export function computeNoiTrend(
  property: PropertyRow,
  gl: GlTxnRow[],
): NoiTrend {
  const mine = gl.filter((g) => g.property_id === property.property_id);
  const byMonth = new Map<string, { revenue: number; opex: number }>();
  for (const g of mine) {
    const key = g.date.slice(0, 7);
    const m = byMonth.get(key) ?? { revenue: 0, opex: 0 };
    if (g.category === "Revenue") m.revenue += g.amount;
    else if (g.category === "OpEx") m.opex += Math.abs(g.amount);
    byMonth.set(key, m);
  }
  const months = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({
      month,
      revenue: Math.round(v.revenue),
      opex: Math.round(v.opex),
      noi: Math.round(v.revenue - v.opex),
    }));
  return {
    property_id: property.property_id,
    noi_ytd: property.current_noi_ytd,
    noi_budget_ytd: property.budgeted_noi_ytd,
    noi_variance_dollars: property.current_noi_ytd - property.budgeted_noi_ytd,
    noi_variance_pct: property.budgeted_noi_ytd === 0
      ? 0
      : Math.round(((property.current_noi_ytd - property.budgeted_noi_ytd) / property.budgeted_noi_ytd) * 10000) / 100,
    monthly: months,
  };
}

export interface CapexSummary {
  property_id: string;
  total_estimated_capex: number;
  total_actual_capex: number;
  open_capex_count: number;
  largest_open_wo?: WorkOrderRow;
}

export function computeCapexSummary(
  workOrders: WorkOrderRow[],
  propertyId: string,
): CapexSummary {
  const mine = workOrders.filter((w) => w.property_id === propertyId && w.capex_flag);
  const open = mine.filter((w) => w.status !== "closed");
  const largest = open.sort((a, b) => b.estimated_cost - a.estimated_cost)[0];
  return {
    property_id: propertyId,
    total_estimated_capex: Math.round(mine.reduce((s, w) => s + w.estimated_cost, 0)),
    total_actual_capex: Math.round(mine.reduce((s, w) => s + w.actual_cost, 0)),
    open_capex_count: open.length,
    largest_open_wo: largest,
  };
}

export interface CamStatus {
  property_id: string;
  latest_year: number;
  status: CamRecRow["status"];
  estimated_recovery: number;
  billed_recovery: number;
  variance: number;
  under_recovered: boolean;
  true_up_issued: boolean;
}

export function computeCamStatus(
  camRecs: CamRecRow[],
  propertyId: string,
): CamStatus | null {
  const mine = camRecs.filter((c) => c.property_id === propertyId);
  if (mine.length === 0) return null;
  const latest = mine.sort((a, b) => b.reconciliation_year - a.reconciliation_year)[0]!;
  return {
    property_id: propertyId,
    latest_year: latest.reconciliation_year,
    status: latest.status,
    estimated_recovery: latest.estimated_recovery,
    billed_recovery: latest.billed_recovery,
    variance: latest.variance,
    under_recovered: latest.variance < 0,
    true_up_issued: latest.true_up_issued,
  };
}

export function findCamUnderRecoveries(
  camRecs: CamRecRow[],
  thresholdDollars = 10_000,
): Array<CamRecRow & { shortfall: number }> {
  return camRecs
    .filter((c) => c.variance < -thresholdDollars)
    .map((c) => ({ ...c, shortfall: -c.variance }))
    .sort((a, b) => b.shortfall - a.shortfall);
}

export interface ComplianceAlert {
  property_id: string;
  item: string;
  expiry_date: string;
  days_until_expiry: number;
  status: ComplianceRow["status"];
  notes: string;
}

export function findComplianceAlerts(
  compliance: ComplianceRow[],
  today: Date,
  daysAhead: number,
  propertyId?: string,
): ComplianceAlert[] {
  const out: ComplianceAlert[] = [];
  for (const c of compliance) {
    if (propertyId && c.property_id !== propertyId) continue;
    const days = daysBetween(new Date(c.expiry_date), today);
    if (days > daysAhead) continue;
    out.push({
      property_id: c.property_id, item: c.item,
      expiry_date: c.expiry_date, days_until_expiry: days,
      status: c.status, notes: c.notes,
    });
  }
  return out.sort((a, b) => a.days_until_expiry - b.days_until_expiry);
}

export interface RentRollSummary {
  property_id: string;
  months_included: number;
  total_scheduled: number;
  total_billed: number;
  total_collected: number;
  billing_gap: number;
  collection_rate: number;
}

export function computeRentRollSummary(
  rentRoll: RentRollRow[],
  propertyId: string,
  months: number,
): RentRollSummary {
  const rows = rentRoll
    .filter((r) => r.property_id === propertyId)
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, Number.MAX_SAFE_INTEGER);
  const uniqueMonths = [...new Set(rows.map((r) => r.month))]
    .sort((a, b) => b.localeCompare(a))
    .slice(0, months);
  const filtered = rows.filter((r) => uniqueMonths.includes(r.month));
  const sched = filtered.reduce((s, r) => s + r.scheduled_rent, 0);
  const billed = filtered.reduce((s, r) => s + r.billed_rent, 0);
  const collected = filtered.reduce((s, r) => s + r.collected_rent, 0);
  return {
    property_id: propertyId,
    months_included: uniqueMonths.length,
    total_scheduled: Math.round(sched),
    total_billed: Math.round(billed),
    total_collected: Math.round(collected),
    billing_gap: Math.round(sched - billed),
    collection_rate: billed === 0 ? 0 : Math.round((collected / billed) * 10000) / 100,
  };
}

// ── Tool handlers ───────────────────────────────────────────────
const tools: Record<string, ToolHandler> = {
  // Discovery
  "list-properties": async () => {
    const properties = await loadProperties();
    const summary = properties.map((p) => ({
      property_id: p.property_id,
      name: p.name,
      city: p.city,
      state: p.state,
      type: p.type,
      sqft: p.sqft,
      units: p.units,
      noi_ytd: p.current_noi_ytd,
      noi_budget_ytd: p.budgeted_noi_ytd,
    }));
    return toolResult(JSON.stringify(summary, null, 2));
  },

  "get-property": async (args) => {
    const id = args.property_id as string;
    if (!id) return toolError("property_id required");
    const properties = await loadProperties();
    const p = properties.find((x) => x.property_id === id);
    if (!p) return toolError(`Property ${id} not found`);
    return toolResult(JSON.stringify(p, null, 2));
  },

  // Leases & Revenue
  "get-leases": async (args) => {
    let rows = await loadLeases();
    if (args.property_id) rows = rows.filter((r) => r.property_id === args.property_id);
    if (args.status_filter) rows = rows.filter((r) => r.status === args.status_filter);
    return toolResult(JSON.stringify(rows, null, 2));
  },

  "get-expiring-leases": async (args) => {
    const daysAhead = (args.days_ahead as number | undefined) ?? 90;
    const propertyId = args.property_id as string | undefined;
    const leases = await loadLeases();
    return toolResult(JSON.stringify(
      findExpiringLeases(leases, TODAY, daysAhead, propertyId), null, 2));
  },

  "get-rent-roll": async (args) => {
    const id = args.property_id as string;
    const months = (args.months as number | undefined) ?? 12;
    if (!id) return toolError("property_id required");
    const rentRoll = await loadRentRoll();
    const summary = computeRentRollSummary(rentRoll, id, months);
    const recent = rentRoll
      .filter((r) => r.property_id === id)
      .sort((a, b) => b.month.localeCompare(a.month));
    const uniqMonths = [...new Set(recent.map((r) => r.month))].slice(0, months);
    const rows = recent.filter((r) => uniqMonths.includes(r.month));
    return toolResult(JSON.stringify({ summary, rows }, null, 2));
  },

  "find-unbilled-escalations": async (args) => {
    const propertyId = args.property_id as string | undefined;
    const [leases, rentRoll] = await Promise.all([loadLeases(), loadRentRoll()]);
    return toolResult(JSON.stringify(
      findUnbilledEscalations(leases, rentRoll, propertyId), null, 2));
  },

  // AR & Risk
  "get-ar-aging": async (args) => {
    const propertyId = args.property_id as string | undefined;
    const arAging = await loadArAging();
    const summary = computeArSummary(arAging, propertyId);
    const rows = propertyId
      ? arAging.filter((a) => a.property_id === propertyId)
      : arAging;
    return toolResult(JSON.stringify({ summary, rows }, null, 2));
  },

  "get-tenants-at-risk": async (args) => {
    const threshold = (args.threshold_days as number | undefined) ?? 60;
    const [arAging, leases] = await Promise.all([loadArAging(), loadLeases()]);
    return toolResult(JSON.stringify(
      findTenantsAtRisk(arAging, leases, threshold), null, 2));
  },

  // Financials
  "get-gl-summary": async (args) => {
    const id = args.property_id as string;
    if (!id) return toolError("property_id required");
    const gl = await loadGlTransactions();
    const mine = gl.filter((g) => g.property_id === id);
    const byCategory = new Map<string, number>();
    const byAccount = new Map<string, { name: string; amount: number }>();
    for (const t of mine) {
      byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + t.amount);
      const acct = byAccount.get(t.account_code) ?? { name: t.account_name, amount: 0 };
      acct.amount += t.amount;
      byAccount.set(t.account_code, acct);
    }
    const revenue = byCategory.get("Revenue") ?? 0;
    const opex = Math.abs(byCategory.get("OpEx") ?? 0);
    const summary = {
      property_id: id,
      txn_count: mine.length,
      revenue_ytd: Math.round(revenue),
      opex_ytd: Math.round(opex),
      noi_implied: Math.round(revenue - opex),
      by_account: [...byAccount.entries()].map(([code, v]) => ({
        account_code: code,
        account_name: v.name,
        amount: Math.round(v.amount),
      })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    };
    return toolResult(JSON.stringify(summary, null, 2));
  },

  "get-budget-vs-actual": async (args) => {
    const id = args.property_id as string;
    if (!id) return toolError("property_id required");
    const bva = await loadBudgetVsActual();
    const rows = bva.filter((b) => b.property_id === id);
    const flags = findBudgetFlags(bva, id, 15);
    return toolResult(JSON.stringify({ rows, flags }, null, 2));
  },

  "get-noi-trend": async (args) => {
    const id = args.property_id as string;
    if (!id) return toolError("property_id required");
    const [properties, gl] = await Promise.all([loadProperties(), loadGlTransactions()]);
    const p = properties.find((x) => x.property_id === id);
    if (!p) return toolError(`Property ${id} not found`);
    return toolResult(JSON.stringify(computeNoiTrend(p, gl), null, 2));
  },

  // Operations
  "get-work-orders": async (args) => {
    const id = args.property_id as string;
    const openOnly = (args.open_only as boolean | undefined) ?? false;
    if (!id) return toolError("property_id required");
    let rows = (await loadWorkOrders()).filter((w) => w.property_id === id);
    if (openOnly) rows = rows.filter((r) => r.status !== "closed");
    rows.sort((a, b) => b.estimated_cost - a.estimated_cost);
    return toolResult(JSON.stringify(rows, null, 2));
  },

  "get-capex-summary": async (args) => {
    const id = args.property_id as string;
    if (!id) return toolError("property_id required");
    const wos = await loadWorkOrders();
    return toolResult(JSON.stringify(computeCapexSummary(wos, id), null, 2));
  },

  // Debt & Compliance
  "get-loan-info": async (args) => {
    const id = args.property_id as string;
    if (!id) return toolError("property_id required");
    const loans = await loadLoans();
    const rows = loans.filter((l) => l.property_id === id);
    return toolResult(JSON.stringify(rows, null, 2));
  },

  "get-covenant-status": async (args) => {
    const propertyId = args.property_id as string | undefined;
    const loans = await loadLoans();
    return toolResult(JSON.stringify(findCovenantStatus(loans, propertyId), null, 2));
  },

  "get-cam-status": async (args) => {
    const id = args.property_id as string;
    if (!id) return toolError("property_id required");
    const cams = await loadCamRecs();
    const status = computeCamStatus(cams, id);
    const history = cams.filter((c) => c.property_id === id)
      .sort((a, b) => b.reconciliation_year - a.reconciliation_year);
    return toolResult(JSON.stringify({ status, history }, null, 2));
  },

  "get-compliance": async (args) => {
    const id = args.property_id as string | undefined;
    const daysAhead = (args.days_ahead as number | undefined) ?? 90;
    const compliance = await loadCompliance();
    return toolResult(JSON.stringify(
      findComplianceAlerts(compliance, TODAY, daysAhead, id), null, 2));
  },

  // Actions (draft-only — harness owns approval and delivery)
  "draft-email": async (args) => {
    const recipient = args.recipient as string;
    const subject = args.subject as string;
    const body = args.body as string;
    if (!recipient || !subject || !body)
      return toolError("recipient, subject, body required");
    const draft = [
      `**[DRAFT — NOT SENT]**`,
      ``,
      `**To:** ${recipient}`,
      `**Subject:** ${subject}`,
      ``,
      body,
      ``,
      `---`,
      `Drafted by the Property Intelligence Agent. Review and approve before sending.`,
    ].join("\n");
    return toolResult(draft);
  },

  "draft-memo": async (args) => {
    const title = args.title as string;
    const body = args.body as string;
    const audience = args.audience as string;
    if (!title || !body || !audience)
      return toolError("title, body, audience required");
    const today = TODAY.toISOString().slice(0, 10);
    const memo = [
      `# MEMO — ${title}`,
      ``,
      `**Audience:** ${audience}`,
      `**From:** Accounting`,
      `**Date:** ${today}`,
      ``,
      body,
      ``,
      `---`,
      `**[DRAFT — Review before distribution.]**`,
    ].join("\n");
    return toolResult(memo);
  },

  "create-task": async (args) => {
    const assignee = args.assignee as string;
    const description = args.description as string;
    const dueDate = args.due_date as string;
    const priority = args.priority as string;
    if (!assignee || !description || !dueDate || !priority)
      return toolError("assignee, description, due_date, priority required");
    const task = {
      assignee,
      description,
      due_date: dueDate,
      priority,
      status: "draft",
      created_by: "property-intelligence-agent",
      created_at: TODAY.toISOString().slice(0, 10),
      note: "Draft — submit through the task system to actually assign.",
    };
    return toolResult(JSON.stringify(task, null, 2));
  },

  // Deterministic synthesis tools — run everything server-side so the demo
  // produces the exact same dollar-figure headlines whether or not the LLM
  // is available.
  "generate-daily-briefing": async () => {
    const [properties, leases, rentRoll, arAging, loans, compliance] = await Promise.all([
      loadProperties(), loadLeases(), loadRentRoll(),
      loadArAging(), loadLoans(), loadCompliance(),
    ]);
    return toolResult(buildDailyBriefing({
      properties, leases, rentRoll, arAging, loans, compliance,
    }));
  },

  "generate-property-deep-dive": async (args) => {
    const id = args.property_id as string;
    if (!id) return toolError("property_id required");
    const [properties, leases, rentRoll, arAging, gl, bva, wos, loans, cams, compliance] =
      await Promise.all([
        loadProperties(), loadLeases(), loadRentRoll(), loadArAging(),
        loadGlTransactions(), loadBudgetVsActual(), loadWorkOrders(),
        loadLoans(), loadCamRecs(), loadCompliance(),
      ]);
    const p = properties.find((x) => x.property_id === id);
    if (!p) return toolError(`Property ${id} not found`);
    return toolResult(buildPropertyDeepDive({
      property: p, leases, rentRoll, arAging, gl, bva,
      workOrders: wos, loans, camRecs: cams, compliance,
    }));
  },

  "regenerate-data": async (args) => {
    const seed = (args.seed as number | undefined) ?? 42;
    const data = generateData(seed);
    const { rowCount } = await writeDataSet(DATA_DIR, data);
    return toolResult(JSON.stringify({ seed, rowCount, planted: data.planted }, null, 2));
  },
};

// ── Synthesis helpers ───────────────────────────────────────────

interface BriefingInputs {
  properties: PropertyRow[];
  leases: LeaseRow[];
  rentRoll: RentRollRow[];
  arAging: ArAgingRow[];
  loans: LoanRow[];
  compliance: ComplianceRow[];
}

function buildDailyBriefing(input: BriefingInputs): string {
  const expiring = findExpiringLeases(input.leases, TODAY, 90);
  const tenantsAtRisk = findTenantsAtRisk(input.arAging, input.leases, 60);
  const covenantAlerts = findCovenantStatus(input.loans, undefined, 0.1)
    .filter((c) => c.status !== "healthy");
  const complianceAlerts = findComplianceAlerts(input.compliance, TODAY, 60);
  const unbilled = findUnbilledEscalations(input.leases, input.rentRoll);

  const atRiskDollars = tenantsAtRisk.reduce((s, t) => s + t.total_outstanding, 0);
  const unbilledDollars = unbilled.reduce((s, u) => s + u.delta, 0);

  // Top exceptions assembled from the strongest signal in each bucket.
  type Exception = {
    property_id: string;
    category: string;
    severity: "critical" | "high" | "medium";
    description: string;
    dollar_impact: number;
    source_tool: string;
  };
  const exceptions: Exception[] = [];
  for (const t of tenantsAtRisk) {
    exceptions.push({
      property_id: t.property_id,
      category: "AR / Tenant Risk",
      severity: t.risk_level,
      description: `${t.tenant_name} — ${t.status === "default" ? "IN DEFAULT" : `${t.days_past_due_max}+ days past due`} (${t.lease_id})`,
      dollar_impact: t.total_outstanding,
      source_tool: "get-tenants-at-risk",
    });
  }
  for (const c of covenantAlerts) {
    exceptions.push({
      property_id: c.property_id,
      category: "Debt Covenant",
      severity: c.status === "breach" ? "critical" : "high",
      description: `DSCR ${c.dscr_current.toFixed(2)} vs covenant ${c.dscr_covenant.toFixed(2)} (gap ${c.gap.toFixed(2)})`,
      dollar_impact: 0,
      source_tool: "get-covenant-status",
    });
  }
  for (const u of unbilled) {
    exceptions.push({
      property_id: u.property_id,
      category: "Unbilled Escalation",
      severity: u.delta > 1000 ? "high" : "medium",
      description: `${u.tenant_name} (${u.lease_id}) ${u.month}: scheduled ${$(u.scheduled_rent)} vs billed ${$(u.billed_rent)}`,
      dollar_impact: u.delta,
      source_tool: "find-unbilled-escalations",
    });
  }
  for (const e of expiring) {
    if (e.renewal_option === "no") {
      exceptions.push({
        property_id: e.property_id,
        category: "Lease Expiration Risk",
        severity: e.days_until_end < 60 ? "high" : "medium",
        description: `${e.tenant_name} (${e.lease_id}) expires in ${e.days_until_end} days — no renewal option`,
        dollar_impact: e.annual_rent,
        source_tool: "get-expiring-leases",
      });
    }
  }
  for (const c of complianceAlerts) {
    if (c.days_until_expiry <= 30) {
      exceptions.push({
        property_id: c.property_id,
        category: "Compliance",
        severity: "high",
        description: `${c.item} expires in ${c.days_until_expiry} days`,
        dollar_impact: 0,
        source_tool: "get-compliance",
      });
    }
  }
  exceptions.sort((a, b) => b.dollar_impact - a.dollar_impact);
  const topExceptions = exceptions.slice(0, 8);

  const lines: string[] = [];
  lines.push(`# Daily Portfolio Briefing — ${TODAY.toISOString().slice(0, 10)}`);
  lines.push(``);
  lines.push(`**Headline metrics**`);
  lines.push(`- At-risk receivables (60+ days or default): **${$(atRiskDollars)}**`);
  lines.push(`- Unbilled escalations YTD: **${$(unbilledDollars)}**`);
  lines.push(`- Leases expiring in next 90 days: **${expiring.length}**`);
  lines.push(`- Covenant alerts: **${covenantAlerts.length}**`);
  lines.push(`- Compliance items due < 60 days: **${complianceAlerts.length}**`);
  lines.push(``);

  lines.push(`## 1. Top Exceptions (ranked by dollar impact)`);
  lines.push(`| Property | Category | Severity | Description | $ Impact | Source |`);
  lines.push(`|----------|----------|----------|-------------|---------:|--------|`);
  for (const e of topExceptions) {
    lines.push(`| ${e.property_id} | ${e.category} | ${e.severity} | ${e.description} | ${$(e.dollar_impact)} | \`${e.source_tool}\` |`);
  }
  lines.push(``);

  lines.push(`## 2. Expiring Leases (next 90 days)`);
  if (expiring.length === 0) {
    lines.push(`_No leases expiring in the next 90 days._`);
  } else {
    lines.push(`| Lease | Property | Tenant | Ends | Days | Monthly Rent | Renewal |`);
    lines.push(`|-------|----------|--------|------|-----:|-------------:|---------|`);
    for (const e of expiring) {
      lines.push(`| ${e.lease_id} | ${e.property_id} | ${e.tenant_name} | ${e.lease_end} | ${e.days_until_end} | ${$(e.base_rent_monthly)} | ${e.renewal_option} |`);
    }
  }
  lines.push(``);

  lines.push(`## 3. AR Risk (60+ days or default)`);
  if (tenantsAtRisk.length === 0) {
    lines.push(`_No tenants at risk._`);
  } else {
    lines.push(`| Tenant | Property | Lease | Outstanding | Oldest Bucket | Last Payment | Status |`);
    lines.push(`|--------|----------|-------|------------:|---------------|--------------|--------|`);
    for (const t of tenantsAtRisk) {
      lines.push(`| ${t.tenant_name} | ${t.property_id} | ${t.lease_id} | ${$(t.total_outstanding)} | ${t.oldest_bucket} | ${t.last_payment_date} | ${t.status} |`);
    }
  }
  lines.push(``);

  lines.push(`## 4. Covenant Alerts`);
  if (covenantAlerts.length === 0) {
    lines.push(`_All loans are healthy against their covenants._`);
  } else {
    lines.push(`| Property | Loan | Lender | DSCR | Covenant | Gap | Status |`);
    lines.push(`|----------|------|--------|-----:|---------:|----:|--------|`);
    for (const c of covenantAlerts) {
      lines.push(`| ${c.property_id} | ${c.loan_id} | ${c.lender} | ${c.dscr_current.toFixed(2)} | ${c.dscr_covenant.toFixed(2)} | ${c.gap.toFixed(2)} | ${c.status} |`);
    }
  }
  lines.push(``);

  lines.push(`## 5. Compliance Alerts (< 60 days)`);
  if (complianceAlerts.length === 0) {
    lines.push(`_No compliance items due within 60 days._`);
  } else {
    lines.push(`| Property | Item | Expires | Days | Status | Notes |`);
    lines.push(`|----------|------|---------|-----:|--------|-------|`);
    for (const c of complianceAlerts) {
      lines.push(`| ${c.property_id} | ${c.item} | ${c.expiry_date} | ${c.days_until_expiry} | ${c.status} | ${c.notes} |`);
    }
  }
  lines.push(``);

  // ── Drafted actions ─────────────────────────────────────────
  lines.push(`## 6. Recommended Actions — Drafts`);
  const drafts: string[] = [];

  // One collection email per tenant at risk.
  for (const t of tenantsAtRisk) {
    drafts.push([
      `### Draft Email — Collection: ${t.tenant_name}`,
      `**To:** AP Contact, ${t.tenant_name}`,
      `**Subject:** Past-due balance — ${$(t.total_outstanding)} (${t.lease_id})`,
      ``,
      `Hello — our records show ${$(t.total_outstanding)} outstanding on lease ${t.lease_id}` +
        `, with the oldest bucket in ${t.oldest_bucket}. Most recent payment ${t.last_payment_date}.`,
      `Please confirm remittance plan by end of week or call to discuss. Escalating internally if no response.`,
      ``,
      `_Source: get-tenants-at-risk. [DRAFT — NOT SENT]_`,
    ].join("\n"));
  }

  // One memo per covenant alert.
  for (const c of covenantAlerts) {
    drafts.push([
      `### Draft Memo — Covenant Watch: ${c.property_id}`,
      `**Audience:** CFO, Asset Management`,
      ``,
      `Loan ${c.loan_id} (${c.lender}) on ${c.property_id} currently at DSCR ${c.dscr_current.toFixed(2)}` +
        ` against a covenant of ${c.dscr_covenant.toFixed(2)} — gap of ${c.gap.toFixed(2)}.` +
        ` Recommend early outreach to lender to pre-empt a technical breach and prep a cure plan.`,
      ``,
      `_Source: get-covenant-status. [DRAFT — NOT SENT]_`,
    ].join("\n"));
  }

  // Task per unbilled escalation lease.
  const escalationByLease = new Map<string, { tenant: string; total: number; months: string[] }>();
  for (const u of unbilled) {
    const existing = escalationByLease.get(u.lease_id) ??
      { tenant: u.tenant_name, total: 0, months: [] };
    existing.total += u.delta;
    existing.months.push(u.month);
    escalationByLease.set(u.lease_id, existing);
  }
  for (const [lid, info] of escalationByLease) {
    drafts.push([
      `### Draft Task — Bill Escalation: ${lid}`,
      `**Assignee:** Billing Team`,
      `**Priority:** high`,
      `**Due:** end of week`,
      ``,
      `Lease ${lid} (${info.tenant}) has ${info.months.length} months of uncollected escalation` +
        ` totaling ${$(info.total)}. Issue catch-up invoice and update billing schedule so future` +
        ` months bill at the escalated rate.`,
      ``,
      `_Source: find-unbilled-escalations. [DRAFT — NOT SENT]_`,
    ].join("\n"));
  }

  for (const d of drafts) lines.push(d), lines.push(``);

  lines.push(`---`);
  lines.push(`**Executive summary:** ${$(atRiskDollars + unbilledDollars)} in combined at-risk + unbilled dollars identified` +
    ` across ${new Set(topExceptions.map((e) => e.property_id)).size} properties.` +
    ` ${expiring.length} leases expiring, ${covenantAlerts.length} covenant alerts, ${complianceAlerts.length} compliance items on the clock.`);

  return lines.join("\n");
}

interface DeepDiveInputs {
  property: PropertyRow;
  leases: LeaseRow[];
  rentRoll: RentRollRow[];
  arAging: ArAgingRow[];
  gl: GlTxnRow[];
  bva: BudgetVarianceRow[];
  workOrders: WorkOrderRow[];
  loans: LoanRow[];
  camRecs: CamRecRow[];
  compliance: ComplianceRow[];
}

function buildPropertyDeepDive(input: DeepDiveInputs): string {
  const p = input.property;
  const leases = input.leases.filter((l) => l.property_id === p.property_id);
  const active = leases.filter((l) => l.status === "active" || l.status === "expiring");
  const totalMonthlyRent = active.reduce((s, l) => s + l.base_rent_monthly, 0);
  const expiring = findExpiringLeases(leases, TODAY, 90);
  const arSummary = computeArSummary(input.arAging, p.property_id);
  const tenantsAtRisk = findTenantsAtRisk(
    input.arAging.filter((a) => a.property_id === p.property_id),
    leases, 60,
  );
  const unbilled = findUnbilledEscalations(leases, input.rentRoll, p.property_id);
  const unbilledTotal = unbilled.reduce((s, u) => s + u.delta, 0);
  const noiTrend = computeNoiTrend(p, input.gl);
  const bFlags = findBudgetFlags(input.bva, p.property_id, 15);
  const camStatus = computeCamStatus(input.camRecs, p.property_id);
  const workOrders = input.workOrders.filter((w) => w.property_id === p.property_id);
  const openWOs = workOrders.filter((w) => w.status !== "closed");
  const capex = computeCapexSummary(input.workOrders, p.property_id);
  const loans = input.loans.filter((l) => l.property_id === p.property_id);
  const covenant = findCovenantStatus(input.loans, p.property_id, 0.1);
  const compliance = findComplianceAlerts(input.compliance, TODAY, 90, p.property_id);

  // ── Ranked risks & opportunities ────────────────────────────
  type Ranked = { title: string; dollar_impact: number; reasoning: string; source_tool: string };
  const risks: Ranked[] = [];
  const opportunities: Ranked[] = [];

  // Risks
  for (const t of tenantsAtRisk) {
    risks.push({
      title: `${t.tenant_name} at risk (${t.lease_id})`,
      dollar_impact: t.total_outstanding,
      reasoning: t.status === "default"
        ? `Tenant in default — ${$(t.total_outstanding)} outstanding, oldest ${t.oldest_bucket}.`
        : `${t.days_past_due_max}+ days past due — ${$(t.total_outstanding)} in the ${t.oldest_bucket} bucket.`,
      source_tool: "get-tenants-at-risk",
    });
  }
  for (const c of covenant) {
    if (c.status === "healthy") continue;
    risks.push({
      title: `Covenant ${c.status} on ${c.loan_id}`,
      // Surface the annual loan service impact by proxy: 10bps cushion × current balance.
      dollar_impact: Math.round((loans.find((l) => l.loan_id === c.loan_id)?.current_balance ?? 0) * 0.001),
      reasoning: `DSCR ${c.dscr_current.toFixed(2)} vs covenant ${c.dscr_covenant.toFixed(2)} (gap ${c.gap.toFixed(2)}). Negotiating waiver early is cheaper than a breach.`,
      source_tool: "get-covenant-status",
    });
  }
  for (const flag of bFlags) {
    if (flag.direction !== "over") continue;
    risks.push({
      title: `${flag.category} ${pct(flag.variance_pct)} vs budget`,
      dollar_impact: flag.variance_dollars,
      reasoning: `${flag.category} at ${$(flag.actual_ytd)} YTD vs ${$(flag.budget_ytd)} budget — investigate root cause before YE.`,
      source_tool: "get-budget-vs-actual",
    });
  }
  if (noiTrend.noi_variance_pct < -10) {
    risks.push({
      title: `NOI ${pct(noiTrend.noi_variance_pct)} vs budget`,
      dollar_impact: -noiTrend.noi_variance_dollars,
      reasoning: `NOI YTD ${$(noiTrend.noi_ytd)} vs budget ${$(noiTrend.noi_budget_ytd)}. Combination of revenue softness and OpEx creep drives the miss.`,
      source_tool: "get-noi-trend",
    });
  }
  for (const e of expiring) {
    if (e.renewal_option === "no" || e.renewal_option === "yes") {
      risks.push({
        title: `${e.tenant_name} (${e.lease_id}) expiring ${e.days_until_end}d`,
        dollar_impact: e.annual_rent,
        reasoning: `Lease ends ${e.lease_end}. Renewal option: ${e.renewal_option}. If vacated, ${$(e.annual_rent)}/yr exposure plus TI + downtime.`,
        source_tool: "get-expiring-leases",
      });
    }
  }
  for (const c of compliance) {
    if (c.days_until_expiry <= 45) {
      risks.push({
        title: `${c.item} expiring ${c.days_until_expiry}d`,
        dollar_impact: 0,
        reasoning: `${c.item} expires ${c.expiry_date}. ${c.notes || "Renewal must be executed to avoid coverage lapse."}`,
        source_tool: "get-compliance",
      });
    }
  }

  // Opportunities
  if (unbilledTotal > 0) {
    opportunities.push({
      title: `Recover ${$(unbilledTotal)} in unbilled escalations`,
      dollar_impact: unbilledTotal,
      reasoning: `${unbilled.length} months across ${new Set(unbilled.map((u) => u.lease_id)).size} lease(s) where scheduled rent exceeded billed rent. Issue catch-up invoices and update the billing schedule.`,
      source_tool: "find-unbilled-escalations",
    });
  }
  if (camStatus && camStatus.under_recovered && !camStatus.true_up_issued) {
    opportunities.push({
      title: `Issue CAM true-up for ${camStatus.latest_year}`,
      dollar_impact: -camStatus.variance,
      reasoning: `Estimated recovery ${$(camStatus.estimated_recovery)} exceeds billed ${$(camStatus.billed_recovery)} by ${$(-camStatus.variance)}. True-up not issued — revenue recognition risk plus cash lost if not billed this cycle.`,
      source_tool: "get-cam-status",
    });
  }
  if (expiring.length > 0) {
    const total = expiring.reduce((s, e) => s + e.annual_rent, 0);
    opportunities.push({
      title: `Early renewal negotiation — ${expiring.length} lease(s)`,
      dollar_impact: total,
      reasoning: `Approach ${expiring.length} tenant(s) expiring inside 90 days with a bump-and-extend offer. Known cashflow + lower leasing costs vs releasing.`,
      source_tool: "get-expiring-leases",
    });
  }

  risks.sort((a, b) => b.dollar_impact - a.dollar_impact);
  opportunities.sort((a, b) => b.dollar_impact - a.dollar_impact);

  // ── Drafted actions ─────────────────────────────────────────
  const actions: string[] = [];
  if (unbilledTotal > 0) {
    actions.push([
      `### Draft Task — Catch-up Billing: ${p.name}`,
      `**Assignee:** Billing Team`,
      `**Priority:** high`,
      `**Due:** end of week`,
      ``,
      `Issue escalation catch-up invoices totaling ${$(unbilledTotal)} across lease(s):` +
        ` ${[...new Set(unbilled.map((u) => u.lease_id))].join(", ")}. Update billing schedule.`,
      ``,
      `_Source: find-unbilled-escalations. [DRAFT — NOT SENT]_`,
    ].join("\n"));
  }
  if (camStatus && camStatus.under_recovered && !camStatus.true_up_issued) {
    actions.push([
      `### Draft Memo — CAM ${camStatus.latest_year} True-Up: ${p.name}`,
      `**Audience:** Property Accounting, Asset Manager`,
      ``,
      `CAM ${camStatus.latest_year} under-recovered by ${$(-camStatus.variance)} (estimated ${$(camStatus.estimated_recovery)},` +
        ` billed ${$(camStatus.billed_recovery)}). Recommend issuing true-up statements to tenants and booking` +
        ` the accrual in current period.`,
      ``,
      `_Source: get-cam-status. [DRAFT — NOT SENT]_`,
    ].join("\n"));
  }
  for (const t of tenantsAtRisk) {
    actions.push([
      `### Draft Email — Collection: ${t.tenant_name}`,
      `**To:** ${t.tenant_name} (AP contact)`,
      `**Subject:** Past-due balance — ${$(t.total_outstanding)} (${t.lease_id})`,
      ``,
      `Hello — ${$(t.total_outstanding)} outstanding on lease ${t.lease_id}, oldest bucket ${t.oldest_bucket}.` +
        ` Please confirm remittance plan by end of week.`,
      ``,
      `_Source: get-tenants-at-risk. [DRAFT — NOT SENT]_`,
    ].join("\n"));
  }
  for (const c of covenant) {
    if (c.status === "healthy") continue;
    actions.push([
      `### Draft Memo — Covenant Watch: ${c.loan_id}`,
      `**Audience:** CFO, Asset Management`,
      ``,
      `DSCR ${c.dscr_current.toFixed(2)} vs covenant ${c.dscr_covenant.toFixed(2)} on ${c.loan_id} (${c.lender}).` +
        ` Proactive outreach recommended; prep trailing-12 package.`,
      ``,
      `_Source: get-covenant-status. [DRAFT — NOT SENT]_`,
    ].join("\n"));
  }
  for (const e of expiring) {
    actions.push([
      `### Draft Task — Renewal Outreach: ${e.tenant_name}`,
      `**Assignee:** Leasing Team`,
      `**Priority:** ${e.days_until_end < 60 ? "critical" : "high"}`,
      `**Due:** within 14 days`,
      ``,
      `${e.tenant_name} (${e.lease_id}) lease ends ${e.lease_end} (${e.days_until_end}d).` +
        ` Renewal option status: ${e.renewal_option}. Open a renewal conversation; target bump-and-extend.`,
      ``,
      `_Source: get-expiring-leases. [DRAFT — NOT SENT]_`,
    ].join("\n"));
  }
  for (const c of compliance) {
    if (c.days_until_expiry > 45) continue;
    actions.push([
      `### Draft Task — Compliance Renewal: ${c.item}`,
      `**Assignee:** Property Manager`,
      `**Priority:** ${c.days_until_expiry <= 30 ? "critical" : "high"}`,
      `**Due:** ${c.expiry_date}`,
      ``,
      `${c.item} at ${p.name} expires ${c.expiry_date} (${c.days_until_expiry}d). ${c.notes}`,
      ``,
      `_Source: get-compliance. [DRAFT — NOT SENT]_`,
    ].join("\n"));
  }

  const lines: string[] = [];
  lines.push(`# Property Deep Dive — ${p.name} (${p.property_id})`);
  lines.push(``);

  lines.push(`## Overview`);
  lines.push(`- **Address:** ${p.address}, ${p.city}, ${p.state}`);
  lines.push(`- **Type:** ${p.type} · **SqFt:** ${p.sqft.toLocaleString()} · **Units:** ${p.units}`);
  lines.push(`- **Book value:** ${$(p.book_value)} · **Acquired:** ${p.acquisition_date}`);
  lines.push(``);

  lines.push(`## Lease Summary`);
  lines.push(`- Leases on file: **${leases.length}** (${active.length} active/expiring)`);
  lines.push(`- Total base rent (monthly): **${$(totalMonthlyRent)}** (annual ${$(totalMonthlyRent * 12)})`);
  lines.push(``);

  lines.push(`## Expiring Lease Risk (next 90 days)`);
  if (expiring.length === 0) {
    lines.push(`_None._`);
  } else {
    lines.push(`| Lease | Tenant | Ends | Days | Annual Rent | Renewal |`);
    lines.push(`|-------|--------|------|-----:|------------:|---------|`);
    for (const e of expiring) {
      lines.push(`| ${e.lease_id} | ${e.tenant_name} | ${e.lease_end} | ${e.days_until_end} | ${$(e.annual_rent)} | ${e.renewal_option} |`);
    }
  }
  lines.push(``);

  lines.push(`## AR & Tenant Risk`);
  lines.push(`- Total outstanding: **${$(arSummary.total_outstanding)}**`);
  lines.push(`- Current / 30 / 60 / 90+: ${$(arSummary.current)} / ${$(arSummary.days_30)} / ${$(arSummary.days_60)} / ${$(arSummary.days_90_plus)}`);
  lines.push(`- At-risk (60+ / default): **${$(arSummary.at_risk_dollars + tenantsAtRisk.filter((t) => t.status === "default").reduce((s, t) => s + t.total_outstanding, 0))}**`);
  if (tenantsAtRisk.length > 0) {
    lines.push(``);
    lines.push(`| Tenant | Lease | Outstanding | Oldest | Last Payment | Status |`);
    lines.push(`|--------|-------|------------:|--------|--------------|--------|`);
    for (const t of tenantsAtRisk) {
      lines.push(`| ${t.tenant_name} | ${t.lease_id} | ${$(t.total_outstanding)} | ${t.oldest_bucket} | ${t.last_payment_date} | ${t.status} |`);
    }
  }
  lines.push(``);

  lines.push(`## Financial Performance`);
  lines.push(`- NOI YTD: **${$(noiTrend.noi_ytd)}** vs budget ${$(noiTrend.noi_budget_ytd)} → **${pct(noiTrend.noi_variance_pct)}** (${$(noiTrend.noi_variance_dollars)})`);
  if (bFlags.length > 0) {
    lines.push(``);
    lines.push(`**Budget variances > 15%:**`);
    lines.push(`| Category | Budget YTD | Actual YTD | Variance $ | Variance % |`);
    lines.push(`|----------|-----------:|-----------:|-----------:|-----------:|`);
    for (const f of bFlags) {
      lines.push(`| ${f.category} | ${$(f.budget_ytd)} | ${$(f.actual_ytd)} | ${$(f.variance_dollars)} | ${pct(f.variance_pct)} |`);
    }
  } else {
    lines.push(`- No categories variant > 15% from budget.`);
  }
  if (unbilled.length > 0) {
    lines.push(``);
    lines.push(`**Unbilled escalations:** ${$(unbilledTotal)} across ${new Set(unbilled.map((u) => u.lease_id)).size} lease(s).`);
  }
  lines.push(``);

  lines.push(`## CAM Status`);
  if (camStatus) {
    lines.push(`- Latest year: **${camStatus.latest_year}** (${camStatus.status})`);
    lines.push(`- Estimated recovery ${$(camStatus.estimated_recovery)} vs billed ${$(camStatus.billed_recovery)} → variance **${$(camStatus.variance)}**`);
    if (camStatus.under_recovered) {
      lines.push(`- ⚠️ Under-recovered by ${$(-camStatus.variance)}${camStatus.true_up_issued ? " (true-up issued)" : " — true-up NOT yet issued"}.`);
    }
  } else {
    lines.push(`- No CAM reconciliations on file.`);
  }
  lines.push(``);

  lines.push(`## Operations`);
  lines.push(`- Work orders: **${workOrders.length}** total (${openWOs.length} open/in-progress)`);
  lines.push(`- Capex: **${$(capex.total_estimated_capex)}** estimated, ${$(capex.total_actual_capex)} actual-to-date, ${capex.open_capex_count} open`);
  if (capex.largest_open_wo) {
    const w = capex.largest_open_wo;
    lines.push(`- Largest open capex: **${w.wo_id}** — ${w.description} (${$(w.estimated_cost)})`);
  }
  lines.push(``);

  lines.push(`## Debt & Covenants`);
  if (loans.length === 0) {
    lines.push(`_No loans on file._`);
  } else {
    for (const l of loans) {
      const c = covenant.find((x) => x.loan_id === l.loan_id);
      lines.push(`- **${l.loan_id}** (${l.lender}) — balance ${$(l.current_balance)} @ ${(l.rate * 100).toFixed(2)}%, matures ${l.maturity_date}`);
      lines.push(`  - DSCR **${l.dscr_current.toFixed(2)}** vs covenant ${l.dscr_covenant.toFixed(2)} (gap ${l.dscr_current - l.dscr_covenant > 0 ? "+" : ""}${(l.dscr_current - l.dscr_covenant).toFixed(2)}) — ${c?.status ?? "healthy"}`);
    }
  }
  lines.push(``);

  lines.push(`## Compliance (next 90 days)`);
  if (compliance.length === 0) {
    lines.push(`_No compliance items due in the next 90 days._`);
  } else {
    lines.push(`| Item | Expires | Days | Status | Notes |`);
    lines.push(`|------|---------|-----:|--------|-------|`);
    for (const c of compliance) {
      lines.push(`| ${c.item} | ${c.expiry_date} | ${c.days_until_expiry} | ${c.status} | ${c.notes} |`);
    }
  }
  lines.push(``);

  lines.push(`## Top Risks (ranked by dollar impact)`);
  if (risks.length === 0) {
    lines.push(`_No material risks identified._`);
  } else {
    risks.slice(0, 8).forEach((r, i) => {
      lines.push(`${i + 1}. **${r.title}** — ${$(r.dollar_impact)}`);
      lines.push(`   ${r.reasoning}`);
      lines.push(`   _Source: \`${r.source_tool}\`_`);
    });
  }
  lines.push(``);

  lines.push(`## Top Opportunities (ranked by dollar impact)`);
  if (opportunities.length === 0) {
    lines.push(`_No material opportunities identified._`);
  } else {
    opportunities.slice(0, 5).forEach((o, i) => {
      lines.push(`${i + 1}. **${o.title}** — ${$(o.dollar_impact)}`);
      lines.push(`   ${o.reasoning}`);
      lines.push(`   _Source: \`${o.source_tool}\`_`);
    });
  }
  lines.push(``);

  lines.push(`## Recommended Actions — Drafts`);
  if (actions.length === 0) {
    lines.push(`_No actions drafted — property clean._`);
  } else {
    for (const a of actions) {
      lines.push(a);
      lines.push(``);
    }
  }

  lines.push(`---`);
  const topRisk = risks[0]?.dollar_impact ?? 0;
  const topOpp = opportunities[0]?.dollar_impact ?? 0;
  lines.push(`**Executive summary:** ${p.name} carries **${risks.length}** ranked risks (top: ${$(topRisk)}) and **${opportunities.length}** opportunities (top: ${$(topOpp)}). ${actions.length} drafted actions ready for approval.`);

  return lines.join("\n");
}

// ── JSON-RPC adapter (exported for tests + direct callers) ──────
export async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  if (req.method !== "tools/call") {
    return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Unknown method: ${req.method}` } };
  }
  const name = (req.params?.name as string) ?? "";
  const args = (req.params?.arguments as Record<string, unknown>) ?? {};
  const handler = tools[name];
  if (!handler) {
    return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Unknown tool: ${name}` } };
  }
  try {
    const result: ToolCallResult = await handler(args);
    if (result.isError) {
      const first = result.content[0];
      const msg = first && first.type === "text" ? first.text : "Tool error";
      return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: msg } };
    }
    return { jsonrpc: "2.0", id: req.id, result };
  } catch (err) {
    if (err instanceof JsonRpcError) {
      return { jsonrpc: "2.0", id: req.id, error: { code: err.code, message: err.message } };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: msg } };
  }
}

// Expose for tests.
export { tools };

// Production wiring — gated on import.meta.main so test files can import
// this module without stealing stdin.
if (import.meta.main) {
  const ch = getChannel();
  createToolDispatcher(tools);
  ch.start();
}
