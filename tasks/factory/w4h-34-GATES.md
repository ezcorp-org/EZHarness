# W4H-34 (W17): outbound notifications, factory metrics, C11 alerts

Brief: /tmp/factory-platform-evidence/w00/briefs/w4h-34.md. Base 390c49a90. Branch wp/w4h-34-w17-notifications-metrics.
Evidence: /tmp/factory-platform-evidence/w4h-34/ (red/, logs/, cov/, proof/). Rows: the contracts document, C11,
"Outbound notifications (W4H-34)" N1-N9, "Metrics (W4H-34)" M1-M4, "Alert rules (W4H-34)".

## What exists now

- Sender: `src/factory/notification-sender.ts` on its own C02 queue (`factory_notification_sends`). A lapsed lease is
  reclaimed for this queue only (`expiredLease: "reclaim"`); every other queue user keeps `outcome_unknown`.
- Readiness: `notification-send` runs when a destination is declared and stays held, with its reason, until the first
  durable delivered send; an unreadable secret or CA holds the role on its typed cause.
- Metrics: `src/factory/observability/`: one registry, the installation and pool collectors, one `node:http` listener
  for Bun and Node, served by the harness, pool, gateway, orchestrator and supervisor.
- Alerts: one source for the self-hosted rule file and the hosted `PrometheusRule`; the fleet host runs a pinned
  Prometheus; the hosted profile gets a `PodMonitor` per tenant namespace and one for the pool.

## Gates

- [x] G1 rows first: 66d507aae (rows), approved by team-lead 2026-10-16; N7 amended for the attempt bound.
- [x] G2 queue reclaim is sender-only: the default test proves `outcome_unknown` unchanged, so a reclaim-for-all mutant
  is red. EVIDENCE: red/queue.log, src/delivery-queue/durable-delivery-queue.test.ts.
- [x] G3 sender on real PostgreSQL: fan-out once per notification and destination, expiry, command deadline, signed
  send, 5xx/429/unreachable/timeout retry under one key, 4xx and exhausted to dead letter, destination removed, corrupt
  rows, an unsendable or corrupt notification recorded once in dead letter, confirmation across restart.
  EVIDENCE: tests/postgres/factory-notification-sender.test.ts (18 pass at 2f35dbd35), red/notification-sender-pg.log.
- [x] G4 exactly-once under re-drive: a real child process SIGKILLed after its request reached the receiver and
  before the settlement; the next sender re-sends with the same key and delivery ID; 2 physical, 1 logical.
- [x] G5 readiness N8: held with no destination, held on an unreadable secret, held until the first durable delivery,
  then running and republished at once. EVIDENCE: runtime-workers, runtime-composition and installation-startup tests.
- [x] G6 metrics M1-M4: registry bounds and refusals; collectors on real PostgreSQL (12 and 1 pass); one scrape of all
  five services over HTTP with the token, every series checked, no identifier, no marker secret
  (tests/postgres/factory-metrics-scrape.test.ts).
- [x] G7 rules: each rule's condition and action equal the C11 table; every expression reads registered families; each
  rule has a firing case, a quiet case and a threshold edge; the shipped files equal the render; the runbook lists
  every alert. EVIDENCE: src/factory/observability/alert-rules.test.ts.
- [x] G8 both profiles configured: Compose (`deploy/factory/compose/host.yml` prometheus service, image equal to
  scripts/test-images.json, file-discovered targets the host rewrites) and Kubernetes (`PrometheusRule`, PodMonitors,
  metrics Secret, network policy). EVIDENCE: host, compose-profile, kubernetes-profile, deployment tests.
- [x] G9 evaluator leg (gated-flock w4h34-final, exit 0 at 6033ff283; 2f35dbd35 differs only by one test type
  annotation): promtool passes every forced case; each inverted rule fails its cases; a live Prometheus over a real
  installation fires nothing when quiet, with an old dead-letter send present (F4), and all ten alerts with their C11
  actions when forced (4 pass). The image was pulled once by digest (no 429/5xx) and removed by name after the legs.
  EVIDENCE: proof/evaluator-test.log, proof/live-alerts.json, proof/evaluator-pull.log, proof/final-status.log.
  Earlier red tries: proof/try1/ (0600 files unreadable, fixed in afcb2d169), proof/try2/ (nine of ten, fixed in 380d3c568).
- [x] G10 delivery leg (same run, exit 0): a real approval request and a real uncertain release reach a receiver in a
  Podman container once each, signed, without run, tenant or secret; a replay of the captured approval request inside
  the 5 s receiver tolerance is deduplicated on its key (logical count stays 2), and after it is refused with 401 as
  stale (N3); a re-drive and a restarted sender add nothing; inbox actions keep authority and uncertainty (2 pass).
  EVIDENCE: proof/delivery-test.log, proof/delivery-received.json.
- [x] G11 in-lock commits: 3b78c6415 (old 1d3a1b8ed) and 2f35dbd35 (old 6033ff283) were committed under gated-flock;
  their hooks ran the orchestrator package (102 pass) and both bound tests (delivery 2, evaluator 4).
  EVIDENCE: proof/commit4-status.log, proof/final-status.log, fold2/status.log.
