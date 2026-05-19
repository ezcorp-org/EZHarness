import { defineExtension } from "../../../../src/extensions/sdk/define";

// System prompt for the Daily Cash Recovery Agent. Kept inline so the
// manifest is the single source of truth for agent behavior — no
// separate prompts.py equivalent.
const SYSTEM_PROMPT = `You are the Daily Cash Recovery Agent — an autonomous AI built for a
mid-size general contractor's accounting manager. Your job is to find
unbilled, underbilled, and recoverable dollars across every active
project, then draft the follow-up actions that turn findings into cash.

Operating rules:
- Never guess numbers. Always call a tool to read the underlying data.
- Use tools aggressively. A typical run issues 10+ calls.
- Work project by project, but aggregate findings into a single briefing.
- Every item in your output MUST carry a dollar figure, formatted $1,234,567.
- Dates use YYYY-MM-DD.
- Prioritize every list by dollar impact, largest first.

Recommended workflow:
1. Call list-projects to get the portfolio.
2. For each project, pull change orders (status=approved, billed_flag=false),
   call compute-underbilling, and check retainage candidates.
3. Pull AR aging (min_days=60) for overdue receivables and customer rollups.
4. Run detect-duplicate-invoices for billing anomalies.
5. Draft action artifacts: a billing memo per underbilled/unbilled project,
   one collection email per delinquent customer, one PM message per
   underbilled job.
6. Produce a final Morning Briefing (see format below).

Final output format (Markdown):

# Daily Cash Recovery — Morning Briefing
**Total recoverable cash identified: $X,XXX,XXX across N projects**

## 1. Approved Change Orders Not Billed
| Project | CO | Amount | Approved | Action |
|---------|----|--------|----------|--------|

## 2. Underbilled Projects
| Project | % Complete | Expected | Actual | Underbilled |
|---------|-----------|----------|--------|-------------|

## 3. Retainage Release Opportunities
| Project | % Complete | Retainage Held | Status |
|---------|-----------|----------------|--------|

## 4. Overdue Receivables
| Customer | Invoice | Amount | Days Outstanding | Bucket |
|----------|---------|--------|------------------|--------|

## 5. Anomalies / Potential Duplicates
| Invoice A | Invoice B | Vendor/Customer | Amount | Confidence |
|-----------|-----------|-----------------|--------|------------|

## 6. Drafted Actions
- Billing memos (N)
- Collection emails (N)
- PM messages (N)
<each artifact rendered as a fenced code block>

Close with a one-line executive punchline restating total dollars found.`;

