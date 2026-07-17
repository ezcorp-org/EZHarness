# seo-watcher — "plug in your data source" (flagship loop)

Watch **one number** in a structured JSON endpoint, and when it moves, have an
AI draft a recommendation for a human to approve. That's the whole loop — and
the shape is deliberately generic, because **an SEO ranking, a competitor's
price, and a support-ticket count are all the same thing: a number in a JSON
response.** Point it at yours and it works unchanged. It is the Phase-5 flagship
of the Loops campaign — the first loop whose `check` reaches **outside** the
project (a `ctx.fetch` of a third-party endpoint) rather than reading local git.

```
trigger (daily cron | run_seo_watch tool)
  → check    : ctx.fetch a STRUCTURED JSON endpoint, extract a numeric metric
               via a closed dot-path, threshold-compare it to the durable
               baseline cursor (sandbox-gated fetch, NO LLM)
      · unchanged / below-threshold → skip (a logged non-event)
      · moved past the threshold → advance the baseline, enrich the input
  → act      : ctx.llm reviews the change → a proposal (kind "artifact") that
               PARKS the run for approval
  → approve  : finalize — publish the recommendation to the artifact trail
  → decline  : discard — nothing published
```

## Plug in your data source — the template

The extension ships pointed at an illustrative `api.example.com`. To make it
yours, change **two** things and reinstall:

1. **Endpoint URL** → your structured JSON endpoint (add its host to the
   `network` allowlist in `ezcorp.config.ts` first — that allowlist is the
   security boundary, not a suggestion). Prefer **https** endpoints — the
   allowlist matches hosts, not schemes. Two honesty notes on that boundary:
   the platform vets the *initial* URL only (a followed redirect is not
   re-classified), which is why this loop fetches with `redirect: "manual"`
   and treats any 3xx as a skip — keep that if you copy this template; and
   the fetched body is untrusted (it is fenced behind a per-call random
   nonce before it ever reaches the review model — a static fence would be
   forgeable by a hostile endpoint).
2. **Metric pointer** → a dot-path to the number inside that JSON
   (`price`, `data.rank`, `results.0.position` — numeric array indices work).

Then pick a **threshold**: alert when the value *changes at all*, goes *above* a
number, or goes *below* one. Same loop, three data sources:

| You want to watch | Endpoint returns | Pointer | Threshold |
|---|---|---|---|
| An SEO ranking | `{"results":[{"position":8}]}` | `results.0.position` | below 5 |
| A competitor's price | `{"price":"12.99"}` | `price` | changed |
| Support-ticket volume | `{"data":{"open":142}}` | `data.open` | above 100 |

## Structured endpoints only — messy HTML is out of scope for `check`

The `check` runs on `LoopCheckContext`, which by construction has **no `llm`** —
the type system forbids parsing the response with a model. So the `check` can
only read **structured** JSON (a numeric pointer); it cannot scrape a rendered
HTML page. This is deliberate: a deterministic `check` must stay deterministic
and cheap so it can run on every daily tick without a model in the loop. If your
source is messy HTML, put a small JSON shim in front of it (or a scraping API
that returns JSON) — the LLM interpretation belongs in `act`, over a value the
`check` already resolved, never in the gate that decides whether to spend a
model call at all.

## Recommend-and-approve only — no consequential action

This loop **never changes a price, sends an email, or files a ticket.** Its only
side effect is publishing a recommendation artifact once a human approves. That
is the safe template shape you copy first: read a signal, get an AI opinion,
approve it. Once you trust it, you extend `finalize` toward a real action — but
the starting point takes no irreversible step on its own.

## The fetched endpoint is untrusted — fenced, and never on autopilot

The endpoint is attacker-controllable (a third party, or anyone who can poison
what it returns), so the loop is declared **`contentTrust: "untrusted-input"`**.
Two consequences:

- **The sample is fenced.** Before the review model ever sees the response, the
  raw body is size-capped and wrapped in an explicit `----- BEGIN/END UNTRUSTED
  ENDPOINT SAMPLE -----` block with an injection caution. It is content to
  interpret, never instructions to follow (the docs-updater precedent). The
  trusted figures — the metric, the direction, the trigger — are stated by the
  system prompt, not read back out of the sample.
- **Autopilot is never offered.** Phase 8's trust graduation reads the
  `untrusted-input` stamp and refuses to auto-approve this loop. Human approval
  is the structural backstop, by design — declaring `contentTrust` can only
  *add* the marker, never clear it.

## At-most-once baseline

The baseline cursor (`loop:seo-watcher:cursor`) advances **in `check`**, the
moment a new reading differs from the last — before `act` runs, at most once per
fire. So "unchanged" always means "same as the last reading we saw", and a
recommendation that never gets drafted or approved does **not** re-fire on the
next sweep for the same value. `maxConcurrent: 1` keeps a slow daily sweep from
overlapping a manual run and double-advancing.

## `decidedBy` is host-stamped

Approve / Decline are the dashboard's per-run row actions. The host events route
stamps `PageActionEvent.userId` from the authenticated session — the client body
cannot carry a `userId`, so the acting identity can never be forged. The row
action threads that host-stamped `event.userId` into `approveRun` / `declineRun`
as `decidedBy`, written verbatim onto the LOCKED approval label (the Phase-9 eval
signal) and the `loops:approval_resolved` audit mirror. See
[docs/extensions/loops.md](../../loops.md#decidedby-is-host-stamped--never-trusted-from-extension-code).

## Settings

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Watch the endpoint and draft when the metric moves. |
| `endpoint_url` | `""` | The structured JSON endpoint. Blank = the loop skips. Host must be in the `network` allowlist. |
| `metric_pointer` | `""` | Dot-path to the numeric metric. Blank = the loop skips. |
| `threshold_op` | `changed` | `changed` / `gt` (above) / `lt` (below). |
| `threshold_value` | `""` | The number for `gt`/`lt`. Blank with those = skip. Ignored for `changed`. |
| `metric_label` | `""` | Human label shown in the recommendation. |
| `llm_provider` | `google` | Review model provider. |
| `llm_model` | `""` | Model id override. Blank = a sensible per-provider default. |

## Try it (demo)

1. Enable **seo-watcher**, set **Endpoint URL** to a structured JSON endpoint
   (and add its host to the `network` allowlist in `ezcorp.config.ts`), and set
   the **Metric pointer**. Optionally choose an above/below threshold.
2. Run on demand with the `run_seo_watch` tool (or wait for the daily 07:00
   cron). When the metric has moved past the threshold, it drafts a
   recommendation and parks it for approval.
3. Open the **seo-watcher** Hub page. A parked run shows the metric move plus
   **Approve** / **Decline** buttons.
4. **Approve** → the recommendation is published to the artifact trail.
   **Decline** → it is discarded. Either decision is captured as a durable,
   host-stamped approval label.

## See also

- [docs/extensions/loops.md](../../loops.md) — the `defineLoop` primitive + the
  approval / `decidedBy` / staleness / content-trust reference.
- [`docs-updater`](../docs-updater/index.ts) — the sibling flagship: a git-cursor
  `check` → deferred coding-agent `act` → a PR `proposal`. Same approve/decline
  shape, a different data source.
- [`repo-activity-notify`](../repo-activity-notify/index.ts) — the read-only
  check-stage trust probe this family builds on.