- [x] G12 static at 2f35dbd35: `bun run typecheck` exit 0, 0 errors (fold2/typecheck.log; again at 29f2d60dc,
  proof/typecheck-29f2d60dc.log); biome clean on the 17 files
  changed by the review fixes; factory boundaries, boundaries, C11 lane inventory and gate integrity PASS
  (proof/static-refreeze.log); new-file coverage PASS (10 files) and patch coverage PASS (33 files) over
  390c49a90..2f35dbd35, 28 Bun suites and the Node orchestrator lcov merged (cov/refreeze/).
- [x] G13 review fixes F1-F10, each red first with a mutant (red/, green/, red/mutant-*.log):

  | Fix | Commit | Red | Mutant (red) |
  | --- | --- | --- | --- |
  | F1 deduplication ID is the fn1 key, no ':' join | 5d01bf658 | red/F-sender-pg.log | mutant-F1-old-separator |
  | F2 a corrupt send row is quarantined | 5d01bf658 | red/F-sender-pg.log | mutant-F2-no-quarantine |
  | F3 the hosted supervisor has a PodMonitor | a699cf3fa | red/F3-supervisor-scrape.log | mutant-F3-no-supervisor-podmonitor |
  | F4 SendStuck fires on growth, resolves by itself | 45b34dcae (row), 2d4c81d52, 2f35dbd35 (live) | red/F4-F6-rules.log | mutant-F4-presence-rule |
  | F5 the fan-out probe uses the index on all four columns | 5d01bf658, 29f2d60dc (analyzed 20,000-row plan) | red/F-sender-pg.log | mutant-F5-unindexed-probe, mutant-F5-prefix-only-probe |
  | F6 projection lag past a missing batch, gap gauge | 47326a99b (row), 2d4c81d52 | red/F4-F6-rules.log, red/F6-collector.log | mutant-F6-no-gap-term, mutant-F6-lag-at-cursor-only |
  | F7 the gateway's ready gauge reads its database | 7d5bf129a | red/F7-ready-probe.log | mutant-F7-ignore-health, mutant-F7-no-probe-timeout |
  | F8 shutdown releases without an attempt | 5d01bf658 | red/F8-queue-release.log, red/F-sender-pg.log | mutant-F8-abort-as-unreachable |
  | F9 concurrent scrapes share one collection | 7d5bf129a | red/F9-single-flight.log | mutant-F9-no-single-flight |
  | F10 one allowed set per family and label per render | cbf5270ec | red/F10-render-sets.log | mutant-F10-set-per-sample |

  Also in 5d01bf658: attempts_exhausted on the last allowed attempt (mutant-attempts-exhausted-mapping), claim progress
  (mutant-claim-progress), the send half after a fan-out fault, and the N3 receiver tolerance (red/N3-receiver-tolerance.log).
- [x] G14 every commit stands alone (ruling 8). Fold 1 (Addendum E): the orchestrator parser part of 1d3a1b8ed folded
  into 7e5f02888 -> 6705f04d8 (fixup, non-interactive autosquash); old head 3006bf680 kept on proof/w4h-34-prefold
  (fold/sha-map.txt). The per-commit check then found a27d92fe4's test fix one commit after its defect and one F10 test
  type error; fold 2 put both where the defects were: 1d3a1b8ed -> 3b78c6415, F10 -> cbf5270ec, a27d92fe4 dropped
  as empty; old head 6033ff283 kept on proof/w4h-34-prefold2 (fold2/sha-map.txt). Each commit of 390c49a90..2f35dbd35
  passes the backend, tests and orchestrator-package typechecks and its own changed suites (proof/percommit/,
  fold2/status.log: new trees checked, unchanged trees matched to green results). 29f2d60dc (test only) ran its
  suite in its hook (18 pass) and the repository typecheck at it is clean.

- [x] G15 refusal codes (team-lead ruling: three causes, three codes): row 1af14f9f8 (N6) amended first, then 4d0afe1cf.
  notification_payload_invalid (cannot be built), notification_payload_too_large (over 4 KiB), factory_notification_corrupt
  (stored notification no longer decodes); a test holds the declared dead-letter codes equal to the N6 row's.
  Red: red/codes-unit.log (3 fail), red/codes-pg.log (1 fail). Green: green/codes-*.log. Mutants red:
  mutant-codes-one-for-all, mutant-codes-size-as-invalid.
- [x] G16 validator-8 Addendum G at the frozen head:
  G1 F-manifest: G13 and G15. G2 fold range-diffs: fold/range-diff.txt, fold2/range-diff.txt (only the folded commits
  differ; a27d92fe4 is dropped); stand-alone per commit: G14. G3 typecheck in the lock: exit 0, 0 errors at 4d0afe1cf
  (proof/typecheck-4d0afe1cf.log). G4 legs: delivery re-run at 4d0afe1cf (gated-flock w4h34-delivery3, 2 pass); the
  evaluator ran at 6033ff283, and none of its 189 bundled inputs changed since (scratch/closure/). Coverage at
  4d0afe1cf: new-file PASS (10), patch PASS (33) (cov/refreeze/).

## Named gaps

- `hosted-supervisor-metrics-address`: on the hosted profile the supervisor binds `/metrics` on host loopback, so the
  platform's Prometheus cannot reach it and `FactoryMetricsTargetDown` names it. It shares the cause of W16's
  `hosted-supervisor-address`.
- SMTP: refused by name; not delivered by this package (team-lead ruling 3).
- sandbox-escape detection has no producer; A8 covers broker denials only; a detector is a separate isolation package
  (team-lead ruling: `sandbox_escape` stays out of the label set).
