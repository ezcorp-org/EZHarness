# cash-recovery-agent

**Daily Cash Recovery Agent** — an ezcorp extension that turns a
construction accounting manager's 60-minute Monday-morning spreadsheet
drill into a one-click autonomous scan. The harness loads synthetic
project & accounting data, the agent calls analytical tools to hunt for
unbilled change orders, underbilled jobs, releasable retainage, and
overdue receivables, and it outputs a briefing that ends with:

> **The agent identified $529,486 in recoverable or unbilled cash this
> morning.**

All files — manifest, tool server, seed generator, CSV fixtures, tests,
and this README — live inside this directory. Nothing references the
rest of the repo.

## Architecture

```
 ┌──────────────────────┐
 │  data/*.csv          │  8 projects, 459 cost entries, 48 invoices
 └──────────┬───────────┘
            │ parse
 ┌──────────▼───────────┐     ┌────────────────────────────────────┐
 │  index.ts (tools)    │◀───▶│  ezcorp harness                    │
 │   list-projects       │     │  (model loop, tool dispatch, UI)  │
 │   get-change-orders   │     └────────────────────────────────────┘
 │   compute-underbilling│                   │
 │   find-retainage…     │                   ▼
 │   detect-duplicates   │     ┌────────────────────────────────────┐
 │   draft-billing-memo  │     │  agent prompt (ezcorp.config.ts)   │
 │   draft-collection-…  │     │  Daily Cash Recovery Agent        │
 │   generate-morning-…  │     └────────────────────────────────────┘
 └──────────────────────┘
                                            │
                                            ▼
                                 Morning Briefing (markdown)
                                 + drafted memos / emails / PM messages
```

## Install & run

From the repo root:

```bash
# 1. Install the extension into your local ezcorp harness
ezcorp ext install ./docs/extensions/examples/cash-recovery-agent

# 2. (Optional) Re-seed the CSVs — ships with seed=42 already generated
bun docs/extensions/examples/cash-recovery-agent/generate-data.ts

# 3. Run the unit tests
bun test ./docs/extensions/examples/cash-recovery-agent/index.test.ts

# 4. Drive the agent from the ezcorp chat UI
#    Open the ezcorp app, pick "Daily Cash Recovery Agent" (category
#    Finance & Accounting), send: "Run this morning's cash recovery scan."
```

If you want the briefing without the harness at all, call the
deterministic tool directly:

```bash
bun -e '
  const { handleRequest } = await import("./docs/extensions/examples/cash-recovery-agent/index.ts");
  const r = await handleRequest({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "generate-morning-briefing", arguments: {} },
  });
  console.log(r.result.content[0].text);
'
```

## Files

| File | What it does |
|------|-------------|
| `ezcorp.config.ts` | Manifest: 15 tools, the `construction-accounting-playbook` skill, and the agent system prompt. |
| `index.ts` | Tool server. CSV parser, pure analytics (`computeUnderbilling`, `retainageReleaseCandidates`, `detectDuplicateInvoices`), tool handlers, briefing synthesizer, JSON-RPC dispatcher. |
| `generate-data.ts` | Seeded synthetic-data generator. Writes all seven CSVs under `data/`. Runnable as a CLI (`bun generate-data.ts --seed=N`) and importable by the `regenerate-data` tool. |
| `index.test.ts` | Unit tests on the analytics functions plus smoke tests on the JSON-RPC dispatcher and briefing output. |
| `data/*.csv` | The seeded dataset. Check this folder into the repo — the demo ships ready-to-run. |

## Data invariants (seed=42)

| Signal | Planted value | How the agent surfaces it |
|--------|--------------:|--------------------------|
| Approved COs not billed | **$105,000** (CO-9001/9002/9003) | `get-change-orders(status=approved, billed_flag=false)` |
| Underbilled project | **$122,986** on P-108 | `compute-underbilling(P-108)` |
| Retainage release (>=95%) | **$117,000** (P-102 + P-106) | `find-retainage-release-candidates` |
| Overdue receivables | **$184,500** across 3 invoices | `get-ar-aging(min_days=60)` |
| Duplicate invoice | INV-40201 ≈ INV-40202 on P-107 | `detect-duplicate-invoices` |
| **Total recoverable** | **$529,486** | `generate-morning-briefing` |

## Harness design (~200 words)

The harness itself is the ezcorp extension platform: the agent lives in
the host process, the tools live in a sandboxed subprocess, and the two
speak JSON-RPC over stdio. That separation is what gives the extension
its power — the tool server is pure TypeScript, synchronous data access,
easy to unit-test; the agent is stateless, provider-agnostic, and sees
only the typed tool schemas declared in `ezcorp.config.ts`.

Three design choices earn their keep:

1. **Pure-function analytics** (`computeUnderbilling`,
   `retainageReleaseCandidates`, `detectDuplicateInvoices`) live at the
   top of `index.ts` and are exported for tests. The JSON-RPC handlers
   are thin wrappers. When we swap the CSV loader for a Sage ODBC call,
   those functions don't change.
2. **A deterministic `generate-morning-briefing` tool.** It's both the
   agent's final synthesis step *and* a demo-without-LLM fallback. The
   briefing numbers don't depend on a flaky API call.
3. **Schema-first tool declarations.** The JSON Schema in
   `ezcorp.config.ts` doubles as input validation, card rendering hints
   for the UI, and the shape the LLM sees. One source, three consumers.

## Swapping in real ERP data

The analytics functions take plain arrays of typed rows. To hook up a
real Sage 300 / Viewpoint Vista / Procore install, keep `index.ts`'s
analytics untouched and replace the seven `load*()` functions:

| Loader | Today | Real replacement |
|--------|-------|------------------|
| `loadProjects` | reads `data/projects.csv` | Sage `PM Projects` / Viewpoint `JCJM` view |
| `loadCostLedger` | `data/cost_ledger.csv` | `PM Cost Ledger` / `JCCD` |
| `loadChangeOrders` | `data/change_orders.csv` | `PM Change Orders` / `JCCO` |
| `loadBillings` | `data/billings.csv` | `AR Invoice` / `ARIH` |
| `loadArAging` | `data/ar_aging.csv` | `AR Aging` stored procedure |
| `loadSubcontracts` | `data/subcontracts.csv` | `PM Subcontracts` / `SLSC` |
| `loadTimecards` | `data/timecards.csv` | `PR Time Entries` / `PRTH` |

Procore deployments would use the REST API (`/rest/v1.0/projects`,
`/change_orders`, `/invoices`, `/accounts_receivable/aging`) behind the
same loader interface. Because the tool schemas don't change, the agent
prompt and the Morning Briefing template carry over without edits.

## What makes this harness powerful

*(for a non-technical buyer)*

- **It finds real money, not charts.** The output is a dollar figure and
  a drafted email, not a dashboard a human still has to act on.
- **It proves its work.** Every line in the briefing is traceable to a
  specific tool call and a specific row in the underlying data — the
  accounting manager can audit the agent's math in under a minute.
- **It's a morning ritual, not a project.** The same run every day at
  7am turns "cash recovery" from a quarterly scramble into a daily
  standing practice.
- **It ports.** Swap CSVs for Sage or Viewpoint and the agent's behavior
  is identical — same prompt, same tools, same briefing format. No
  retraining, no re-prompting.
- **It's contained.** One extension folder, one install command. No
  cloud pipelines, no data warehouse, no 6-figure ERP integration
  project required to prove value.
