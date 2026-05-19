# Property Intelligence Agent

An autonomous agent built for a commercial real-estate accounting manager. It
reads a property portfolio's leases, rent roll, AR aging, GL, budgets, work
orders, loans, CAM recs, and compliance calendar — then surfaces every dollar
of risk and opportunity hiding in the data, quantified and cited back to the
tool that produced each finding.

## Two workflows

1. **Daily Portfolio Briefing** — scans the full book and produces a
   prioritized morning exception list (AR risk, covenant alerts, expiring
   leases, unbilled revenue, compliance clocks). Entry-level capability.
2. **Property Deep Dive** (the hero) — given one `property_id`, produces an
   executive-ready report: overview, lease summary, AR/tenant risk, financial
   performance, CAM status, operations, debt & covenants, compliance, ranked
   risks, ranked opportunities, and drafted follow-up actions.

The agent **never sends** anything. Every follow-up is a draft for the
accounting manager to approve.

## Layout

```
property-intelligence-agent/
  ezcorp.config.ts     # manifest: 23 tools, 1 skill, agent prompt
  index.ts             # tool handlers + pure analytics + JSON-RPC dispatch
  generate-data.ts     # seeded synthetic CSVs (mulberry32 PRNG)
  index.test.ts        # 35 tests: pure-logic, RPC, synthesis, manifest
  data/                # the 10 CSVs (generated)
    properties.csv
    leases.csv
    rent_roll.csv
    ar_aging.csv
    gl_transactions.csv
    budget_vs_actual.csv
    work_orders.csv
    loans.csv
    cam_recs.csv
    compliance.csv
```

## Quick start (under 5 minutes)

The extension is auto-installed by the harness via `src/extensions/bundled.ts`.
For standalone development:

```bash
# 1. Generate the demo CSVs (seed 42 is the default).
bun run docs/extensions/examples/property-intelligence-agent/generate-data.ts

# 2. Run the test suite — all 35 tests should pass.
bun test ./docs/extensions/examples/property-intelligence-agent/index.test.ts

# 3. Drive one of the synthesis tools directly via the JSON-RPC handler.
bun --print '
  const mod = await import("./docs/extensions/examples/property-intelligence-agent/index");
  const res = await mod.handleRequest({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "generate-property-deep-dive", arguments: { property_id: "P003" } }
  });
  console.log(res.result.content[0].text);
'
```

## How to register with the harness

Already done — `src/extensions/bundled.ts` contains the entry:

```ts
{
  name: "property-intelligence-agent",
  path: "docs/extensions/examples/property-intelligence-agent",
  permissions: {
    filesystem: ["$CWD"],
    grantedAt: { filesystem: Date.now() },
  },
},
```

The harness's `ensureBundledExtensions` pulls the on-disk manifest into the DB
on each boot, so tool schemas and agent prompt stay in sync with source. On
next startup, `ezcorp ext list` will show `property-intelligence-agent` among
the installed extensions.

## Tool surface

23 tools registered in the manifest:

| Group | Tool |
|---|---|
| Discovery | `list-properties`, `get-property` |
| Leases | `get-leases`, `get-expiring-leases`, `get-rent-roll`, `find-unbilled-escalations` |
| AR | `get-ar-aging`, `get-tenants-at-risk` |
| Financials | `get-gl-summary`, `get-budget-vs-actual`, `get-noi-trend` |
| Operations | `get-work-orders`, `get-capex-summary` |
| Debt & Compliance | `get-loan-info`, `get-covenant-status`, `get-cam-status`, `get-compliance` |
| Drafted Actions | `draft-email`, `draft-memo`, `create-task` |
| Synthesis | `generate-daily-briefing`, `generate-property-deep-dive` |
| Housekeeping | `regenerate-data` |

Every analytic has a pure-function counterpart exported from `index.ts`, so
the harness engineering team can exercise any calculation without spinning
up the JSON-RPC subprocess.

## Seeded demo data

`generate-data.ts` emits 10 CSVs with reproducible invariants planted on
known IDs. Every invariant is declared in the returned `planted` object so
tests can assert directly:

| Invariant | Planted on |
|---|---|
| Hero property with 5+ overlapping issues | **P003** (Riverside Commons) |
| DSCR within 0.10 of covenant | P003 loan: 1.22 vs 1.15 covenant |
| NOI variance < −15% YTD | P003: −16.9% ($220K miss) |
| Unbilled escalations | L-301, L-302, L-401 (~$14K total, 4 months each) |
| CAM under-recovery > $10K | P003 (−$13K), P010 (−$12K) |
| Insurance expiring < 30 days | P003: 22 days |
| OpEx category > 20% over budget | P003 Utilities: +25% |
| 2 leases expiring < 90 days, no renewal | L-102 (P001, 78d), L-502 (P005, 45d) |
| Tenant in default | L-501 (Coastal Imports, P005) |
| Tenant 90+ days past due | L-701 (Apex Logistics, P007, $47.5K) |

Re-seed with a different seed via `regenerate-data` (the housekeeping tool)
or by re-running `bun run generate-data.ts --seed=<n>`.

## Dependencies

None beyond the existing workspace SDK (`@ezcorp/sdk`, `@ezcorp/sdk/runtime`)
and Bun standard library. No pandas, no pydantic — the code is pure
TypeScript and one ~110-line no-dep CSV parser.

## Testing

35 tests cover:

- Every pure analytic (11 tests)
- Every reader tool via JSON-RPC (13 tests)
- Both drafted-action tools (3 tests)
- Both synthesis tools including section/draft counts (3 tests)
- Manifest structure + tool-handler parity (1 test)
- Error paths (unknown method, unknown property, etc.) (4 tests)

Run with:

```bash
bun test ./docs/extensions/examples/property-intelligence-agent/index.test.ts
```

## Extending

- **Swap CSVs for a real Yardi / MRI / AppFolio pull**: replace the `load*()`
  functions at the top of `index.ts`. The analytic functions and tool schemas
  stay unchanged.
- **Add a new tool**: register in `ezcorp.config.ts`, add a handler in
  `index.ts`, add a test. The pattern is identical to `cash-recovery-agent`.
- **Adjust demo invariants**: edit the planted blocks in `generate-data.ts`
  (labeled "Plant..." throughout). The invariants are declared in the
  returned `planted` object so tests will fail fast on contradiction.
