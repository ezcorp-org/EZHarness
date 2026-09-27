# Gates: a typed provider error settles, so the run ends failed with its reason (W03f)

Branch `wp/w03f-provider-settle`, from `integ/w00` `d2bc674c7`. Receipts:
`/tmp/factory-platform-evidence/w03f/` (`receipts/*.json`, `logs/*.log`, `proof/`).

## The defect

W19a's `control-missing-model` disclosed it: a guest's model call that a provider refused
(Ollama's 404 for a missing model) left its run held forever. The one-hop provider threw a plain
error and dropped the usage the provider's error answer reported; the broker settled the operation
`failed` with a generic code and no usage; the guest's failed result therefore could not claim a
measured total; the stop found one operation, so W03e's no-operations rule did not apply, and it
kept the reservation uncertain; reconciliation, which settles only `uncertain` operations carrying
a provider receipt, named `factory_usage_hold_unresolved: no-operation-receipt` on every pass.

## The fix

- SDK: `provider_auth_failed` and `provider_rate_limited` beside `provider_unavailable`; a refused
  model response may carry the settled `operation`, which the guest copies into its result.
  Generated schema and Python validator follow.
- Provider: an error answer becomes a typed failure (401, 403 to auth; 429 to rate limit; anything
  else, including an unclassifiable message, to `provider_unavailable`) carrying the provider's own
  measured usage and a digest of the answer. An aborted stream or an unsettleable cost carries none.
- Broker and journal: the failed operation carries the typed code and that evidence.
- Stop: a confirmed stop of an attempt that did not complete settles from its journal, never from
  the guest's claimed usage. No operation: W03e's `no-operations` zero. Every operation completed or
  failed with measured usage: source `operations`, the journal's model cost and tokens, compute at
  the reserved bound, basis `provider-error: ...` or `operations: ...`. Otherwise, or when the result
  reports a held cost, the hold stays.
- Migration `add-factory-usage-operations` widens the three settlement CHECKs, after the fence and
  regrant migrations, before recovery.
- Graph proof: both W19a controls end `failed`, settled; `eb7b8b8c5`'s guest-claimed zero is superseded.
- Kernel (finding (a), lead ruling): a node failed with `provider_auth_failed` is not retried while
  attempts remain; `provider_rate_limited` and `provider_unavailable` keep the retry and its backoff.
- Late answers (finding (b), lead ruling): a hold whose operations are still prepared or dispatched
  names them (`operation-not-settled` with their ids). A provider that answers after the attempt's
  stop was confirmed parks its receipt and usage on the dispatched operation through
  `reconcileLate`; reconciliation settles it and W05b clears the kernel. No evidence: the hold stays, named.
- Closes the W01e/W03 follow-up "settled operation evidence on the model response" (handoff
  2026-09-24): a provider refusal carries the operation the host settled, and the guest copies it.

## Gates

- [x] G1: M1, W14's quarantine-under-live-attempt hold is identified by path.
  CHECK: `w14-repro.sh` under the heavy lock (the 12-test lane, then the product database read before the stack stops)
  EXPECT: the quarantined run's stop is `no-operations` settled (W03e path), and web.log names no hold
  EVIDENCE: `receipts/m1-w14-repro.attempt-2.json` at `1c8a9a23e`: 12/12; run `b9525101`'s stop `sealed-launch`
  `stopped`, one settlement `no-operations` with its basis, known 0; every reservation settled; 0 holds.
  Attempt 1 (log evidence only: 12/12, 0 holds against 158 before W03e) had a void read, below.

- [x] G2: Lifecycle cases per error class, with the negative control on today's behaviour.
  CHECK: `bun test ./src/__tests__/factory-task-stops.test.ts`; `negative-control.sh`
  EXPECT: all pass at the head; with only the base `task-stops.ts`, exactly the five W03f expectations fail
  EVIDENCE: `receipts/negative-control.attempt-1.json` (29/5 base, 34/0 head at `4ba07e94f`)

- [ ] G2b: Findings (a) and (b), red first.
  CHECK: `retry-red.sh` and `hold-red.sh` before the fix; the kernel and stop suites after; the guest-model-journal unit test
  EXPECT: red on exactly the new cases (auth retried; hold unnamed, then the late hold refused); green after
  EVIDENCE: `receipts/retry-red.attempt-1.json`, `logs/retry-red-kernel-recheck.log`, `receipts/hold-red.attempt-{1,2}.json`; PostgreSQL rerun in the next session

- [ ] G2c: A guest that rebuilds or alters the settled failed operation is refused as a journal mismatch.
  CHECK: the guest-model route suite
  EXPECT: the pre-W03f rebuild, a lowered usage and a changed receipt each pass result validation and are refused by the journal
  EVIDENCE: next session's `pg-factory-guest-model-route` and the coverage leg

- [ ] G3: Real PostgreSQL producers and schema parity, and the reference-data guest (two-packer rule).
  CHECK: `tests/postgres/factory-task-stops`, `factory-migration-restart`, `factory-schema`, `factory-guest-model-journal`, `factory-guest-model-route`, `factory-reference-data`; `reference-data/journey.integration` on Podman; all under the heavy lock
  EXPECT: all pass
  EVIDENCE: `receipts/pg-*.attempt-*.json`, `receipts/reference-journey.attempt-*.json`. At `1c8a9a23e` (before (a) and (b)):
  task-stops 34/0, migration-restart 19/0, schema 2/0, guest-model-journal 2/0, guest-model-route 17/0 (attempt 1).

- [ ] G4: The graph proof, both controls ending failed.
  CHECK: `run.sh all` under the heavy lock
  EXPECT: both modes three of three; `control-no-pin` and `control-missing-model` pass, each run `failed`, never held, settled at the reserved compute bound; forced-failure control as before; `summary.json` passed
  EVIDENCE: `receipts/graph-proof.attempt-*.json`, `proof/summary.json`

- [ ] G5: Coverage and static checks.
  CHECK: the coverage leg; `BASE_REF=d2bc674c7` new-file and patch gates; typecheck, lint, boundaries, gate integrity; `python-quality.sh test`
  EXPECT: 100 percent of the new migration and every changed line; all exit 0
  EVIDENCE: `receipts/cov-*.json`, `receipts/gate-*.json`, `receipts/static-*.json`

## Disclosed

- Credential misdirection (lead ruling, record it): M1 attempt 1's `w14-repro.sh` sourced a file
  that sets `PGPORT` without exporting it, so `psql` presented the proof database's credentials to
  the other PostgreSQL on 127.0.0.1:5432 (the user's application container). It stayed on this
  host and failed authentication. The script now exports `PGPORT` and, before any password is
  presented, checks that it equals the proof container's published port; otherwise it exits.
- The graph-proof leg of the first session failed at the guest build (TS2307 on
  `console-types.ts`), a regression from the W14 merge in `guest-package.ts`, not W03f. It reruns
  once W14b lands.
- Retry rule scope: only `provider_auth_failed` is non-retryable, as ruled. `model_pin_mismatch` is
  refused before any claim and fails the same way on a retry too; the graph proof's nodes allow one
  attempt, so it is unchanged here.
