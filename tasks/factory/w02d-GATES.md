# Gates: W02d the GPU lease consumer

Branch `wp/w02d-gpu-lease`, cut from `integ/w00` at `a24a619ad` (W01h and W01i are in; W16's provisioning is not).
Evidence: `/tmp/factory-platform-evidence/w02d/`. Brief: `/tmp/factory-platform-evidence/w00/briefs/w02d.md`;
plan and rulings: `w02d/plan.md`.

Status: IN PROGRESS. R2 and R7b wait for W16 (the profile registry). R8 and one finding wait for the
coordinator's ruling. R6 is being measured (P2).

| Commit | What it is |
| --- | --- |
| `a2b7b408d` | R1: startup refuses a runner profile whose `gpu-host` is not one whole host |
| `4f347dc14` | R3: the dispatch preflight grants a held GPU lease its recorded devices, or refuses it by name |
| `0f8bdd8c1` | R4: the host refuses a granted device it does not have, before any container exists |
| `d7b3ae94b` | R5: measured; a GPU attempt's lease renews through W01h's loop unchanged, and lapses the same way |
| `3428eba36` | R7: a supervisor-confirmed GPU stop confirms and settles; the host stays held for its reimage |
| `1f7d56010` | R9: a class the pool cannot serve fails its run by name and releases the unused hold |

## Base reproductions (G1), on the real stack

Tree `a2b7b408d` in a detached checkout (`.worktrees/w02d-repro`), W19a's graph proof copied to
`w02d/harness*` with the brief's configuration (one host id is the installation host and the GPU host; `combine`
on class `gpu` = `{cpu 1, gpu-host 1}`). Under the heavy lock; bun and bunx asserted 1.3.14.

| Run | Receipt | Result |
| --- | --- | --- |
| P1 (F1) | `w02d/p1/RECEIPT.txt` | RED: the gpu-host lease launched with `devices: []`; the run succeeded; nothing refused |
| P3 (F4) | `w02d/p3/RECEIPT.txt` | RED: the GPU stop stayed `uncertain` (pool `awaiting-gpu-reimage`); hold `uncertain`; run stayed `running` |
| P5 (R9) | `w02d/p5/RECEIPT.txt` | RED: the pool rejected, the kernel cancelled the denied admission, the run stayed `running`, the hold `held` |
| P2 (R5, R6) | `w02d/p2/` | queued |

## Rules

- R1 (G2): `startup-config.test.ts` red on the base (1 fail), green 50/0.
- R3: `attempt-preflight.test.ts` red (4 fail), green 16/0. `PoolLease.deviceProfile` is optional until R2 fills it;
  until then every `gpu-host` lease is refused `factory_preflight_device_profile_missing` (fails closed).
- R4: supervisor red against the check removed (2 fail), green 13/0; launch route 422 `device_unavailable` red (1),
  green 19/0; remote runtime `RUNNER_DEVICE_UNAVAILABLE`, not retryable, red (1), green 15/0. The tenant check
  (W01i) runs before the device check. `device_unavailable` is an additive freeze-section-6 code.
- R5: measured, no source change: the same renewal count and fence as a CPU attempt; a lapse is `RUNNER_LEASE_LOST`.
- R7: `poolStopConfirmed` in `pool/ledger.ts`, used by the pool's `acknowledgeStopped` and the task stop's confirm.
  Pool red against the old rule (1), green 25/0 on PGlite and PostgreSQL; stop suite red on the base, green 33/0.
- R9: kernel red on the base kernel (1), green 11/0 (SDK 234/0); admission release red (1), green 15/0.

## R8: the refused dispatch (parked)

- Built red first and parked as `92bdc1f22` on the local branch `wip/w02d-r8`; it commits onto this branch after
  integ is merged with W09h, whose no-operations basis "nothing launched, all zero" replaces the provisional
  budget settle (coordinator ruling). Red: stop suite with the recorder a no-op, 2 fail; migration with the worker
  clause removed, 1 fail. Green: stop suite 37/0 (PGlite), PostgreSQL old-shape migration 1/0.
- Q5 revised (coordinator, 2026-09-27): Q5 said "no stop row". C03 decides it: capacity is freed only on a
  supervisor's signed word, and a held lease does not prove nothing started, because the remote runtime launches
  before acknowledgeStart. So the mechanism that already carries a signed host stop, the stop row and the existing
  stop worker, is the truthful one. The row is of source `dispatch-refused`, with `attempt_id` NULL (the attempt
  foreign keys stay; a NULL skips them, so no synthetic launch or execution row exists), `worker_id`, and
  `cancel_command_id` = the refused `dispatch-node` command, tied together by a CHECK.
- Lock order: the refused-dispatch stop locks only its stop row. There is no launch row, so
  FACTORY_STOP_LAUNCH_LOCK_ORDER (the stop row, then the launch row) holds.
- R9 switches its zero settlement to the same W09h basis at that merge (coordinator ruling): today it settles the
  budget hold all zero with the pool's rejection digest and records no usage settlement or basis.

## Blocked on W09h (w19a)

- A run stopped while a node waits for compute admission (for example a GPU host queued behind a reimage) never
  ends: its `cancel-node` names the request-admission command and no stop route settles it. W02d's P3 and P5 head
  runs proceed only when the host is not queued; the queued-host case waits for W09h.

## Open

- R2 and R7b: need W16's `pool/gpu-host-profiles.ts` (the registry and its tenant binding).
- R6: P2 measures a 45 s queue wait after admission.
- R8: parked until the W09h merge (above).
