import { defineExtension } from "../../../../src/extensions/sdk/define";

// System prompt for the Property Intelligence Agent. Kept inline so the
// manifest is the single source of truth for agent behavior.
const SYSTEM_PROMPT = `You are the Property Intelligence Agent — an autonomous
AI built for a commercial real-estate accounting manager. Your job is to surface
every dollar of risk and opportunity hiding in a property portfolio, cite the
tool result that supports each finding, and hand back drafted follow-ups that
the manager can approve and send.

Operating rules:
- Never guess numbers. Always call a tool to read the underlying data.
- Use tools aggressively. Deep dives issue 12+ calls; a daily briefing issues
  6+. Running more tools is better than running fewer.
- Every finding MUST cite the tool that produced it, e.g. "(source:
  get-tenants-at-risk)".
- Every finding MUST carry a dollar figure where one is derivable, formatted
  $1,234,567.
- Rank every list — risks, opportunities, exceptions, actions — by dollar
  impact, largest first.
- Dates use YYYY-MM-DD.
- Prefer concise, executive-ready language. No hedging, no filler.
- All recommended actions are DRAFTS. Never claim an email was sent or a task
  was assigned. Use draft-email, draft-memo, create-task and defer to the
  accounting manager for approval.

Available workflows:

## Daily Portfolio Briefing
Recommended tool sequence:
1. list-properties — scope the portfolio.
2. get-expiring-leases(days_ahead=90) — lease rollover risk.
3. get-tenants-at-risk(threshold_days=60) — AR risk.
4. get-covenant-status — debt risk across all loans.
5. get-compliance(days_ahead=60) — regulatory / insurance clock.
6. find-unbilled-escalations — revenue leakage portfolio-wide.
7. On any property flagged above, call get-budget-vs-actual to corroborate
   financial exceptions.
8. For every material finding, draft one follow-up via draft-email,
   draft-memo, or create-task.
9. Optionally call generate-daily-briefing as a last step to emit a formatted
   synthesis.

Output format (Markdown):

# Daily Portfolio Briefing — YYYY-MM-DD
**Headline metrics**
- At-risk receivables: $X,XXX
- Unbilled escalations YTD: $X,XXX
- Leases expiring in next 90 days: N
- Covenant alerts: N
- Compliance items due < 60 days: N

## 1. Top Exceptions (ranked by dollar impact)
| Property | Category | Severity | Description | $ Impact | Source |

## 2. Expiring Leases (next 90 days)
| Lease | Property | Tenant | Ends | Monthly Rent | Renewal |

## 3. AR Risk
| Tenant | Property | Outstanding | Oldest Bucket | Last Payment |

## 4. Covenant Alerts
| Property | Loan | DSCR | Covenant | Gap |

## 5. Compliance Alerts
| Property | Item | Expires | Days |

## 6. Recommended Actions — Drafts
<each drafted email / memo / task in a fenced block>

Close with a one-line executive summary restating the headline number.

## Property Deep Dive
Recommended tool sequence (all anchored on property_id):
1. get-property — the target's core record.
2. get-leases — every lease on the property.
3. get-expiring-leases(property_id=...).
4. get-rent-roll — last 12 months.
5. find-unbilled-escalations(property_id=...).
6. get-ar-aging(property_id=...).
7. get-gl-summary.
8. get-budget-vs-actual.
9. get-noi-trend.
10. get-work-orders + get-capex-summary.
11. get-loan-info + get-covenant-status(property_id=...).
12. get-cam-status.
13. get-compliance(property_id=...).
14. Draft 3+ actions for the top risks/opportunities.
15. Optionally call generate-property-deep-dive for a formatted synthesis.

Output format (Markdown):

# Property Deep Dive — <Name> (<ID>)
## Overview
## Lease Summary
## Expiring Lease Risk
## AR & Tenant Risk
## Financial Performance (NOI, budget variances, OpEx flags)
## CAM Status
## Operations (work orders, capex)
## Debt & Covenants
## Compliance
## Top Risks (ranked by dollar impact, min 3 items)
1. <title> — $X,XXX
   <reasoning>
   (source: <tool-name>)
## Top Opportunities (ranked by dollar impact, min 2 items)
## Recommended Actions — Drafts (min 3 items)

Close with a one-line executive summary.`;

