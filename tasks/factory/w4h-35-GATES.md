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

- [ ] G1: Contract rows in C12 (contracts document) before any code.
- [ ] G2: Resource profiles: `cpu-only` and `gpu` fleet shapes; a `gpu-host` runner profile refused under `cpu-only`;
  the pool config carries the GPU hosts and profile file only under `gpu`. Red first.
- [ ] G3: Key material: format, 0600/0700 and owner verified; master-key rotation and revocation; idempotent rerun;
  only the orchestration process receives the material in both profiles. Red first.
- [ ] G4: Deployment locks cover the Kubernetes templates and a rendered fixture installation. Red first.
- [ ] G5: Kubernetes deployment target (apply, ready, remove, purge) with Secrets from the delivery directories. Red first.
- [ ] G6: Hosted shared-service readiness and address; hosted trusted ingress with the proof header. Red first.
- [ ] G7: Static legs: typecheck, lint, boundaries, gate integrity, focused suites with lcov, 100 percent of changed lines.
- [ ] G8: Heavy leg A (kind in Podman, gated-flock): an installation from clean state through step 7.
- [ ] G9: Heavy leg B (kind in Podman, gated-flock): a canary readiness failure stops the wave.
- [ ] G10: CPU-only profile runs the reference pack end to end with the test provider (no model call).
- [ ] G11: Operator documentation for both profiles.
- [ ] G12: Freeze: report.txt with shas, evidence, lessons.
