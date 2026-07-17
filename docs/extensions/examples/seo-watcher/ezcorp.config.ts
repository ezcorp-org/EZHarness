// seo-watcher — the "plug in your data source" flagship manifest.
//
// The second flagship loop (Loops EZ Mode Phase 5), split from docs-updater so
// its threshold shape stands on its own as a reusable template: fetch a
// STRUCTURED endpoint → deterministic threshold compare → AI review → a
// human-approved recommendation artifact. Support-ticket volume, a competitor's
// price, an SEO ranking — they are all the SAME shape (a number in a JSON
// response), so this example doubles as the copy-me template for them.
//
// The loop is a full `defineLoop`: a daily cron + on-demand manual tool
// trigger; a deterministic `ctx.fetch` `check` (STRUCTURED JSON only, NO LLM —
// the type firewall forbids it); an `act` that reviews the change with
// `ctx.llm` and returns a `proposal` (kind `artifact`); and a Hub dashboard
// whose per-run approve/decline row actions resolve the proposal through the
// primitive-owned `approveRun`/`declineRun`.
//
// UNTRUSTED INPUT — by design, not accident: the fetched endpoint is
// attacker-controllable, so the loop is declared `contentTrust:
// "untrusted-input"` in index.ts (Phase 8 will therefore never offer autopilot
// — approval is the structural backstop). NO webhook trigger is declared: the
// untrusted-input classification is driven by the fetch itself (the honest
// reason), independent of any trigger, so removing/adding a trigger can never
// silently drop it.
//
// Grants are minimal + purpose-scoped: storage (the run store + the check
// baseline cursor + the LOCKED approval labels), network (the ONE structured
// endpoint host — the security boundary; point it at your real data source by
// adding that host here and reinstalling), llm (the change review), filesystem
// ($CWD — the recommendation artifact mirror), loopEvents (the content-free
// approval nudges), the approve/decline page-action events, a daily cron, and
// one Hub page. NO spawnAgents (the review is a single in-process llm call).

import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "seo-watcher",
  version: "1.0.0",
  description:
    "Flagship 'plug in your data source' loop: fetch a structured JSON endpoint (rankings / prices / ticket counts), threshold-compare a numeric metric against a durable baseline, and — only when it moves — dispatch an LLM review that drafts a recommendation for human approval. Approve publishes the recommendation artifact; decline discards it. Recommend-and-approve only: no consequential external action.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  category: "Development",
  tags: ["loop", "approval", "artifact", "seo", "monitoring", "flagship"],
  // Cron + manual loop — stay resident so the daily fire isn't dropped on idle
  // and the in-memory finalize/discard closures survive between park + approve.
  persistent: true,

  settings: {
    enabled: {
      type: "boolean",
      label: "Enabled",
      description: "Watch the endpoint and draft a recommendation when the metric moves.",
      default: true,
    },
    endpoint_url: {
      type: "text",
      label: "Endpoint URL (structured JSON)",
      description:
        "A STRUCTURED JSON endpoint returning the metric (rankings, prices, ticket counts). Messy HTML is out of scope for the check by design — structured endpoints only. Blank = the loop skips until configured. Its host MUST be in the network allowlist below.",
      default: "",
    },
    metric_pointer: {
      type: "text",
      label: "Metric pointer (dot-path)",
      description:
        "A dot-path to the NUMERIC metric inside the JSON — a closed, code-defined pointer (e.g. `price`, `results.0.position`, `data.rank`). Numeric array indices are supported. Blank = the loop skips.",
      default: "",
    },
    threshold_op: {
      type: "select",
      label: "Alert when the metric…",
      options: [
        { value: "changed", label: "Changes at all (vs the last reading)" },
        { value: "gt", label: "Goes ABOVE the threshold" },
        { value: "lt", label: "Goes BELOW the threshold" },
      ],
      default: "changed",
    },
    threshold_value: {
      type: "text",
      label: "Threshold value",
      description:
        "The number to compare against for the 'above' / 'below' operators (a plain number, e.g. `10`). Ignored for 'changes at all'. Blank with 'above'/'below' = the loop skips (no threshold set).",
      default: "",
    },
    metric_label: {
      type: "text",
      label: "Metric label",
      description:
        "A human label for the metric, shown in the recommendation (e.g. \"Ranking for 'best widgets'\" or \"Competitor price\"). Blank = a generic label.",
      default: "",
    },
    llm_provider: {
      type: "select",
      label: "Review model provider",
      options: [
        { value: "google", label: "Google" },
        { value: "openai", label: "OpenAI" },
        { value: "anthropic", label: "Anthropic" },
      ],
      default: "google",
    },
    llm_model: {
      type: "text",
      label: "Review model id (override)",
      description: "Blank = a sensible default for the chosen provider.",
      default: "",
    },
  },

  tools: [
    {
      name: "run_seo_watch",
      description:
        "Run seo-watcher on demand: fetch the endpoint, compare the metric to the baseline, and — if it moved past the threshold — draft a recommendation for approval.",
      inputSchema: { type: "object", properties: {} },
    },
  ],

  // Hub page declaration (Extension Pages Hub). Declaring the page IS the
  // grant — the dashboard tab appears at /hub/ext:seo-watcher:dashboard. Its
  // per-run approve/decline buttons dispatch the eventSubscriptions events
  // below; the page-tree validator drops any action naming an undeclared event.
  pages: [
    {
      id: "dashboard",
      title: "seo-watcher",
      icon: "TrendingUp",
      description:
        "Metric-change recommendations — status badges, a live run table, and per-run Approve / Decline actions that resolve the proposal through the loop primitive.",
    },
  ],

  permissions: {
    // Self-tracked run records + the durable check baseline cursor + the LOCKED
    // approval-label store.
    storage: true,
    // The check fetches ONE structured endpoint. This allowlist is the security
    // boundary (grants, not prompt hope): only hosts listed here are reachable.
    // Replace this illustrative host with your real data source's host and
    // reinstall to point the loop at it.
    network: ["api.example.com"],
    // The act reviews the metric change with a single host-brokered llm call.
    llm: {
      providers: ["google", "openai", "anthropic"],
      maxCallsPerHour: 12,
      maxCallsPerDay: 50,
      maxTokensPerCall: 1024,
    },
    // The recommendation artifact mirror lands under
    // .ezcorp/extension-data/seo-watcher/.
    filesystem: ["$CWD"],
    // The content-free approval nudges (loops:approval_pending / _resolved).
    loopEvents: true,
    // The dashboard's per-run approve/decline buttons. The page-tree validator
    // drops any action node naming an event not in this allowlist.
    eventSubscriptions: ["seo-watcher:approve", "seo-watcher:decline"],
    // The daily sweep. The host refuses any cron not listed here.
    schedule: {
      crons: ["0 7 * * *"],
      maxRunsPerDay: 4,
      purpose:
        "Daily seo-watcher sweep — fetch the endpoint, compare the metric to the baseline, and draft a recommendation if it moved.",
    },
  },

  resources: { memory: "128MB" },
});
