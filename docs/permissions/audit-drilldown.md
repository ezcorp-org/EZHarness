# Reading the audit drill-down

EZCorp logs every privileged operation an extension performs through
the central Policy Decision Point: every approved capability call,
every denial, every grant expiration. The audit view is where you
inspect the running record. This page covers the two surfaces — the
global `/audit` admin page and the per-extension drill-down at
`/extensions/[id]/audit` — plus the in-chat capability event pills
that surface the same data inline.

## `/audit` — global admin page

Admin-only. Three sections top to bottom:

### 24h stats strip

Four cards across the top:

- **24h calls** — total capability calls in the last 24 hours.
- **24h denials** — denied calls. Red text when non-zero. A
  non-zero denial count usually means an extension is asking for
  something it isn't granted; click into it to see what.
- **24h LLM spend** — approximate USD across all extensions calling
  the LLM capability. Approximate because provider billing latency
  can drift; use it for trends, not for invoicing.
- **Top chattiest** — the three extensions with the most calls.
  Useful for spotting a runaway scheduled extension.

A second card below shows **Top LLM spenders (24h)** — same idea,
sorted by cost.

### Filters

Search input + dropdowns for extension, capability, user, and a
"Denials only" checkbox. Filters compose: pick `capability=llm` +
`Denials only` to see every denied LLM call across the install.

### Timeline

Each row is one audit entry: icon, label, extension badge, summary
line, timestamp on the right. `denied` rows get a red pill. `Load
more` paginates via cursor.

## `/extensions/[id]/audit` — per-extension drill-down

Click any extension on the Library or marketplace and the page header
links to its drill-down. Two columns on desktop:

### Left: filter pills + timeline

Six pills across the top: **All / LLM / Memory / Lessons / Schedule /
Events / Denials**. Each filters the timeline below to that capability
family. Date-range pickers (From / To) on the right of the pill row.

Each timeline row shows:

| Column | What it means |
|---|---|
| Icon | Capability family at a glance — 🤖 LLM, 🧠 memory, 📚 lessons, 📅 schedule, 📡 events, 🚫 denial. |
| Label | `capability action` (e.g. `llm complete`, `memory write`). |
| Summary | Model name + token count + duration for LLM rows; resource id for memory/lessons. |
| Right side | Duration, cost (LLM only), and the timestamp. |

Click a row to expand it inline — the detail panel shows the redacted
`before` and `after` payloads, the error message and code on denials,
and the raw metadata for governance entries.

### Right: 24h stats + current grants

The right rail pins two cards. The top one is the same 24h stats
shape as the global page, scoped to this extension. The bottom one
("Current grants") lists the keys from
`extensions.grantedPermissions` verbatim — the canonical answer to
"what is this extension actually allowed to do right now?". When you
see a denial in the timeline, cross-reference it against this card to
spot the gap (e.g. timeline says "denied: no `llm:openai` grant",
sidebar shows `llm.providers: ["anthropic"]` — there's your answer).

## Capability event pills in the chat

Built-in extensions emit a `capability-event` message into the chat
each time they use a capability. The chat renders these as one-line
pills (single icon + verb + summary, dim text — they don't dominate
the turn). Click a pill to expand the detail row, which fetches the
underlying `sdkCapabilityCalls` row by id.

Common verbs you'll see:

- 🤖 `called` — LLM completion. Summary shows model + cost.
- 🧠 `read` / `wrote` / `searched` — memory operations.
- 📚 `read` / `wrote` — lessons operations.
- 📅 `scheduled` / `fired` — cron schedule operations.
- 📡 `subscribed to` — event subscriptions.
- 🚫 `denied: <action>` — the call was denied. The pill is the
  shortest path to "what just got blocked and why".

User-installed extensions don't emit pills today (the runtime gates
on a bundled-extension flag); the audit page is the canonical record
for those.

## Common questions

### Why did this extension call fail?

Open the per-extension drill-down, click **Denials**, find the row.
The expanded detail panel shows the error code and message — usually
something like `capability expired`, `host not in allowlist`, or
`grant scope mismatch`. Cross-reference against the **Current grants**
card on the right rail to see what's actually granted. If the
denial reason is "capability expired", you'll have an
[expired-grants banner](capability-expiry.md) on the extension's
settings page; re-approve there.

### What's this extension been doing?

Drill-down → set the **All** pill, leave date filters empty for the
last 24h, scroll. To go deeper than 24h, set a `From` date. To narrow
to one kind of call, click a capability pill (LLM / Memory / etc.).
Sort is always reverse-chronological.

### Did this extension cost me money this month?

Drill-down → **LLM** pill → set `From` to the start of the month.
Each row carries its own cost; the right-rail 24h card aggregates the
last day. There is no cross-month rollup view today (v1.5 candidate).

## What's recorded — and what isn't

Each audit row captures: timestamp, user, extension id, capability,
action, target / resource id, decision, redacted before/after,
duration, cost, error message + code, and the parent audit id chain
for cross-extension calls (so a confused-deputy `A → B` invocation
threads through with full attribution).

What's **not** logged:

- **Per-call argument values verbatim.** The audit row stores a
  redacted summary; secret-shaped strings (looks-like-api-key, etc.)
  are stripped by the redactor. Don't expect to recover the full
  prompt from the audit row.
- **Tool output bodies in full.** For LLM completions, the `after`
  panel shows the response shape, not a verbatim dump. Same redaction
  rules apply.
- **MCP server internals.** The audit row records the host-side
  capability call (e.g. "MCP server X called network for host Y"); it
  does not capture the MCP protocol frames between the host and the
  MCP binary.

There is no automatic audit-log retention policy in v1.3 — rows
accumulate until manually pruned. Plan for log rotation in long-lived
deployments; a built-in retention sweep is on the v1.5 candidate
list.
