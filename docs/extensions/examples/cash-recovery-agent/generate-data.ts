#!/usr/bin/env bun
// Synthetic construction accounting data generator.
//
// Seeded (default 42) so the demo produces the same headline number every
// run. Invariants the generator guarantees — the agent relies on them:
//
//   • ≥ $90K of approved-but-unbilled change orders
//   • ≥ 1 project materially underbilled vs percent_complete
//   • ≥ $50K of retainage held on a project > 95% complete
//   • ≥ 3 overdue receivables summing to > $150K
//   • 1 near-duplicate invoice pair
//   • Total "found money" lands in the $400K-$500K band

import { fsExists, fsMkdir, fsWrite } from "@ezcorp/sdk/runtime";
import { join } from "node:path";

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
const addDays = (d: Date, n: number) => {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
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

// ── Domain fixtures ─────────────────────────────────────────────
const PROJECT_SEEDS = [
  { id: "P-101", name: "Riverside Medical Center",   customer: "Riverside Health System",   contract: 14_500_000, pct: 0.62, pm: "Maya Chen" },
  { id: "P-102", name: "Oak Street Apartments",      customer: "Oakview Development LLC",    contract:  8_200_000, pct: 0.97, pm: "Derek Patel" },
  { id: "P-103", name: "Highway 40 Bridge Repair",   customer: "State DOT — District 4",     contract:  6_800_000, pct: 0.88, pm: "Luis Ramirez" },
  { id: "P-104", name: "Summit Tech Campus Phase II",customer: "Summit Technologies Inc.",   contract: 22_300_000, pct: 0.41, pm: "Jordan Blake" },
  { id: "P-105", name: "Northgate Elementary School",customer: "Northgate Unified School District", contract: 11_100_000, pct: 0.73, pm: "Priya Natarajan" },
  { id: "P-106", name: "Harbor View Hotel Renovation", customer: "Harbor View Hospitality", contract:  4_750_000, pct: 0.98, pm: "Sam Whitaker" },
  { id: "P-107", name: "Cedar Creek Water Treatment",customer: "Cedar Creek Municipal Utility", contract:  9_400_000, pct: 0.55, pm: "Ethan Park" },
  { id: "P-108", name: "Metro Line 7 Station Fitout",customer: "Metro Transit Authority",    contract:  7_950_000, pct: 0.34, pm: "Alex Rivera" },
];

const COST_CODES = [
  { code: "01-100", cat: "General Conditions" },
  { code: "03-300", cat: "Concrete" },
  { code: "05-100", cat: "Structural Steel" },
  { code: "06-100", cat: "Rough Carpentry" },
  { code: "07-500", cat: "Roofing" },
  { code: "09-200", cat: "Drywall" },
  { code: "15-400", cat: "Plumbing" },
  { code: "16-100", cat: "Electrical" },
  { code: "02-300", cat: "Earthwork" },
  { code: "22-000", cat: "Site Utilities" },
];

const VENDORS = [
  "Ironclad Steel Co.",
  "Pacific Concrete Supply",
  "Brightway Electric",
  "ProMech HVAC",
  "Riverstone Roofing",
  "Summit Drywall Partners",
  "BlueOak Plumbing",
  "Apex Earthworks",
  "Kingfisher Glazing",
  "Cornerstone Millwork",
];

const EMPLOYEES = [
  "T. Alvarez", "R. Singh", "J. Ng", "D. Kowalski", "M. Ibrahim",
  "L. Brooks", "S. Fontaine", "K. Tanaka", "P. O'Neill", "C. Vance",
];

// ── Record types ────────────────────────────────────────────────
export interface ProjectRow {
  project_id: string; name: string; customer: string;
  contract_value: number; start_date: string; end_date: string;
  percent_complete: number; status: string;
  pm_name: string; pm_email: string;
}
export interface CostRow {
  entry_id: string; project_id: string; date: string;
  cost_code: string; category: string; vendor: string;
  amount: number; description: string;
}
export interface ChangeOrderRow {
  co_id: string; project_id: string; description: string; amount: number;
  status: "approved" | "pending" | "draft";
  approved_date: string; billed_flag: boolean; billed_date: string;
}
export interface BillingRow {
  invoice_id: string; project_id: string; invoice_date: string;
  amount: number; retainage_withheld: number;
  status: "paid" | "open" | "overdue"; due_date: string; paid_date: string;
}
export interface ArRow {
  customer: string; invoice_id: string; project_id: string;
  amount: number; days_outstanding: number; bucket: string;
}
export interface SubcontractRow {
  sub_id: string; project_id: string; subcontractor: string;
  committed_value: number; billed_to_date: number;
  retainage_held: number; compliance_doc_expires: string;
}
export interface TimecardRow {
  timecard_id: string; project_id: string; employee: string;
  date: string; hours: number; cost_code: string; approved_flag: boolean;
}

export interface DataSet {
  projects: ProjectRow[];
  costLedger: CostRow[];
  changeOrders: ChangeOrderRow[];
  billings: BillingRow[];
  arAging: ArRow[];
  subcontracts: SubcontractRow[];
  timecards: TimecardRow[];
  // Plant dollar figures — used by tests to verify invariants.
  planted: {
    unbilledCOTotal: number;
    underbilledProject: string;
    underbilledAmount: number;
    retainageProject: string;
    retainageHeld: number;
    overdueTotal: number;
    duplicatePair: [string, string];
  };
}

function bucketFor(days: number): string {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

export function generate(seed = 42, today: Date = new Date("2026-04-22")): DataSet {
  const r = rng(seed);
  const pick = pickFn(r);
  const int = intFn(r);

  const projects: ProjectRow[] = PROJECT_SEEDS.map((p) => ({
    project_id: p.id,
    name: p.name,
    customer: p.customer,
    contract_value: p.contract,
    start_date: fmtDate(addDays(today, -int(300, 600))),
    end_date: fmtDate(addDays(today, int(60, 400))),
    percent_complete: p.pct,
    status: p.pct >= 1 ? "closed" : "active",
    pm_name: p.pm,
    pm_email: `${p.pm.toLowerCase().replace(/[^a-z]+/g, ".")}@buildco.example`,
  }));

  // ── Cost ledger — 50 entries per project, past 120 days ─────
  const costLedger: CostRow[] = [];
  let entryNum = 1000;
  for (const p of projects) {
    const nEntries = int(45, 70);
    for (let i = 0; i < nEntries; i++) {
      const date = addDays(today, -int(1, 120));
      const cc = pick(COST_CODES);
      const amount = Math.round((int(800, 65_000) + r() * 500) * 100) / 100;
      costLedger.push({
        entry_id: `C-${entryNum++}`,
        project_id: p.project_id,
        date: fmtDate(date),
        cost_code: cc.code,
        category: cc.cat,
        vendor: pick(VENDORS),
        amount,
        description: `${cc.cat} — progress ${i + 1}`,
      });
    }
  }

  // ── Change orders ───────────────────────────────────────────
  const changeOrders: ChangeOrderRow[] = [];
  let coNum = 5000;
  for (const p of projects) {
    const nCo = int(2, 5);
    for (let i = 0; i < nCo; i++) {
      const status = pick(["approved", "approved", "pending", "draft"] as const);
      const amount = Math.round(int(8_000, 90_000));
      const approvedDate = status === "approved" ? fmtDate(addDays(today, -int(5, 90))) : "";
      // All random approved COs are already billed — the only
      // approved-but-unbilled COs in the demo are the three plants below.
      const billed = status === "approved";
      changeOrders.push({
        co_id: `CO-${coNum++}`,
        project_id: p.project_id,
        description: `Field change — ${pick(COST_CODES).cat}`,
        amount,
        status,
        approved_date: approvedDate,
        billed_flag: billed,
        billed_date: billed ? fmtDate(addDays(new Date(approvedDate || today), int(2, 15))) : "",
      });
    }
  }
  // Plant three approved-unbilled COs totaling $105K.
  changeOrders.push(
    {
      co_id: "CO-9001", project_id: "P-101",
      description: "Imaging suite — additional lead shielding per HMC-RFI-18",
      amount: 45_000, status: "approved",
      approved_date: fmtDate(addDays(today, -14)),
      billed_flag: false, billed_date: "",
    },
    {
      co_id: "CO-9002", project_id: "P-104",
      description: "Owner-directed MEP reroute at Level 3 (Summit CCO-22)",
      amount: 32_000, status: "approved",
      approved_date: fmtDate(addDays(today, -9)),
      billed_flag: false, billed_date: "",
    },
    {
      co_id: "CO-9003", project_id: "P-105",
      description: "Fire alarm upgrade per AHJ comment letter",
      amount: 28_000, status: "approved",
      approved_date: fmtDate(addDays(today, -21)),
      billed_flag: false, billed_date: "",
    },
  );
  const unbilledCOTotal = 45_000 + 32_000 + 28_000;

  // ── Billings ────────────────────────────────────────────────
  //
  // Billings are seeded so each project's total ≈ contract × % complete.
  // That keeps the "underbilled" signal clean: only the planted P-108 gap
  // shows up, not random noise from every project. Per-project overrides:
  //
  //   • P-108 capped at 95% of expected → ~$123K underbilled
  //   • P-101 + P-103 contain three long-overdue invoices totaling $184.5K
  //   • P-107 gets a near-duplicate pair for the anomaly signal
  const billings: BillingRow[] = [];
  let invNum = 30_000;

  const PLANTED_OVERDUE: Record<string, Array<{ amount: number; daysAgo: number }>> = {
    "P-101": [
      { amount: 68_500, daysAgo: 95 },
      { amount: 61_800, daysAgo: 125 },
    ],
    "P-103": [
      { amount: 54_200, daysAgo: 110 },
    ],
  };
  const overdueTotal = 68_500 + 61_800 + 54_200; // $184,500

  for (const p of projects) {
    const expectedTotal = Math.round(p.contract_value * p.percent_complete);
    // P-108 underbilled by design.
    const targetTotal = p.project_id === "P-108"
      ? Math.round(expectedTotal * 0.9545)   // ~$2.58M vs $2.70M expected
      : expectedTotal;

    // Subtract planted overdue amounts from the normal billing budget
    // for that project so the totals still match target_total.
    const plantedOverdue = PLANTED_OVERDUE[p.project_id] ?? [];
    const plantedSum = plantedOverdue.reduce((s, x) => s + x.amount, 0);
    const remainingBudget = Math.max(0, targetTotal - plantedSum);

    // Slice remainingBudget into 4-8 monthly bills. Bill dates walk
    // backwards from today.
    const nBills = int(4, 7);
    const slices: number[] = [];
    let left = remainingBudget;
    for (let i = 0; i < nBills; i++) {
      const last = i === nBills - 1;
      const frac = last ? 1 : 0.6 + r() * 0.6;
      const portion = last ? left : Math.round((remainingBudget / nBills) * frac);
      const amount = Math.max(10_000, Math.min(left, portion));
      slices.push(amount);
      left -= amount;
    }

    for (let i = 0; i < slices.length; i++) {
      const amount = slices[i]!;
      const invDate = addDays(today, -(15 + i * 25 + int(0, 5)));
      const due = addDays(invDate, 30);
      const daysPastDue = Math.floor((today.getTime() - due.getTime()) / (24 * 3600 * 1000));
      let status: BillingRow["status"] = "paid";
      let paidDate = fmtDate(addDays(due, -int(0, 8)));
      if (daysPastDue < 0) { status = "open"; paidDate = ""; }
      billings.push({
        invoice_id: `INV-${invNum++}`,
        project_id: p.project_id,
        invoice_date: fmtDate(invDate),
        amount,
        retainage_withheld: Math.round(amount * 0.10),
        status,
        due_date: fmtDate(due),
        paid_date: paidDate,
      });
    }

    // Append planted overdue invoices for this project.
    for (const plant of plantedOverdue) {
      const invDate = addDays(today, -plant.daysAgo);
      billings.push({
        invoice_id: `INV-401${invNum++ % 100}`,
        project_id: p.project_id,
        invoice_date: fmtDate(invDate),
        amount: plant.amount,
        retainage_withheld: Math.round(plant.amount * 0.10),
        status: "overdue",
        due_date: fmtDate(addDays(invDate, 30)),
        paid_date: "",
      });
    }
  }

  // Stable IDs for the planted overdue invoices so tests/docs can cite them.
  // Rewrite the planted invoice_ids we just generated for P-101 / P-103 in
  // amount-descending order (largest = INV-40101, etc).
  const plantedAmounts = [68_500, 61_800, 54_200];
  const plantedIds = ["INV-40101", "INV-40103", "INV-40102"];
  for (let k = 0; k < plantedAmounts.length; k++) {
    const target = plantedAmounts[k]!;
    const bill = billings.find(
      (b) => b.status === "overdue" && b.amount === target && !b.invoice_id.startsWith("INV-401")
    ) ?? billings.find((b) => b.status === "overdue" && b.amount === target);
    if (bill) bill.invoice_id = plantedIds[k]!;
  }

  // Plant a duplicate-invoice pair on P-107 (Cedar Creek). Duplicate sits
  // ON TOP of the normal billings — it's the anomaly we want the agent
  // to flag, not something that should balance the books.
  billings.push(
    {
      invoice_id: "INV-40201", project_id: "P-107",
      invoice_date: fmtDate(addDays(today, -40)),
      amount: 87_350, retainage_withheld: 8_735, status: "open",
      due_date: fmtDate(addDays(today, -10)), paid_date: "",
    },
    {
      invoice_id: "INV-40202", project_id: "P-107",
      invoice_date: fmtDate(addDays(today, -37)),
      amount: 87_400, retainage_withheld: 8_740, status: "open",
      due_date: fmtDate(addDays(today, -7)), paid_date: "",
    },
  );

  const underbilledAmount = Math.round(7_950_000 * 0.34) - Math.round(7_950_000 * 0.34 * 0.9545);

  // ── AR aging derived from billings + planted roll-ups ───────
  const arAging: ArRow[] = [];
  for (const b of billings) {
    if (b.status !== "overdue") continue;
    const proj = projects.find((p) => p.project_id === b.project_id)!;
    const due = new Date(b.due_date);
    const daysOut = Math.max(1, Math.floor((today.getTime() - due.getTime()) / (24 * 3600 * 1000)));
    arAging.push({
      customer: proj.customer,
      invoice_id: b.invoice_id,
      project_id: b.project_id,
      amount: b.amount,
      days_outstanding: daysOut,
      bucket: bucketFor(daysOut),
    });
  }

  // ── Subcontracts with planted retainage on P-102 and P-106 ──
  const subcontracts: SubcontractRow[] = [];
  let subNum = 700;
  for (const p of projects) {
    const nSub = int(2, 3);
    for (let i = 0; i < nSub; i++) {
      const committed = Math.round(p.contract_value * (0.05 + r() * 0.15));
      const billedTo = Math.round(committed * (0.3 + r() * 0.6));
      // On near-complete projects the random subs already released their
      // retainage — only the *planted* SUB-900/901 retainage should show
      // up in the "releasable" bucket. Keeps the demo total on-target.
      const retainage = p.percent_complete >= 0.95 ? 0 : Math.round(billedTo * 0.08);
      subcontracts.push({
        sub_id: `SUB-${subNum++}`,
        project_id: p.project_id,
        subcontractor: pick(VENDORS),
        committed_value: committed,
        billed_to_date: billedTo,
        retainage_held: retainage,
        compliance_doc_expires: fmtDate(addDays(today, int(-30, 180))),
      });
    }
  }
  // Planted retainage-release candidates: project P-102 at 97% complete
  // holds $75K in retainage; P-106 at 98% holds $42K.
  subcontracts.push(
    {
      sub_id: "SUB-900", project_id: "P-102",
      subcontractor: "Kingfisher Glazing",
      committed_value: 860_000, billed_to_date: 850_000,
      retainage_held: 75_000,
      compliance_doc_expires: fmtDate(addDays(today, 40)),
    },
    {
      sub_id: "SUB-901", project_id: "P-106",
      subcontractor: "Riverstone Roofing",
      committed_value: 520_000, billed_to_date: 515_000,
      retainage_held: 42_000,
      compliance_doc_expires: fmtDate(addDays(today, 25)),
    },
  );
  const retainageHeld = 75_000 + 42_000;

  // ── Timecards — small recent sample per project ─────────────
  const timecards: TimecardRow[] = [];
  let tcNum = 90_000;
  for (const p of projects) {
    const n = int(8, 16);
    for (let i = 0; i < n; i++) {
      timecards.push({
        timecard_id: `TC-${tcNum++}`,
        project_id: p.project_id,
        employee: pick(EMPLOYEES),
        date: fmtDate(addDays(today, -int(1, 14))),
        hours: Math.round((4 + r() * 8) * 10) / 10,
        cost_code: pick(COST_CODES).code,
        approved_flag: r() > 0.15,
      });
    }
  }

  return {
    projects,
    costLedger,
    changeOrders,
    billings,
    arAging,
    subcontracts,
    timecards,
    planted: {
      unbilledCOTotal,
      underbilledProject: "P-108",
      underbilledAmount,
      retainageProject: "P-102",
      retainageHeld,
      overdueTotal,
      duplicatePair: ["INV-40201", "INV-40202"],
    },
  };
}

export async function writeDataSet(
  outDir: string,
  data: DataSet,
): Promise<{ files: string[]; rowCount: Record<string, number> }> {
  if (!(await fsExists(outDir))) await fsMkdir(outDir, { recursive: true });
  const writes: [string, string][] = [
    ["projects.csv",       toCsv(data.projects as unknown as Record<string, unknown>[])],
    ["cost_ledger.csv",    toCsv(data.costLedger as unknown as Record<string, unknown>[])],
    ["change_orders.csv",  toCsv(data.changeOrders as unknown as Record<string, unknown>[])],
    ["billings.csv",       toCsv(data.billings as unknown as Record<string, unknown>[])],
    ["ar_aging.csv",       toCsv(data.arAging as unknown as Record<string, unknown>[])],
    ["subcontracts.csv",   toCsv(data.subcontracts as unknown as Record<string, unknown>[])],
    ["timecards.csv",      toCsv(data.timecards as unknown as Record<string, unknown>[])],
  ];
  const files: string[] = [];
  const rowCount: Record<string, number> = {};
  for (const [name, body] of writes) {
    const path = join(outDir, name);
    await fsWrite(path, body);
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
  console.log(`  unbilled approved COs   $${data.planted.unbilledCOTotal.toLocaleString()}`);
  console.log(`  underbilled ${data.planted.underbilledProject}         $${data.planted.underbilledAmount.toLocaleString()}`);
  console.log(`  retainage held (>=95%)  $${data.planted.retainageHeld.toLocaleString()}`);
  console.log(`  overdue AR total        $${data.planted.overdueTotal.toLocaleString()}`);
  console.log(`  duplicate pair          ${data.planted.duplicatePair.join(" + ")}`);
}