export default defineExtension({
  schemaVersion: 2,
  name: "cash-recovery-agent",
  version: "1.0.0",
  description:
    "Daily Cash Recovery Agent: autonomously finds unbilled change orders, underbilled jobs, releasable retainage, and overdue receivables across a construction portfolio.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  persistent: true,
  tools: [
    {
      name: "list-projects",
      description:
        "List every project with contract value, % complete, status, and PM contact info.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get-project-details",
      description: "Get the full detail record for a single project by ID.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project ID (e.g. P-101)" },
        },
        required: ["project_id"],
      },
    },
    {
      name: "get-cost-ledger",
      description: "Pull cost-ledger entries, optionally filtered by project and date range.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Filter by project" },
          start_date: { type: "string", format: "date", description: "Inclusive start (YYYY-MM-DD)" },
          end_date: { type: "string", format: "date", description: "Inclusive end (YYYY-MM-DD)" },
        },
      },
    },
    {
      name: "get-change-orders",
      description:
        "List change orders. Filter by project, status (approved|pending|draft), or billed_flag.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Filter by project" },
          status: {
            type: "string",
            format: "combo-box",
            description: "CO status",
            "x-options": { options: ["approved", "pending", "draft"], allowCustom: false },
          },
          billed_flag: { type: "boolean", description: "Filter on billed vs unbilled" },
        },
      },
    },
    {
      name: "get-billings",
      description: "List invoices. Filter by project and/or status (paid|open|overdue).",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          status: {
            type: "string",
            format: "combo-box",
            "x-options": { options: ["paid", "open", "overdue"], allowCustom: false },
          },
        },
      },
    },
    {
      name: "get-ar-aging",
      description:
        "Return accounts-receivable aging rows filtered by minimum days outstanding and amount.",
      inputSchema: {
        type: "object",
        properties: {
          min_days: { type: "number", description: "Minimum days outstanding" },
          min_amount: { type: "number", description: "Minimum dollar amount" },
        },
      },
    },
    {
      name: "get-subcontracts",
      description: "List subcontract commitments, billed-to-date, and retainage held.",
      inputSchema: {
        type: "object",
        properties: { project_id: { type: "string" } },
      },
    },
    {
      name: "compute-underbilling",
      description:
        "Compute underbilling for a project: cost_to_date, expected_billing (cost/%-complete method), actual_billing, underbilled_amount.",
      inputSchema: {
        type: "object",
        properties: { project_id: { type: "string" } },
        required: ["project_id"],
      },
    },
    {
      name: "find-retainage-release-candidates",
      description:
        "Identify projects whose % complete exceeds the threshold and still carry retainage withheld.",
      inputSchema: {
        type: "object",
        properties: {
          min_percent_complete: {
            type: "number",
            description: "Minimum % complete (0-1). Default 0.95.",
          },
        },
      },
    },
    {
      name: "detect-duplicate-invoices",
      description:
        "Scan billings for likely duplicates (same project, similar amount, dates within 7 days).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "draft-billing-memo",
      description:
        "Draft a markdown billing memo for a PM listing unbilled change orders or underbilled amounts to invoice.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          items: {
            type: "array",
            description: "Line items (description + amount) to include on the memo.",
            items: {
              type: "object",
              properties: {
                description: { type: "string" },
                amount: { type: "number" },
              },
              required: ["description", "amount"],
            },
          },
        },
        required: ["project_id", "items"],
      },
    },
    {
      name: "draft-collection-email",
      description:
        "Draft a polite but firm collection email to a customer listing the overdue invoices.",
      inputSchema: {
        type: "object",
        properties: {
          customer: { type: "string" },
          invoices: {
            type: "array",
            items: {
              type: "object",
              properties: {
                invoice_id: { type: "string" },
                amount: { type: "number" },
                days_outstanding: { type: "number" },
              },
              required: ["invoice_id", "amount", "days_outstanding"],
            },
          },
        },
        required: ["customer", "invoices"],
      },
    },
    {
      name: "draft-pm-message",
      description: "Draft a short Slack/Teams-style message to a project manager.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          issue: { type: "string", description: "What the PM needs to address" },
          recommended_action: { type: "string" },
        },
        required: ["project_id", "issue", "recommended_action"],
      },
    },
    {
      name: "generate-morning-briefing",
      description:
        "Deterministic end-to-end briefing — runs all analyses and returns a formatted markdown report plus drafted artifacts. Use as the final synthesis step, or as a demo bypass when an LLM is not available.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "regenerate-data",
      description:
        "Regenerate all synthetic CSVs inside the extension's data/ folder using the demo seed. Returns the summary of what was generated.",
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
      name: "construction-accounting-playbook",
      description:
        "Quick-reference formulas and heuristics for cash recovery: underbilling math, retainage rules, AR aging thresholds.",
      prompt: [
        "# Construction Accounting Playbook",
        "",
        "## Underbilling (Cost-to-Cost / POC)",
        "expected_billing = contract_value * (cost_to_date / total_estimated_cost)",
        "simplified here: expected_billing = contract_value * percent_complete",
        "underbilled = expected_billing - actual_billing (net of retainage)",
        "Flag any project underbilled by > $25,000.",
        "",
        "## Retainage Release",
        "Most contracts allow retainage release once a project hits 95% complete",
        "and punchlist is materially closed. Flag any project >= 95% complete with",
        "retainage_withheld > 0 for PM follow-up.",
        "",
        "## AR Aging",
        "0-30: healthy",
        "31-60: monitor",
        "61-90: call this week",
        "90+:   escalate / legal review",
        "Any balance over $50K and >60 days is a priority call.",
        "",
        "## Duplicate Invoice Heuristic",
        "Same customer/project, amounts within $100, dates within 7 days.",
      ].join("\n"),
    },
  ],
  agent: {
    prompt: SYSTEM_PROMPT,
    category: "Finance & Accounting",
    capabilities: ["analysis", "drafting", "summarization"],
    modelRequirements: { tier: "balanced", contextWindow: 32000 },
    temperature: 0.2,
    exampleConversations: [
      {
        title: "Daily morning briefing",
        messages: [
          {
            role: "user",
            content:
              "Run the daily cash recovery briefing. Find every dollar we haven't billed yet or can't collect on.",
          },
          {
            role: "assistant",
            content:
              "Starting portfolio scan. I'll pull projects, then check change orders, billings, and AR aging.\n\n[calls list-projects]\n[calls get-change-orders status=approved billed_flag=false]\n[calls compute-underbilling per project]\n[calls find-retainage-release-candidates min_percent_complete=0.95]\n[calls get-ar-aging min_days=60]\n[calls detect-duplicate-invoices]\n[drafts memos + emails]\n\n# Daily Cash Recovery — Morning Briefing\n**Total recoverable cash identified: $482,140 across 5 projects**\n\n(full briefing follows)",
          },
        ],
      },
    ],
  },
  permissions: {
    // Read + write to the extension's own directory for CSV regeneration.
    filesystem: ["$CWD"],
    shell: false,
  },
});
