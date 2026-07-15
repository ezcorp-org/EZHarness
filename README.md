# EZHarness

The remote harness for [EZCorp](https://github.com/ezcorp-org/EZCorp) — the
standalone home of the tooling that lets an external runner (a Playwright
suite, a CI script, or another agent) **configure**, **drive**, **observe**,
and **deterministically test** a live EZCorp instance over HTTP + SSE.

## Packages

| Package | What |
|---|---|
| [`@ezcorp/harness-client`](packages/@ezcorp/harness-client) | Remote-control client: auth, settings, conversations/runs, runtime-event SSE streaming, extension control + lifecycle, mock-LLM scripting against a test-mode instance. |

The server-side contract this client talks to lives in the EZCorp repo — see
[`docs/harness-contract.md`](https://github.com/ezcorp-org/EZCorp/blob/main/docs/harness-contract.md)
for the two access tiers (control vs determinism), auth bootstrap
(`ezcorp key mint`), and the rules that keep the surface stable. Cross-repo
parity of the runtime-event-name list is enforced from the EZCorp side by its
route-contract CI test, which imports this package.

## Development

Bun-based workspace, same trunk-based lifecycle as EZCorp: branch off `main`
(`feat/ fix/ ci/ docs/ chore/ security/`), open a PR, land all required checks
green plus a non-author review, squash-merge. `main` is always deployable.

```sh
bun install
bun run typecheck   # tsc --noEmit over the workspace
bun run lint        # biome
bun run test        # bun test
bun run build       # emit dist/ for @ezcorp/harness-client
```
