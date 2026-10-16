# W4H-35: W16 hosted Kubernetes profile, GPU and CPU-only resource profiles, key material life, operator docs

Brief: /tmp/factory-platform-evidence/w00/briefs/w4h-35.md. Branch `wp/w4h-35-w16-k8s-profiles` from 390c49a90.
Worktree: /home/dev/work/EZCorp/EZHarness/.worktrees/w4h-35 (archy via --worktree config). Evidence:
/tmp/factory-platform-evidence/w4h-35/ (paths below are relative to it). Pins: Bun 1.4.2, Node 24.14.1.

## Starting point (report 1)

- The Kubernetes profile is a renderer only (`kubernetes-profile.ts`). No deployment target applies it. Four rows in
  `tasks/factory/w16-GATES.md` stop a hosted start: `hosted-supervisor-readiness`, `hosted-supervisor-address`,
  `hosted-ingress-snippet`, `hosted-host-identity-shared`. The kind proof was admission only, on a node image by tag.
- The deployment lock check sees the Dockerfile and the Compose templates, not Kubernetes.
- The fleet has no resource profile: `host.ts` gives the pool no GPU host and no GPU profile file.
- Key material generation, format and refusals exist (`secrets.ts`); master-key rotation and revocation do not.

## Gates

- [x] G1: Contract rows in C12 (contracts document) before any code.
  EVIDENCE: 621d03cb1 (rows 1-8); row 5 amended per the ruling (fleet-level profile; the fleet host is the one GPU host).
- [x] G2: Resource profiles: `cpu-only` and `gpu` fleet shapes; a `gpu-host` runner profile refused under `cpu-only`;
  the pool config carries the GPU hosts and profile file only under `gpu`. Red first.
  CHECK: `bun test --timeout 60000 ./src/factory/provisioning/fleet.test.ts ./src/factory/provisioning/host.test.ts ./scripts/factory-fleet-init-local.test.ts`
  EVIDENCE: red `logs/g2-red-saved.log` (shape unknown); green `logs/g2-green.log`.
- [x] G3: Key material: format, 0600/0700 and owner verified; master-key rotation and revocation; idempotent rerun;
  only the orchestration process receives the material in both profiles. Red first.
  CHECK: `bun test --timeout 60000 ./src/factory/provisioning/secrets.test.ts ./src/factory/provisioning/deployment.test.ts ./src/factory/provisioning/fleet-cli.test.ts ./src/factory/provisioning/kubernetes-target.test.ts`, and the PostgreSQL provisioner suite under the heavy lock
  EVIDENCE: red `logs/g3-red.log` (missing exports); green `logs/g3-green.log`; the Kubernetes apply test proves only the orchestrator's Secret holds `master.key` and `wraps.json`.
- [x] G4: Deployment locks cover the Kubernetes templates and every Dockerfile download (sha256; the pinned podman-remote v5.8.7 client); the Kubernetes renderer refuses an unpinned image; one digest-pin rule (`image-pin.ts`). Red first.
  CHECK: `bun test ./scripts/check-factory-deployment-locks.test.ts ./src/factory/provisioning/kubernetes-profile.test.ts`; `bun scripts/check-factory-deployment-locks.ts`
  EVIDENCE: 6 red then green; real repository 14 references, all pinned (kind node v1.36.1 by digest).
- [x] G5: Kubernetes deployment target (apply, ready, remove, stop, start, purge) and host target, Secrets from the
  delivery directories on kubectl stdin only, server-side apply. Red first. Unit-proven; the live leg is G8.
  CHECK: `bun test ./src/factory/provisioning/kubernetes-target.test.ts ./src/factory/provisioning/fleet-profile.test.ts`
  NOTE: `fleet-profile.test.ts` was written after the extraction it tests (disclosed); three mutants of the profile module each turn it red (`logs/fleet-profile-mutant-{1,2,3}.log`).
- [x] G6: Hosted shared-service readiness and address; hosted trusted ingress with the proof header. Red first. Unit-proven;
  the live leg is G8.
  CHECK: pool readiness/routes/process, supervisor services/process, service-readiness, service-probes, startup-config,
  runtime-composition, installation-startup, readiness-route-client, ingress, kubernetes-profile, deployment, host suites
  EVIDENCE: `logs/g6-pool-process-red.log`, `logs/g6-supervisor-process-red.log`; coverage batches `cov/b1`..`cov/b4`:
  every changed line hit except the fleet composition and the local fleet writer, which only the PostgreSQL suite reaches.
- [ ] G7: Static legs: typecheck, lint, boundaries, gate integrity, focused suites with lcov, 100 percent of changed lines.
- [ ] G8: Heavy leg A (kind in Podman, gated-flock): an installation from clean state through step 7.
- [ ] G9: Heavy leg B (kind in Podman, gated-flock): a canary readiness failure stops the wave.
- [ ] G10: CPU-only profile runs the reference pack end to end with the test provider (no model call).
- [ ] G11: Operator documentation for both profiles.
- [ ] G12: Freeze: report.txt with shas, evidence, lessons.
