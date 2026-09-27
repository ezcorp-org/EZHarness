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

## Gates

- [ ] G1: M1, W14's quarantine-under-live-attempt hold is identified by path on this base.
  CHECK: `w14-repro.sh` under the heavy lock (the 12-test lane, then the product database read before the stack stops)
  EXPECT: the quarantined run's stop is `no-operations` settled (W03e path), and web.log names no hold
  EVIDENCE: `receipts/m1-w14-repro.attempt-*.json`, `logs/m1-w14-repro.attempt-*.log`

- [ ] G2: Lifecycle cases per error class, with the negative control on today's behaviour.
  CHECK: `bun test ./src/__tests__/factory-task-stops.test.ts`; `negative-control.sh`
  EXPECT: 34 pass at the head; with only the base `task-stops.ts`, exactly the five W03f expectations fail
  EVIDENCE: `receipts/negative-control.attempt-1.json`

- [ ] G3: Real PostgreSQL producers and schema parity.
  CHECK: `tests/postgres/factory-task-stops`, `factory-migration-restart`, `factory-schema`, `factory-guest-model-journal`, `factory-guest-model-route` under the heavy lock
  EXPECT: all pass
  EVIDENCE: `receipts/pg-*.attempt-*.json`

- [ ] G4: The graph proof, both controls ending failed.
  CHECK: `run.sh all` under the heavy lock
  EXPECT: both modes three of three; `control-no-pin` and `control-missing-model` pass, each run `failed`, never held, settled at the reserved compute bound; forced-failure control as before; `summary.json` passed
  EVIDENCE: `receipts/graph-proof.attempt-*.json`, `proof/summary.json`

- [ ] G5: Coverage and static checks.
  CHECK: the coverage leg; `BASE_REF=d2bc674c7` new-file and patch gates; typecheck, lint, boundaries, gate integrity; `python-quality.sh test`
  EXPECT: 100 percent of the new migration and every changed line; all exit 0
  EVIDENCE: `receipts/cov-*.json`, `receipts/gate-*.json`, `receipts/static-*.json`

## Disclosed

- A node with attempts left retries a typed provider refusal, `provider_auth_failed` included: the
  kernel does not read `retryable`. The graph proof's nodes allow one attempt. Owner: the kernel's.
- Found by reading, not reproduced: an operator cancel confirmed while a model call is still
  `dispatched` keeps the hold, and the product broker may settle that operation afterwards;
  reconciliation settles only `uncertain` operations, so such a hold would not clear. Pre-existing;
  not changed here.
