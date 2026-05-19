# The four-scope permission modal

When an extension tries to use a capability that hasn't been approved
yet — fetching from a new host, reading a file outside its declared
sandbox, executing a shell command — the chat pauses and shows a yellow
modal asking you to approve the request. v1.3 added four scope buttons
to that modal so you can pick how long the approval lasts instead of
being forced into "yes, forever" or "no, ever".

## When the modal appears

The runtime calls the Policy Decision Point on every privileged
operation. If the extension already has a matching always-allow row for
this user + scope (set, conversation, project, or forever), the call
goes through silently. Otherwise the modal renders inline in the chat
turn and the tool call hangs until you decide.

The modal shows:

- The extension name (badge in the top-right of the prompt)
- What it's asking for, in plain English ("Write to filesystem:
  `/tmp/foo.txt`", "Execute shell commands", etc.)
- A short security note when the capability is high-risk

## The four scopes

| Button | What it means | How long it lasts |
|---|---|---|
| **Allow until restart** | All future calls of this capability in this server session. | Until the server restarts (the grant lives in memory only). |
| **Allow for this conversation** | All future calls of this capability inside the current chat. | Until the conversation is deleted. Sibling chats still prompt. |
| **Allow for this project** | All future calls in any conversation belonging to the active project. | 30 days, then re-prompt. |
| **Always allow** | Every conversation, every project, every user session. | 90 days by default (override: `EZCORP_PERM_FOREVER_TTL_DAYS`). Admin-gated. |
| **Deny** | Reject this call. | Same as "Allow until restart" inverted — denies once, prompts again next call. |

The default focus is on **Allow until restart**, not "Always allow" — the
spec explicitly forbids defaulting to forever. If you hit Enter without
thinking, you've granted the smallest possible amount of trust.

## Why "Always allow" is admin-gated

A "forever" grant is the only scope that survives across users and
projects. A user who picks it once for a malicious extension hands
that extension a permanent foothold across the whole installation, so
v1.3 gates the button on the admin role at the API layer (defense in
depth: the server rejects `scope: "forever"` from non-admin callers
even if the DOM is tampered with). Regular users can still pick
session, conversation, or project scope without approval.

## A worked example

You install a weather extension. The first time it tries to call
`api.weather.example.com`, the modal pops in:

> **weather** wants to: `Use capability network` — `api.weather.example.com`

You pick **Allow for this conversation**. The chat continues, the tool
call resolves, the extension fetches the forecast.

Two days later you open a fresh chat and ask the same extension for a
forecast. The modal appears again — your previous grant was scoped to
the original conversation only. This time you pick **Allow for this
project** because you have a "Travel planning" project where you'll
keep using the extension, and 30 days of friction-free calls is fine.
A month later you'll be asked again, and you can decide whether you
still trust it.

## How to revoke later

Three ways to take a grant back:

1. **Settings → Extensions → [the extension] → Permissions** — flip the
   permission off. The corresponding always-allow rows are cleared and
   the next tool call re-prompts.
2. **Wait for expiry.** Project (30 days) and forever (90 days) scopes
   age out automatically. You'll see the
   [expired-grants banner](capability-expiry.md) on the settings page
   listing what was revoked in the last 7 days.
3. **`/audit` page** — admin only. The drill-down at
   [`/extensions/[id]/audit`](audit-drilldown.md) shows recent calls
   and current grants side by side, useful for spotting an extension
   that's been doing more than you expected before pulling the plug.

Session-scoped grants disappear on server restart automatically — they
live in memory, never on disk.
