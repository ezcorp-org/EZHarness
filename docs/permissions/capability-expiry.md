# Why was my grant expired?

Trust ages. A permission you granted to an extension three months ago
isn't necessarily a permission you'd grant today — the extension may
have been updated, your project may have moved on, the threat
landscape may have shifted. EZCorp v1.3 added an hourly sweep that
revokes permission grants past a configurable lifetime and re-prompts
you so you can make a fresh trust decision.

## The default TTL

Most capabilities default to **90 days** and a few sensitive ones are
tighter. Per-capability TTL overrides are v1.5; today the table lives
in `src/extensions/perm-expiry-config.ts` and is locked at install.

| Capability | TTL | Why |
|---|---|---|
| `filesystem` (write) | 30 days | Highest blast radius. |
| `shell` | 30 days | Effectively unrestricted. |
| `filesystem` (read-only) | 90 days | Lower risk. |
| `network` (per-host allowlist) | 90 days | Allowlist already narrows scope. |
| `env` | 90 days | Static credentials should rotate. |
| `llm` | 90 days | Cost-bearing; periodic re-consent. |
| `memory`, `lessons` | 90 days | Cross-conversation persistence. |
| `storage`, `taskEvents`, `appendMessages`, `schedule` | Never | Behavioral or per-extension-isolated. |

The "Always allow" (forever) scope from the four-scope modal is also
subject to expiry — overridable via `EZCORP_PERM_FOREVER_TTL_DAYS`,
default 90. "Forever" is hyperbolic — it means "until the next sweep".

## How you'll see expiry

Two surfaces, both with identical copy (a shared `expiry-copy.ts`
module is the single source of truth for the wording):

### In-chat: the re-approve modal

The next time the extension tries to use the expired capability, the
PDP returns `deny: capability expired` and the same yellow modal you
saw at install renders — except the title now reads
**Re-approve _extension_: _capability_** and the body says how long
ago the grant expired. Buttons:

- **Approve _newTtl_** — re-grants for another full TTL window. All
  users see this.
- **Approve forever (admin only)** — admin role required, both in the
  UI gate and at the `/api/.../reapprove` endpoint.
- **Cancel** — closes the modal. The sweep already revoked the row;
  the cancel just defers the next prompt. Subsequent tool calls will
  re-prompt until you approve.

### On the settings page: the expired-grants banner

`Settings → Extensions → [the extension]` shows a yellow banner listing
"grants that expired in the last 7 days" so you can re-approve
proactively without waiting for a tool call to hit a deny. Useful for
scheduled extensions that run while you aren't watching the chat.

## Re-approve cannot elevate above the install-time ceiling

The default re-approve path is bounded by the original manifest's
declared permissions and your install-time approval. If you originally
narrowed the grant — say the extension declared `network` for two
hosts and you only approved one — re-approve restores the
single-host grant, not the full manifest value. (A separate v1.5
follow-up will preserve the exact narrowed value; today it re-grants
exactly what was active at the moment of expiry.)

A non-admin user **cannot** escalate beyond the manifest ceiling. An
admin using `PUT /api/extensions/[id]/permissions` (the policy-
override endpoint) can — but that's a different endpoint with a
different audit reason ("admin-grant" vs "user-reapprove") so the two
authorities are distinguishable in the audit log.

## Why "forever" also expires

A grant labelled "forever" in the UI lasts as long as the longest TTL
on disk — 90 days, configurable. Three reasons:

1. **Defense against compromise.** If an extension is updated to be
   malicious, an unbounded grant gives it unbounded reach. A 90-day
   ceiling caps the worst case.
2. **Behavioral hygiene.** Asking once a quarter "do you still need
   this?" surfaces extensions you've stopped using.
3. **Revocation drift.** Manual revocation works, but most users never
   open the settings page to clean up. Expiry forces the conversation.

If 90 days is too tight or too loose for your deployment, set
`EZCORP_PERM_FOREVER_TTL_DAYS` in the container environment — the
sweep picks up the new value within an hour without restart.

## Where to find expired grants

- **Per-extension**: `Settings → Extensions → [id]` — banner at the
  top lists the last 7 days of expirations.
- **Across all extensions**: `/audit` (admin only) — filter by
  capability and you'll see `ext:permission-grant-expired` rows in the
  timeline, one per revoked grant.

Each expiry writes an audit row with action
`ext:permission-grant-expired` and metadata
`{capability, scope, ttlMs, ageMs}`, so post-incident forensics can
reconstruct exactly when and why each grant disappeared.
