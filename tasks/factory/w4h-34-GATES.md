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
  EVIDENCE: tests/postgres/factory-notification-sender.test.ts (13 pass), red/notification-sender-pg.log.
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
- [x] G9 evaluator leg (heavy, gated-flock w4h34-evaluator3, exit 0 at 380d3c568): promtool check and test pass every
  forced case; each of the ten inverted rules fails its cases; a live Prometheus with the self-hosted config and
  target lists, over a real installation on PostgreSQL, fires nothing when quiet and all ten alerts, each with its C11
  action, when forced (4 pass). EVIDENCE: proof/evaluator-test.log, proof/live-alerts.json. Two earlier tries are red
  evidence: try1 (the container's user could not read 0600 files; fixed in afcb2d169) and try2 (nine of ten fired;
  the validator-streak defect fixed in 380d3c568).
- [x] G10 delivery leg (heavy, gated-flock w4h34-delivery2, exit 0 at afcb2d169): a real approval request and a real
  uncertain release reach a receiver in a Podman container once each, signed, without run, tenant or secret; a
  re-drive and a restarted sender add nothing; inbox actions keep authority and uncertainty (2 pass, 32 expects).
  EVIDENCE: proof/delivery-test.log, proof/delivery-received.json. try1 passed both tests and failed only its 5 s
  afterAll (container stop grace); fixed in the bound test.
- [ ] G11 the orchestrator commit and its Node coverage leg. EVIDENCE: proof/commit4-status.log, proof/node-coverage.log.
- [x] G12 static: Biome clean, tsc clean on every changed file, factory boundaries PASS, gate integrity PASS, new-file
  and patch coverage PASS at each commit.

## Named gaps

- `hosted-supervisor-metrics-address`: on the hosted profile the supervisor binds `/metrics` on host loopback, so the
  platform's Prometheus cannot reach it and `FactoryMetricsTargetDown` names it. It shares the cause of W16's
  `hosted-supervisor-address`.
- SMTP: refused by name; not delivered by this package (team-lead ruling 3).
- `sandbox_escape`: no detector exists in the product; the denial counter has the `cross_tenant_broker` kind only,
  pending team-lead's ruling.
