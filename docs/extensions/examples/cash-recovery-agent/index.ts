#!/usr/bin/env bun
// cash-recovery-agent — tool server.
//
// Reads CSVs shipped alongside this extension (./data/*.csv) and exposes
// the analytical tools the Morning Briefing agent calls. Follows the
// same JSON-RPC dispatcher pattern as task-stack: declare a handler map,
// register it with `createToolDispatcher`, let the SDK's channel run the
// stdin loop.
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
  type ProjectRow,
  type CostRow,
  type ChangeOrderRow,
  type BillingRow,
  type ArRow,
  type SubcontractRow,
  type TimecardRow,
} from "./generate-data";

// ── Paths ───────────────────────────────────────────────────────
const EXT_DIR = import.meta.dir;
const DATA_DIR = join(EXT_DIR, "data");

// ── CSV parser (no external deps) ───────────────────────────────
//
// Handles quoted fields with embedded commas and escaped quotes. The
// generator only produces simple cells, but the parser stays honest so
// hand-edited CSVs won't silently corrupt.
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

// ── Row coercion — strict: CSV is strings, domain is numbers ────
const num = (v: string | undefined, fallback = 0): number => {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v: string | undefined): boolean => v === "true" || v === "1";

async function loadProjects(): Promise<ProjectRow[]> {
  return (await readCsv("projects.csv")).map((r) => ({
    project_id: r.project_id!,
    name: r.name!,
    customer: r.customer!,
    contract_value: num(r.contract_value),
    start_date: r.start_date!,
    end_date: r.end_date!,
    percent_complete: num(r.percent_complete),
    status: r.status!,
    pm_name: r.pm_name!,
    pm_email: r.pm_email!,
  }));
}
async function loadCostLedger(): Promise<CostRow[]> {
  return (await readCsv("cost_ledger.csv")).map((r) => ({
    entry_id: r.entry_id!, project_id: r.project_id!, date: r.date!,
    cost_code: r.cost_code!, category: r.category!, vendor: r.vendor!,
    amount: num(r.amount), description: r.description!,
  }));
}
async function loadChangeOrders(): Promise<ChangeOrderRow[]> {
  return (await readCsv("change_orders.csv")).map((r) => ({
    co_id: r.co_id!, project_id: r.project_id!,
    description: r.description!, amount: num(r.amount),
    status: (r.status as ChangeOrderRow["status"]) ?? "draft",
    approved_date: r.approved_date ?? "",
    billed_flag: bool(r.billed_flag),
    billed_date: r.billed_date ?? "",
  }));
}
async function loadBillings(): Promise<BillingRow[]> {
  return (await readCsv("billings.csv")).map((r) => ({
    invoice_id: r.invoice_id!, project_id: r.project_id!,
    invoice_date: r.invoice_date!, amount: num(r.amount),
    retainage_withheld: num(r.retainage_withheld),
    status: (r.status as BillingRow["status"]) ?? "open",
    due_date: r.due_date!, paid_date: r.paid_date ?? "",
  }));
}
async function loadArAging(): Promise<ArRow[]> {
  return (await readCsv("ar_aging.csv")).map((r) => ({
    customer: r.customer!, invoice_id: r.invoice_id!, project_id: r.project_id!,
    amount: num(r.amount), days_outstanding: num(r.days_outstanding),
    bucket: r.bucket!,
  }));
}
async function loadSubcontracts(): Promise<SubcontractRow[]> {
  return (await readCsv("subcontracts.csv")).map((r) => ({
    sub_id: r.sub_id!, project_id: r.project_id!,
    subcontractor: r.subcontractor!,
    committed_value: num(r.committed_value),
    billed_to_date: num(r.billed_to_date),
    retainage_held: num(r.retainage_held),
    compliance_doc_expires: r.compliance_doc_expires!,
  }));
}
// loadTimecards is exported for downstream tools that want labor-cost
// analysis; not used by the built-in briefing tools.
export async function loadTimecards(): Promise<TimecardRow[]> {
  return (await readCsv("timecards.csv")).map((r) => ({
    timecard_id: r.timecard_id!, project_id: r.project_id!,
    employee: r.employee!, date: r.date!, hours: num(r.hours),
    cost_code: r.cost_code!, approved_flag: bool(r.approved_flag),
  }));
}

