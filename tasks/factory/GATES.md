# Factory platform acceptance gates

Scope: full platform, all six stages and thirteen contract proofs. Missing real services are failed readiness, never skipped success.

- [ ] S1: Kernel/compiler/simulator and golden domain definitions satisfy F07/F10/F13; SDK build and coverage registered.
  EVIDENCE: pending

- [ ] S2a: Base hardening and token/flag/toolchain proofs pass.
  EVIDENCE: pending

- [ ] S2b: Real Temporal, durable storage, outbox, projections and continuation proofs pass.
  EVIDENCE: pending

- [ ] S2c: Real native/Python bridge, recovery and isolation proofs pass.
  EVIDENCE: pending

- [ ] S2d: Tenant installations, scoped reads, budgets/fencing, pool fairness and GPU allocation proofs pass.
  EVIDENCE: pending

- [ ] S3: Assurance, release authority/reconciliation and delivered notification proofs pass.
  EVIDENCE: pending

- [ ] S4: All package preparation/execution/revocation CPU/GPU isolation proofs pass.
  EVIDENCE: pending

- [ ] S5: Console and all three production domain journeys/composition pass with actual remote receipts.
  EVIDENCE: The authoring console has focused component, route, and mock Chromium proofs, including wide/light/long-label and narrow/dark/reduced-motion captures. The root-owned live factory boot and production domain journeys remain pending.

- [ ] S6: Hosted/self-hosted deployment, restore/load/soak/fault/alerts and provisioning proofs pass.
  EVIDENCE: pending

- [ ] REG: Full application build, lint, types, backend/web/browser regressions and measured coverage pass.
  EVIDENCE: pending

- [ ] AUDIT: All F01–F13 evidence is tied to the final revision and independent review finds no unresolved defect.
  EVIDENCE: pending
