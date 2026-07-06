# Logging Convention

Every extension's host-side code (integration daemons, reverse-RPC handlers, spawn
bridges, route helpers — anything that runs in the EZCorp host process on an
extension's behalf) MUST log through one shared convention. This gives operators a
single, predictable way to **see what an extension is doing** and to **turn on verbose
debug output for one extension** without drowning in the whole platform's logs.

> Scope: this is about **host-side** logging via the structured `logger`
> (`src/logger.ts`). Code running inside the sandboxed extension subprocess logs
> through the SDK's `ctx.log` surface instead — that is a separate channel and is not
> covered here.

---

## The Convention

Obtain your logger via `extensionLogger(name, component?)` from `src/logger.ts` — never
call `logger.child(...)` directly in extension code:

```ts
import { extensionLogger } from "../logger";

const log = extensionLogger("github-projects", "daemon");
// subsystem === "ext.github-projects.daemon"
```

- `name` — the extension's manifest slug (the `name` in `ezcorp.config.ts`).
- `component` — optional sub-part (`daemon`, `handler`, `spawn`, `connect`, …). Omit it
  for a single-module extension (`extensionLogger("my-ext")` → `ext.my-ext`).

This places every extension log under the **`ext.<name>[.<component>]`** subsystem
namespace, which is what makes the on/off toggle below ergonomic.

---

## Turning logging on/off — `EZCORP_DEBUG`

Set the `EZCORP_DEBUG` environment variable to raise selected subsystems to `debug`
**without** flipping the global `LOG_LEVEL` (which would be a whole-process firehose):

| `EZCORP_DEBUG` value | Effect |
|---|---|
| _unset / empty_ | No override — the global `LOG_LEVEL` (default `info`) applies. |
| `1`, `true`, `*`, `all` | Debug for **every** subsystem. |
| `ext` | Debug for **all** extensions (every `ext.*`). |
| `ext.github-projects` | Debug for **one** extension — all its components. |
| `ext.github-projects,preview.reaper` | Comma list; debug for each entry (exact match, or anything namespaced under `entry + "."`). |

`EZCORP_DEBUG` only ever **raises** verbosity for matching subsystems; it never lowers
it. It is read per log call, so it takes effect as soon as the process sees the env.
In the dev/prod containers, env is fixed at container creation — set `EZCORP_DEBUG` in
the compose env and recreate the container to flip debug on.

---

## Levels

Pick the level so the **default-visible** output (`info` and above) tells the whole
story at a glance, and `debug` carries the per-item detail an operator opts into.

- **`info`** — state transitions and once-per-cycle summaries an operator should see by
  default: daemon started, a poll sweep's counts, a board connected/disconnected. Keep
  these low-frequency and high-signal (one line per sweep, not one per item).
- **`debug`** — per-item / per-step detail: each trigger detected, each row skipped,
  the due-check math. Hidden unless `EZCORP_DEBUG`/`LOG_LEVEL` selects it.
- **`warn`** — a recoverable degrade: auth failed, rate-limited, an auto-action errored
  but the loop continued.
- **`error`** — an unexpected failure (also persisted to the error log). Most extension
  daemons should degrade-and-continue with `warn` rather than throw.

---

## Structured fields, not string interpolation

Pass context as the second-argument object, not baked into the message string (the
message stays a stable, greppable constant; fields stay queryable):

```ts
log.info("github-projects poll sweep", { enabledLinks, due, fetched, triggers, newProposals });
log.warn("github-projects link degraded", { linkId, projectId, error: String(err) });
```

Conventions:

- Keep message strings **single-line** (a multi-line template literal can confuse
  bun's `--coverage` line attribution).
- Reuse stable field names across an extension: `linkId`, `projectId`, `itemNodeId`,
  `proposalId`, `userId`, `error: String(err)`.
- **Never log secrets.** No token, PAT, password, or other credential plaintext — log
  only non-sensitive metadata (e.g. `authMode`, a token *length*, never the value).

---

## Reference adopter

`github-projects` follows this convention end-to-end:
`ext.github-projects.daemon` (poller), `.handler` (reverse-RPC), `.spawn` (auto-spawn).
`EZCORP_DEBUG=ext.github-projects` lights up all three. See
`src/integrations/github-projects/daemon.ts` for the poll-sweep summary pattern.