// ── Pure-logic exports (for unit tests) ─────────────────────────

export function computeUnderbilling(
  p: ProjectRow,
  costs: CostRow[],
  billings: BillingRow[],
): {
  project_id: string;
  cost_to_date: number;
  expected_billing: number;
  actual_billing: number;
  underbilled_amount: number;
} {
  const cost_to_date = costs
    .filter((c) => c.project_id === p.project_id)
    .reduce((s, c) => s + c.amount, 0);
  const expected_billing = Math.round(p.contract_value * p.percent_complete);
  const actual_billing = billings
    .filter((b) => b.project_id === p.project_id)
    .reduce((s, b) => s + b.amount, 0);
  return {
    project_id: p.project_id,
    cost_to_date: Math.round(cost_to_date),
    expected_billing,
    actual_billing: Math.round(actual_billing),
    underbilled_amount: Math.round(expected_billing - actual_billing),
  };
}

export function retainageReleaseCandidates(
  projects: ProjectRow[],
  subs: SubcontractRow[],
  minPercentComplete = 0.95,
): Array<{
  project_id: string;
  name: string;
  percent_complete: number;
  retainage_held: number;
  subcontractors: string[];
}> {
  return projects
    .filter((p) => p.percent_complete >= minPercentComplete)
    .map((p) => {
      const theirs = subs.filter((s) => s.project_id === p.project_id);
      return {
        project_id: p.project_id,
        name: p.name,
        percent_complete: p.percent_complete,
        retainage_held: theirs.reduce((s, x) => s + x.retainage_held, 0),
        subcontractors: theirs.map((s) => s.subcontractor),
      };
    })
    .filter((x) => x.retainage_held > 0)
    .sort((a, b) => b.retainage_held - a.retainage_held);
}

export function detectDuplicateInvoices(
  billings: BillingRow[],
  windowDays = 7,
  amountTolerance = 100,
): Array<{
  invoice_a: string;
  invoice_b: string;
  project_id: string;
  amount_a: number;
  amount_b: number;
  date_a: string;
  date_b: string;
  confidence: "high" | "medium";
}> {
  const out: Array<ReturnType<typeof detectDuplicateInvoices>[number]> = [];
  const ms = windowDays * 24 * 3600 * 1000;
  for (let i = 0; i < billings.length; i++) {
    for (let j = i + 1; j < billings.length; j++) {
      const a = billings[i]!, b = billings[j]!;
      if (a.project_id !== b.project_id) continue;
      if (Math.abs(a.amount - b.amount) > amountTolerance) continue;
      const da = new Date(a.invoice_date).getTime();
      const db = new Date(b.invoice_date).getTime();
      if (!Number.isFinite(da) || !Number.isFinite(db)) continue;
      if (Math.abs(da - db) > ms) continue;
      const tightAmount = Math.abs(a.amount - b.amount) < 50;
      const tightDate = Math.abs(da - db) <= 3 * 24 * 3600 * 1000;
      out.push({
        invoice_a: a.invoice_id, invoice_b: b.invoice_id,
        project_id: a.project_id,
        amount_a: a.amount, amount_b: b.amount,
        date_a: a.invoice_date, date_b: b.invoice_date,
        confidence: tightAmount && tightDate ? "high" : "medium",
      });
    }
  }
  return out;
}

// ── Formatting helpers ──────────────────────────────────────────
const $ = (n: number): string =>
  "$" + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// ── Tool handlers ───────────────────────────────────────────────
