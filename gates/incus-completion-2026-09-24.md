# Gates: EZHarness Incus sandbox completion

Scope: complete and verify the first real EZHarness-to-Incus feature flow, recovery controls, and PR readiness without claiming unsupported portability.

- [ ] G1: The reviewed AMD-only Incus ingress generation is active and the isolated EZHarness provider probe succeeds.
  EVIDENCE: firewall generation `/nix/store/12lwzhkzc0rlqsk1cna5vbpnzjzpnfcl-nixos-system-sandbox-server-26.05.20260430.15f4ee4` is active and persisted; AMD TCP 8443 reaches the daemon. The pinned-leaf TLS fix now reaches Incus, but probe returns `helper_version_unverified` until live qualification.
- [ ] G2: The isolated app applies an exact reviewed capacity plan and creates, uses, reconnects to, and deletes an EZHarness-owned sandbox.
  EVIDENCE: capacity digest `85f193ca2ea34fcbc46617d2fda4611a4e175aa6ae126d5b5b5a30dae16f064b` applied. First fixture CREATE `62633686-a1bc-4b93-b87a-54fdbc96c2fd` is `OUTCOME_UNKNOWN`; direct scoped Incus inventory has no instance. Reconciliation is required before retry. Image `2f8868763f6cbec0452ab0d4db82ecb315c4aff1b9a3d2d1777cd878017e9fa1` passed direct Docker/Compose canary under UID/GID 1000 and left zero instances.
- [ ] G3: Host-owned negative network and cross-sandbox tests pass, including guest denial of host management access.
  EVIDENCE: one disposable guest from pinned image had bridge IPv4 and DNS, could not reach host bridge/Tailnet ports 22 or 8443, and was deleted. AMD still reached management. Cross-sandbox and EZHarness-owned tests remain pending.
- [ ] G4: Production qualification recovery has independent receipt verification, durable process continuation, and same-operation lost-destroy-reply proof.
  EVIDENCE: pending
- [ ] G5: PR #303 includes current main, has no unresolved conflicts, and all required hosted checks pass at its final head.
  EVIDENCE: pending
- [ ] G6: The documented v1 release gates have evidence; any unimplemented capability stays disabled and is listed precisely.
  EVIDENCE: pending