export default defineExtension({
  schemaVersion: 2,
  name: "property-intelligence-agent",
  version: "1.0.0",
  description:
    "Property Intelligence Agent: analyzes a commercial real-estate portfolio for risk and opportunity. Surfaces expiring leases, tenant defaults, unbilled escalations, covenant pressure, CAM under-recovery, budget variances, capex, and compliance clocks — every finding quantified in dollars and backed by a tool citation.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  persistent: true,
  tools: [
    // ── Discovery ────────────────────────────────────────────
    {
      name: "list-properties",
      description:
        "List every property in the portfolio with location, type, sqft, units, and NOI YTD vs budget. Always the first call in a briefing.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get-property",
      description: "Get the full detail record for one property by ID.",
      inputSchema: {
        type: "object",
        properties: {
          property_id: { type: "string", description: "Property ID (e.g., P003)" },
        },
        required: ["property_id"],
      },
    },

    // ── Leases & Revenue ─────────────────────────────────────
    {
      name: "get-leases",
      description: "List leases. Filter by property and/or status.",
      inputSchema: {
        type: "object",
        properties: {
          property_id: { type: "string" },
          status_filter: {
            type: "string",
            format: "combo-box",
            description: "Lease status",
            "x-options": {
              options: ["active", "expiring", "holdover", "default", "vacant"],
              allowCustom: false,
            },
          },
        },
      },
    },
    {
      name: "get-expiring-leases",
      description:
        "Return leases ending within `days_ahead` that have not exercised a renewal option. Sorted by days-until-end ascending.",
      inputSchema: {
        type: "object",
        properties: {
          days_ahead: { type: "number", description: "Window in days (default 90)" },
          property_id: { type: "string", description: "Optional property filter" },
        },
      },
    },
    {
      name: "get-rent-roll",
      description:
        "Monthly rent-roll for a property (last N months). Returns a summary block (scheduled/billed/collected totals, billing gap, collection rate) plus the raw monthly rows.",
      inputSchema: {
        type: "object",
        properties: {
          property_id: { type: "string" },
          months: { type: "number", description: "Number of trailing months (default 12)" },
        },
        required: ["property_id"],
      },
    },
    {
      name: "find-unbilled-escalations",
      description:
        "Scan the rent roll for months where billed_rent < scheduled_rent — escalations that went un-invoiced. Optionally scope to one property.",
      inputSchema: {
        type: "object",
        properties: {
          property_id: { type: "string", description: "Optional property filter" },
        },
      },
    },

    // ── AR & Risk ────────────────────────────────────────────
    {
      name: "get-ar-aging",
      description:
        "Return accounts-receivable aging rows plus an aggregated summary (totals by bucket, at-risk dollars, ranked top tenants).",
      inputSchema: {
        type: "object",
        properties: {
          property_id: { type: "string", description: "Optional property filter" },
        },
      },
    },
    {
      name: "get-tenants-at-risk",
      description:
        "Return tenants in default OR with past-due balances above threshold_days. Sorted by outstanding dollars.",
      inputSchema: {
        type: "object",
        properties: {
          threshold_days: {
            type: "number",
            description: "Minimum days past due to flag. Default 60.",
          },
        },
      },
    },

    // ── Financials ───────────────────────────────────────────
    {
      name: "get-gl-summary",
      description:
        "Aggregate GL postings for a property into revenue, OpEx, implied NOI, and account-level totals.",
      inputSchema: {
        type: "object",
        properties: {
          property_id: { type: "string" },
          period: {
            type: "string",
            format: "combo-box",
            description: "Period scope",
            "x-options": { options: ["ytd"], allowCustom: false },
          },
        },
        required: ["property_id"],
      },
    },
    {
      name: "get-budget-vs-actual",
      description:
        "Return YTD budget-vs-actual rows for a property and a flagged list of categories with variance > 15%.",
      inputSchema: {
        type: "object",
        properties: { property_id: { type: "string" } },
        required: ["property_id"],
      },
    },
    {
      name: "get-noi-trend",
      description:
        "Monthly NOI trend plus YTD actual vs budget for a property. Useful after flagging an NOI variance to see WHERE it came from.",
      inputSchema: {
        type: "object",
        properties: { property_id: { type: "string" } },
        required: ["property_id"],
      },
    },

    // ── Operations ───────────────────────────────────────────
    {
      name: "get-work-orders",
      description: "Work orders for a property. Optionally filter to open/in-progress only.",
      inputSchema: {
        type: "object",
        properties: {
          property_id: { type: "string" },
          open_only: { type: "boolean", description: "Exclude closed WOs" },
        },
        required: ["property_id"],
      },
    },
    {
      name: "get-capex-summary",
      description:
        "Capex totals for a property (estimated, actual-to-date, open count, largest open WO).",
      inputSchema: {
        type: "object",
        properties: { property_id: { type: "string" } },
        required: ["property_id"],
      },
    },

    // ── Debt & Compliance ────────────────────────────────────
    {
      name: "get-loan-info",
      description: "Loan(s) secured by a property: balances, rate, maturity, DSCR, covenant.",
      inputSchema: {
        type: "object",
        properties: { property_id: { type: "string" } },
        required: ["property_id"],
      },
    },
    {
      name: "get-covenant-status",
      description:
        "DSCR-vs-covenant check across loans. Flags anything within 0.1 of covenant ('at-risk') or below ('breach'). Sorted by gap ascending.",
      inputSchema: {
        type: "object",
        properties: {
          property_id: { type: "string", description: "Optional — portfolio-wide if omitted" },
        },
      },
    },
    {
      name: "get-cam-status",
      description:
        "Latest CAM reconciliation for a property (estimated vs billed recovery, under-recovery flag, true-up state) plus reconciliation history.",
      inputSchema: {
        type: "object",
        properties: { property_id: { type: "string" } },
        required: ["property_id"],
      },
    },
    {
      name: "get-compliance",
      description:
        "Compliance items (insurance, taxes, inspections, certs) expiring within days_ahead. Optionally scope to one property.",
      inputSchema: {
        type: "object",
        properties: {
          property_id: { type: "string", description: "Optional property filter" },
          days_ahead: { type: "number", description: "Window in days (default 90)" },
        },
      },
    },

    // ── Actions (draft-only) ─────────────────────────────────
    {
      name: "draft-email",
      description:
        "Draft an email. NEVER sends — returns a markdown draft labeled [DRAFT — NOT SENT] for manager approval.",
      inputSchema: {
        type: "object",
        properties: {
          recipient: { type: "string" },
          subject:   { type: "string" },
          body:      { type: "string", description: "Email body (markdown allowed)" },
        },
        required: ["recipient", "subject", "body"],
      },
    },
    {
      name: "draft-memo",
      description:
        "Draft an internal memo. NEVER distributes — returns a markdown draft labeled [DRAFT — Review before distribution].",
      inputSchema: {
        type: "object",
        properties: {
          title:    { type: "string" },
          body:     { type: "string", description: "Memo body (markdown allowed)" },
          audience: { type: "string", description: "Intended audience (e.g., 'CFO, Asset Management')" },
        },
        required: ["title", "body", "audience"],
      },
    },
    {
      name: "create-task",
      description:
        "Draft a task. NEVER assigns — returns a JSON draft for manager approval.",
      inputSchema: {
        type: "object",
        properties: {
          assignee:    { type: "string" },
          description: { type: "string" },
          due_date:    { type: "string", format: "date", description: "YYYY-MM-DD" },
          priority: {
            type: "string",
            format: "combo-box",
            "x-options": {
              options: ["critical", "high", "medium", "low"],
              allowCustom: false,
            },
          },
        },
        required: ["assignee", "description", "due_date", "priority"],
      },
    },

    // ── Deterministic synthesis ──────────────────────────────
    {
      name: "generate-daily-briefing",
      description:
        "Deterministic end-to-end briefing — runs all analyses server-side and returns a formatted markdown report plus drafted actions. Use as the final synthesis step, or as a demo bypass when an LLM is not available.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "generate-property-deep-dive",
      description:
        "Deterministic end-to-end property deep dive — runs every analytic for a single property and returns the full markdown report with ranked risks, opportunities, and drafted actions.",
      inputSchema: {
        type: "object",
        properties: { property_id: { type: "string" } },
        required: ["property_id"],
      },
    },

    // ── Housekeeping ─────────────────────────────────────────
    {
      name: "regenerate-data",
      description:
        "Regenerate the 10 synthetic CSVs inside the extension's data/ folder. Useful for refreshing the demo against today's date.",
      inputSchema: {
        type: "object",
        properties: {
          seed: { type: "number", description: "RNG seed. Default 42." },
        },
      },
    },
  ],
  skills: [
    {
      name: "property-accounting-playbook",
      description:
        "Quick-reference formulas and thresholds for commercial real-estate accounting: DSCR, NOI, CAM reconciliation, escalation math, lease rollover triage.",
      prompt: [
        "# Property Accounting Playbook",
        "",
        "## NOI (Net Operating Income)",
        "NOI = operating_revenue - operating_expenses (before debt service & capex).",
        "Flag any property whose YTD NOI is more than 10% below budget. If the variance is",
        "driven by a single OpEx category > 20% over budget, investigate that category.",
        "",
        "## DSCR (Debt Service Coverage Ratio)",
        "DSCR = NOI / annual_debt_service.",
        "Covenant is typically 1.15x–1.25x. Any loan where DSCR is within 0.10 of its",
        "covenant is 'at-risk' — worth proactive lender outreach before the quarter closes.",
        "DSCR below covenant is a technical breach — escalate immediately.",
        "",
        "## Rent Escalations",
        "Most commercial leases include annual escalations (fixed % or CPI) applied on the",
        "anniversary of lease_start OR on a contractual escalation_month. If scheduled_rent",
        "> billed_rent for a given month, the escalation was not applied — catch-up",
        "invoice + billing schedule fix.",
        "",
        "## CAM (Common Area Maintenance) Reconciliation",
        "Landlord estimates recoverable OpEx at the start of the year, bills monthly, then",
        "reconciles actuals at year-end. Under-recovery = estimated > billed — issue a",
        "true-up invoice. Over-recovery = billed > estimated — issue a credit.",
        "Threshold for material under-recovery: > $10K.",
        "",
        "## AR Aging Buckets",
        "0-30:  healthy",
        "31-60: monitor, send reminder",
        "61-90: call this week",
        "90+:   escalate / consider default notice",
        "Any balance > $25K and > 60 days is a priority call.",
        "",
        "## Lease Expiration Triage",
        "- < 90 days, renewal_option = exercised: no action, track TI obligations.",
        "- < 90 days, renewal_option = yes: approach tenant with bump-and-extend.",
        "- < 90 days, renewal_option = no: leasing team outreach; plan for downtime + TI.",
        "- holdover: convert to MTM at 110-125% of base or push hard for new lease.",
        "",
        "## Compliance Clocks",
        "Insurance, fire inspection, elevator cert, HVAC cert, property tax. Any item",
        "expiring < 30 days is critical; < 60 days warrants vendor outreach.",
      ].join("\n"),
    },
  ],
  agent: {
    prompt: SYSTEM_PROMPT,
    category: "Finance & Accounting",
    capabilities: ["analysis", "drafting", "summarization"],
    modelRequirements: { tier: "balanced", contextWindow: 32_000 },
    temperature: 0.2,
    exampleConversations: [
      {
        title: "Morning briefing",
        messages: [
          {
            role: "user",
            content:
              "Run the daily portfolio briefing. Show me every dollar of risk and opportunity across the book.",
          },
          {
            role: "assistant",
            content:
              "Starting portfolio scan.\n\n[calls list-properties]\n[calls get-expiring-leases days_ahead=90]\n[calls get-tenants-at-risk threshold_days=60]\n[calls get-covenant-status]\n[calls get-compliance days_ahead=60]\n[calls find-unbilled-escalations]\n[drafts emails + memos + tasks]\n\n# Daily Portfolio Briefing — 2026-04-23\n**Headline metrics**\n- At-risk receivables: $113,500\n- Unbilled escalations YTD: $14,416\n- Leases expiring in next 90 days: 2\n- Covenant alerts: 1\n- Compliance items due < 60 days: 1\n\n(full briefing follows)",
          },
        ],
      },
      {
        title: "P003 deep dive",
        messages: [
          {
            role: "user",
            content:
              "Give me a full deep dive on P003 — everything you can find. Risks, opportunities, and drafted actions for the top items.",
          },
          {
            role: "assistant",
            content:
              "Pulling the full P003 (Riverside Commons) record.\n\n[calls get-property property_id=P003]\n[calls get-leases property_id=P003]\n[calls get-expiring-leases property_id=P003]\n[calls get-rent-roll property_id=P003 months=12]\n[calls find-unbilled-escalations property_id=P003]\n[calls get-ar-aging property_id=P003]\n[calls get-budget-vs-actual property_id=P003]\n[calls get-noi-trend property_id=P003]\n[calls get-covenant-status property_id=P003]\n[calls get-cam-status property_id=P003]\n[calls get-compliance property_id=P003]\n[drafts memo + task + email]\n\n# Property Deep Dive — Riverside Commons (P003)\n\n(full report with 5+ ranked risks, 3+ opportunities, 3+ drafted actions)",
          },
        ],
      },
    ],
  },
  permissions: {
    // Read the bundled CSVs in ./data and allow regenerate-data to write back.
    filesystem: ["$CWD"],
    shell: false,
  },
});