const tools: Record<string, ToolHandler> = {
  "list-projects": async () => {
    const projects = await loadProjects();
    return toolResult(JSON.stringify(projects, null, 2));
  },

  "get-project-details": async (args) => {
    const id = args.project_id as string;
    if (!id) return toolError("project_id required");
    const projects = await loadProjects();
    const p = projects.find((x) => x.project_id === id);
    if (!p) return toolError(`Project ${id} not found`);
    return toolResult(JSON.stringify(p, null, 2));
  },

  "get-cost-ledger": async (args) => {
    let rows = await loadCostLedger();
    if (args.project_id) rows = rows.filter((r) => r.project_id === args.project_id);
    if (args.start_date) rows = rows.filter((r) => r.date >= (args.start_date as string));
    if (args.end_date)   rows = rows.filter((r) => r.date <= (args.end_date as string));
    return toolResult(JSON.stringify(rows, null, 2));
  },

  "get-change-orders": async (args) => {
    let rows = await loadChangeOrders();
    if (args.project_id)   rows = rows.filter((r) => r.project_id === args.project_id);
    if (args.status)       rows = rows.filter((r) => r.status === args.status);
    if (args.billed_flag !== undefined)
      rows = rows.filter((r) => r.billed_flag === (args.billed_flag as boolean));
    return toolResult(JSON.stringify(rows, null, 2));
  },

  "get-billings": async (args) => {
    let rows = await loadBillings();
    if (args.project_id) rows = rows.filter((r) => r.project_id === args.project_id);
    if (args.status)     rows = rows.filter((r) => r.status === args.status);
    return toolResult(JSON.stringify(rows, null, 2));
  },

  "get-ar-aging": async (args) => {
    let rows = await loadArAging();
    const minDays = args.min_days as number | undefined;
    const minAmt = args.min_amount as number | undefined;
    if (minDays !== undefined) rows = rows.filter((r) => r.days_outstanding >= minDays);
    if (minAmt !== undefined) rows = rows.filter((r) => r.amount >= minAmt);
    rows.sort((a, b) => b.amount - a.amount);
    return toolResult(JSON.stringify(rows, null, 2));
  },

  "get-subcontracts": async (args) => {
    let rows = await loadSubcontracts();
    if (args.project_id) rows = rows.filter((r) => r.project_id === args.project_id);
    return toolResult(JSON.stringify(rows, null, 2));
  },

  "compute-underbilling": async (args) => {
    const id = args.project_id as string;
    if (!id) return toolError("project_id required");
    const [projects, costs, billings] = await Promise.all([
      loadProjects(), loadCostLedger(), loadBillings(),
    ]);
    const p = projects.find((x) => x.project_id === id);
    if (!p) return toolError(`Project ${id} not found`);
    return toolResult(JSON.stringify(computeUnderbilling(p, costs, billings), null, 2));
  },

  "find-retainage-release-candidates": async (args) => {
    const min = (args.min_percent_complete as number | undefined) ?? 0.95;
    const [projects, subs] = await Promise.all([loadProjects(), loadSubcontracts()]);
    return toolResult(JSON.stringify(retainageReleaseCandidates(projects, subs, min), null, 2));
  },

  "detect-duplicate-invoices": async () => {
    const billings = await loadBillings();
    return toolResult(JSON.stringify(detectDuplicateInvoices(billings), null, 2));
  },

  "draft-billing-memo": async (args) => {
    const id = args.project_id as string;
    const items = args.items as Array<{ description: string; amount: number }>;
    if (!id || !items) return toolError("project_id and items required");
    const projects = await loadProjects();
    const p = projects.find((x) => x.project_id === id);
    if (!p) return toolError(`Project ${id} not found`);
    const total = items.reduce((s, i) => s + i.amount, 0);
    const today = new Date().toISOString().slice(0, 10);
    const memo = [
      `# Billing Memo — ${p.name} (${p.project_id})`,
      ``,
      `**To:** ${p.pm_name} <${p.pm_email}>`,
      `**From:** Accounting`,
      `**Date:** ${today}`,
      `**Re:** Invoiceable items pending progress billing`,
      ``,
      `Please confirm the following for inclusion on the next pay application:`,
      ``,
      `| Item | Amount |`,
      `|------|-------:|`,
      ...items.map((i) => `| ${i.description} | ${$(i.amount)} |`),
      `| **Total** | **${$(total)}** |`,
      ``,
      `Reply by EOD or flag any items to hold. Customer: ${p.customer}.`,
    ].join("\n");
    return toolResult(memo);
  },

  "draft-collection-email": async (args) => {
    const customer = args.customer as string;
    const invoices = args.invoices as Array<{
      invoice_id: string; amount: number; days_outstanding: number;
    }>;
    if (!customer || !invoices) return toolError("customer and invoices required");
    const total = invoices.reduce((s, i) => s + i.amount, 0);
    const maxDays = Math.max(...invoices.map((i) => i.days_outstanding));
    const email = [
      `# Email Draft — Collection Follow-up`,
      ``,
      `**To:** Accounts Payable <ap@${customer.toLowerCase().replace(/[^a-z0-9]+/g, "")}.example>`,
      `**Subject:** Past-due invoices — ${customer} (${$(total)} outstanding)`,
      ``,
      `Hello,`,
      ``,
      `Our records show the following invoices are past their due date` +
        (maxDays >= 90 ? ", some now materially aged" : "") + `:`,
      ``,
      `| Invoice | Amount | Days Past Due |`,
      `|---------|-------:|--------------:|`,
      ...invoices.map((i) =>
        `| ${i.invoice_id} | ${$(i.amount)} | ${i.days_outstanding} |`,
      ),
      `| **Total** | **${$(total)}** | |`,
      ``,
      `Please confirm the status of these payments by end of week. If there` +
        ` is a dispute or retention issue, let us know which PO it relates to` +
        ` and we'll route it. Otherwise, please process remittance at your` +
        ` earliest convenience.`,
      ``,
      `Thank you,`,
      `Accounting — BuildCo`,
    ].join("\n");
    return toolResult(email);
  },

  "draft-pm-message": async (args) => {
    const id = args.project_id as string;
    const issue = args.issue as string;
    const action = args.recommended_action as string;
    if (!id || !issue || !action)
      return toolError("project_id, issue, recommended_action required");
    const projects = await loadProjects();
    const p = projects.find((x) => x.project_id === id);
    if (!p) return toolError(`Project ${id} not found`);
    const msg = [
      `**Slack DM → ${p.pm_name} (${p.name})**`,
      ``,
      `Hey ${p.pm_name.split(" ")[0]} — flagging something from this morning's cash review on ${p.project_id}:`,
      ``,
      `> ${issue}`,
      ``,
      `Suggested next step: ${action}`,
      ``,
      `Can you confirm by EOD? Thanks.`,
    ].join("\n");
    return toolResult(msg);
  },

  "regenerate-data": async (args) => {
    const seed = (args.seed as number | undefined) ?? 42;
    const data = generateData(seed);
    const { rowCount } = await writeDataSet(DATA_DIR, data);
    return toolResult(JSON.stringify({ seed, rowCount, planted: data.planted }, null, 2));
  },

  "generate-morning-briefing": async () => {
    const [projects, costs, changeOrders, billings, arAging, subs] = await Promise.all([
      loadProjects(), loadCostLedger(), loadChangeOrders(),
      loadBillings(), loadArAging(), loadSubcontracts(),
    ]);

    // Section 1 — unbilled approved COs
    const unbilledCOs = changeOrders
      .filter((c) => c.status === "approved" && !c.billed_flag)
      .sort((a, b) => b.amount - a.amount);
    const coTotal = unbilledCOs.reduce((s, c) => s + c.amount, 0);

    // Section 2 — underbilled projects (> $25K underbilled)
    const underbilled = projects
      .map((p) => computeUnderbilling(p, costs, billings))
      .filter((u) => u.underbilled_amount > 25_000)
      .sort((a, b) => b.underbilled_amount - a.underbilled_amount);
    const underbilledTotal = underbilled.reduce((s, u) => s + u.underbilled_amount, 0);

    // Section 3 — retainage release
    const retainage = retainageReleaseCandidates(projects, subs, 0.95);
    const retainageTotal = retainage.reduce((s, r) => s + r.retainage_held, 0);

    // Section 4 — AR aging > 60 days
    const aged = arAging
      .filter((a) => a.days_outstanding >= 60)
      .sort((a, b) => b.amount - a.amount);
    const agedTotal = aged.reduce((s, a) => s + a.amount, 0);

    // Section 5 — duplicates
    const dupes = detectDuplicateInvoices(billings);

    const grandTotal = coTotal + underbilledTotal + retainageTotal + agedTotal;
    const touchedIds = new Set<string>();
    for (const c of unbilledCOs) touchedIds.add(c.project_id);
    for (const u of underbilled) touchedIds.add(u.project_id);
    for (const r of retainage) touchedIds.add(r.project_id);
    for (const a of aged) touchedIds.add(a.project_id);

    // ── Section 6 — drafted actions ─────────────────────────
    const memos: string[] = [];
    const emails: string[] = [];
    const pmMessages: string[] = [];

    // Group unbilled COs by project, one memo per project.
    const coByProject = new Map<string, ChangeOrderRow[]>();
    for (const co of unbilledCOs) {
      const list = coByProject.get(co.project_id) ?? [];
      list.push(co);
      coByProject.set(co.project_id, list);
    }
    for (const [pid, cos] of coByProject) {
      const p = projects.find((x) => x.project_id === pid)!;
      const items = cos.map((c) => ({
        description: `${c.co_id}: ${c.description}`, amount: c.amount,
      }));
      const total = items.reduce((s, i) => s + i.amount, 0);
      memos.push([
        `### Billing Memo — ${p.name} (${pid})`,
        ``,
        `**To:** ${p.pm_name} · **Customer:** ${p.customer}`,
        ``,
        `| Item | Amount |`,
        `|------|-------:|`,
        ...items.map((i) => `| ${i.description} | ${$(i.amount)} |`),
        `| **Total** | **${$(total)}** |`,
      ].join("\n"));
    }

    // One collection email per customer with overdue balances.
    const arByCustomer = new Map<string, ArRow[]>();
    for (const a of aged) {
      const list = arByCustomer.get(a.customer) ?? [];
      list.push(a);
      arByCustomer.set(a.customer, list);
    }
    for (const [customer, rows] of arByCustomer) {
      const total = rows.reduce((s, r) => s + r.amount, 0);
      emails.push([
        `### Collection Email — ${customer}`,
        `**Subject:** Past-due invoices — ${$(total)} outstanding`,
        ``,
        `| Invoice | Amount | Days Past Due |`,
        `|---------|-------:|--------------:|`,
        ...rows.map((r) => `| ${r.invoice_id} | ${$(r.amount)} | ${r.days_outstanding} |`),
        `| **Total** | **${$(total)}** | |`,
      ].join("\n"));
    }

    // PM message for each underbilled project.
    for (const u of underbilled) {
      const p = projects.find((x) => x.project_id === u.project_id)!;
      pmMessages.push([
        `### PM Message — ${p.name} (${u.project_id}) → ${p.pm_name}`,
        ``,
        `> We're underbilled ${$(u.underbilled_amount)} against % complete` +
          ` (${Math.round(p.percent_complete * 100)}%). Expected ${$(u.expected_billing)},` +
          ` actual ${$(u.actual_billing)}.`,
        ``,
        `Suggested next step: walk the field with the estimator, lock down a` +
          ` revised SOV, and get the next pay app out this week.`,
      ].join("\n"));
    }

    // PM message on retainage release candidates.
    for (const r of retainage) {
      const p = projects.find((x) => x.project_id === r.project_id)!;
      pmMessages.push([
        `### PM Message — ${p.name} (${r.project_id}) → ${p.pm_name}`,
        ``,
        `> We're at ${Math.round(r.percent_complete * 100)}% complete and still` +
          ` holding ${$(r.retainage_held)} in retainage. Punchlist status?`,
        ``,
        `Suggested next step: finalize punchlist sign-off so we can submit the` +
          ` retainage release request with the owner.`,
      ].join("\n"));
    }

    const lines: string[] = [];
    lines.push(`# Daily Cash Recovery — Morning Briefing`);
    lines.push(``);
    lines.push(`**Total recoverable cash identified: ${$(grandTotal)} across ${touchedIds.size} projects**`);
    lines.push(``);

    lines.push(`## 1. Approved Change Orders Not Billed — ${$(coTotal)}`);
    lines.push(`| Project | CO | Amount | Approved | Description |`);
    lines.push(`|---------|----|-------:|----------|-------------|`);
    for (const c of unbilledCOs) {
      const p = projects.find((x) => x.project_id === c.project_id);
      lines.push(`| ${p?.name ?? c.project_id} | ${c.co_id} | ${$(c.amount)} | ${c.approved_date} | ${c.description} |`);
    }
    lines.push(``);

    lines.push(`## 2. Underbilled Projects — ${$(underbilledTotal)}`);
    lines.push(`| Project | % Complete | Expected | Actual | Underbilled |`);
    lines.push(`|---------|-----------:|---------:|-------:|------------:|`);
    for (const u of underbilled) {
      const p = projects.find((x) => x.project_id === u.project_id)!;
      lines.push(`| ${p.name} | ${Math.round(p.percent_complete * 100)}% | ${$(u.expected_billing)} | ${$(u.actual_billing)} | ${$(u.underbilled_amount)} |`);
    }
    lines.push(``);

    lines.push(`## 3. Retainage Release Opportunities — ${$(retainageTotal)}`);
    lines.push(`| Project | % Complete | Retainage Held | Notes |`);
    lines.push(`|---------|-----------:|---------------:|-------|`);
    for (const r of retainage) {
      lines.push(`| ${r.name} | ${Math.round(r.percent_complete * 100)}% | ${$(r.retainage_held)} | Subs: ${r.subcontractors.slice(0, 2).join(", ")}${r.subcontractors.length > 2 ? "…" : ""} |`);
    }
    lines.push(``);

    lines.push(`## 4. Overdue Receivables (>60 days) — ${$(agedTotal)}`);
    lines.push(`| Customer | Invoice | Amount | Days Outstanding | Bucket |`);
    lines.push(`|----------|---------|-------:|-----------------:|--------|`);
    for (const a of aged) {
      lines.push(`| ${a.customer} | ${a.invoice_id} | ${$(a.amount)} | ${a.days_outstanding} | ${a.bucket} |`);
    }
    lines.push(``);

    lines.push(`## 5. Anomalies / Potential Duplicates`);
    if (dupes.length === 0) {
      lines.push(`_None detected._`);
    } else {
      lines.push(`| Invoice A | Invoice B | Project | Amount A | Amount B | Date A | Date B | Confidence |`);
      lines.push(`|-----------|-----------|---------|---------:|---------:|--------|--------|-----------|`);
      for (const d of dupes) {
        lines.push(`| ${d.invoice_a} | ${d.invoice_b} | ${d.project_id} | ${$(d.amount_a)} | ${$(d.amount_b)} | ${d.date_a} | ${d.date_b} | ${d.confidence} |`);
      }
    }
    lines.push(``);

    lines.push(`## 6. Drafted Actions`);
    lines.push(`- Billing memos: **${memos.length}**`);
    lines.push(`- Collection emails: **${emails.length}**`);
    lines.push(`- PM messages: **${pmMessages.length}**`);
    lines.push(``);
    for (const m of memos) { lines.push(m); lines.push(""); }
    for (const e of emails) { lines.push(e); lines.push(""); }
    for (const p of pmMessages) { lines.push(p); lines.push(""); }

    lines.push(`---`);
    lines.push(`**Executive summary:** The agent identified ${$(grandTotal)} in recoverable or unbilled cash across ${touchedIds.size} projects this morning.`);

    return toolResult(lines.join("\n"));
  },
};

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

// Expose for tests — lets them call handlers without stdin wiring.
export { tools };

// Production wiring: arm channel, register dispatcher, start stdin loop.
// Extracted so tests can cover the wiring branch (the `import.meta.main`
// gate alone is dead under `bun test`). Mirrors the `start()` pattern
// used by web-search/index.ts and substack-engagement/index.ts.
export function start(): void {
  const ch = getChannel();
  createToolDispatcher(tools);
  ch.start();
}

// Gated on `import.meta.main` so test files can import this module
// without stealing stdin.
if (import.meta.main) start();
