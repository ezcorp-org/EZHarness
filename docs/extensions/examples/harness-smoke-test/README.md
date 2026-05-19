# harness-smoke-test

Canonical regression fixture for the **deterministic & loop-proof
extension builder**.

This is the exact extension an in-app agent built (conversation
`92ac355d…`), "installed", and then looped on — the user kept saying
"install it / yes" while the agent re-asserted success and hallucinated
"use the ping tool". The post-mortem found four non-prompt-fixable
causes; this fixture exists so every fix stays wired:

- **Idempotent install** — `ezcorp ext install ./harness-smoke-test`
  twice refreshes in place instead of throwing a raw
  `Failed query: insert into "extensions"` unique error.
- **Deterministic acceptance** — the `smokeTest` block makes
  `ezcorp ext verify ./harness-smoke-test` a machine-checked PASS:
  the host spins the extension up in a sandbox, calls `ping`, and
  asserts the round-tripped output contains `"ok": true`. There is no
  self-judged "looks installed".

## The one tool

`ping` echoes a pretty-printed `{ "ok": true, "echo": <message> }`
envelope. It exists solely to give the acceptance gate something to
round-trip.

## Verify (the only definition of "done")

```bash
bun run index.ts ext verify ./docs/extensions/examples/harness-smoke-test --json
```

Exits `0` with `"pass": true`.
