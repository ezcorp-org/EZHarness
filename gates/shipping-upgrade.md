# Gates: shipping upgrade and production CI

Scope: real previous-source upgrade, backup restore, and required production-image lifecycle checks.

- [ ] U1: Different committed source images preserve exact owned records/data through the supported upgrade path, including legacy adoption rules.
  CHECK: bash scripts/verify-docker-upgrade.sh
  EXPECT: UPGRADE VERIFIED
  EVIDENCE: pending
- [ ] U2: The same seeded backup restores into an owned instance and exact data is readable and usable.
  EVIDENCE: pending
- [ ] U3: PR CI and image release verification run the existing production File Organizer cases with all cases executed and owned cleanup.
  EVIDENCE: pending

