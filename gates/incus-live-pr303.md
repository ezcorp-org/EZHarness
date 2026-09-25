# Gates: Incus PR #303 live completion

Scope: Review and apply a plan bound to the pinned provider release on the named sandbox server, prove the EZHarness-to-Incus workflow with the isolated app, and close the PR's code and CI gates without claiming unsupported features.

Current status, 25 September 2026: provider release 0.1.2 is approved and active at generation 3. The exact setup plan is approved, applied, and read back as verified. The existing evidence does not include a full independent before/after inventory proving unrelated server resources remained unchanged. The 0.1.2 transport can reach Incus, but no recorded negative call proves that its certificate is denied from an unapproved project. G1 and G2 therefore remain open.

- [ ] G1: The corrected release and new setup digest receive separate review; that exact digest is applied and read back as verified; unrelated server resources remain unchanged.
  EVIDENCE: Release 0.1.2 (`9ec8e626-0a5d-4ed6-9333-a3fd1aa25472`, digest `4c0e2eee0f9105d28a5173ec695bd42c6b84de58233570fb0ffb2dcf03a6ac18`) was separately approved and activated at generation 3. Setup `97edb3a1-80e4-4305-baac-1325930b868d`, digest `d8460b1705715ebebb2596e825cba29d9514d53a2190841336830082d3791fcb`, was approved and re-applied; the app returned `verified` with no failures for its 15 reviewed steps. The plan used the recorded inventory fingerprint and covered the existing pool, bridge, restricted project/profile, listener, and scoped client. The committed record does not include a complete independent post-apply inventory comparison for unrelated resources, so this gate remains open. See [`the release 0.1.2 review`](../docs/validation/2026-09-24-isolated-incus-release-0.1.2-review.md), [`the exact setup review and apply result`](../docs/validation/2026-09-24-post-recovery-incus-setup-review.md), and [`the release approval and active-generation readback`](../docs/validation/2026-09-24-incus-provider-upgrade-identity.md). Historical note: the earlier 0.1.1 plan failed before creating its restricted project because Incus 6.0.6 rejected `restricted.storage-pools.access`; its revised digest is obsolete.
- [ ] G2: The activated Incus provider passes the isolated app's authenticated mTLS probe and cannot access an unapproved project.
  EVIDENCE: The 0.1.2 connection `540e2032-532f-4d8f-9a4e-df50c8e9f43a`, revision 1, returned Incus 6.0.6 through the pinned read-only transport. A diagnostic canary using that transport and preset received GET 404 for its absent instance, GET 200 for the profile, then POST 202 for create; exact-name cleanup succeeded and final project inventory was empty. This is partial transport/lifecycle evidence, not a recorded isolated-app authenticated probe plus denial from an unapproved project. See [`the 0.1.2 setup review`](../docs/validation/2026-09-24-post-recovery-incus-setup-review.md). No negative project-scope result is recorded; G2 remains open.
- [ ] G3: A host-owned real fixture creates, runs, reconnects, and destroys an Incus guest through EZHarness durable control; cleanup inventory is empty.
  EVIDENCE: pending
- [ ] G4: SP01–SP08 qualification uses concrete host and guest observations for the exact release, connection, preset, image, and helper; no synthetic result is accepted.
  EVIDENCE: pending
- [ ] G5: An authorized user feature creates its persistent sandbox; guest read/edit/search/shell, Compose, tests, stop/reconnect, and destroy work through EZHarness with no AMD file fallback.
  EVIDENCE: pending
- [ ] G6: Host, network, quota, resource, secret, and cross-sandbox negative checks for the selected deployment pass without weakening existing gates.
  EVIDENCE: pending
- [ ] G7: Final PR head passes focused tests, build, lint, typecheck, repository gates, hosted CI, and independent code review; draft status and remaining unsupported profiles are reported honestly.
  EVIDENCE: pending
