# Gates: independent Incus recovery observer

Scope: enable only a policy pinned to a verified live instance and old certificate; recover only a real unknown effect.

- [x] G1: The durable CREATE readback supplies exact instance, scope, generation, and credential fingerprint, or proves no observer is needed.
  EVIDENCE: [stopped DB readback](../docs/validation/2026-09-24-isolated-db-readback.md) found CREATE `62633686-a1bc-4b93-b87a-54fdbc96c2fd` in `OUTCOME_UNKNOWN`, generation 1, scope `incus-qualification`, key `live-fixture-20260924`, saved connection revision 1 and Incus project `ezharness`. The saved connection and binding derive exact instance `ezh-6b3b9dde8ce9a4cc358f04db0d5cbde1`. Fresh server trust readback found one restricted `engine` client entry; its PEM converted to DER has SHA-256 `fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622`. The [NixOS observer activation packet](https://github.com/EZArchy/nixos/pull/7) pins both values. This proves the target identity, not the CREATE outcome.
- [ ] G2: The final server plan, policy digest, generation, and rollback are reviewed before any server write.
  EVIDENCE: pending
- [ ] G3: The observer gate is active and denies wrong key, shell, forwarding, wrong project, and stale credential; or no recovery is needed.
  EVIDENCE: The observer generation is now active and negative SSH checks passed, but a successful no-effect readback needs the separate old-client certificate revocation and a fresh recovery check.
- [ ] G4: The old effect is reconciled without duplicate CREATE, or durable state proves no repair is needed.
  EVIDENCE: pending
