# Gates: Incus PR #303 live completion

Scope: Review and apply a new plan bound to the pinned provider release on the named sandbox server, prove the EZHarness-to-Incus workflow with the isolated app, and close the PR's code and CI gates without claiming unsupported features. The old approved plan is obsolete because its active release declares an all-zero image digest.

- [ ] G1: The corrected release and new setup digest receive separate review; that exact digest is applied and read back as verified; unrelated server resources remain unchanged.
  EVIDENCE: Release `0.1.1` built and verified as `dcde361cc4fe348743c1aafc5272ac5104b025046b1c96273e58dc0b8d6e8bdd`; pending approval `0c634e40-9a21-4d2c-9e03-a0d79dc349b7`. No new server plan or write yet. See `docs/validation/2026-09-23-isolated-incus-release-0.1.1-review.md`.
- [ ] G2: The activated Incus provider passes the isolated app's authenticated mTLS probe and cannot access an unapproved project.
  EVIDENCE: pending
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
