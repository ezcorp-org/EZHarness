# Gates: shipping upgrade and production CI

Scope: real previous-source upgrade, backup restore, and required production-image lifecycle checks.

- [x] U1: Different committed source images preserve exact owned records/data through the supported upgrade path, including legacy adoption rules.
  CHECK: bash scripts/verify-docker-upgrade.sh
  EXPECT: UPGRADE VERIFIED
  EVIDENCE: Local candidate suite `d2222840` exited 0. Historical source
  `3ec53eaa66409a39d66b502f79d74139ec94dcf2` and candidate source
  `9ca275838faf30666da5dba1c0eba141dd053050` are distinct and enforced by
  `scripts/verify-docker-upgrade.sh:150-163`. The semantic driver compares exact
  owner, installation, workspace, verified release, approval, conversation link,
  tool output, and stored value in `scripts/verify-docker-upgrade-state.ts:77-88`.
  `historical-upgrade` and `legacy-adoption` both exited 0 in
  `docs/validation/extension-v4-shipping/parent/candidate-suite-d2222840/canonical-summary.tsv`; curated
  receipts are under `docs/validation/extension-v4-shipping/parent/candidate-suite-d2222840/`.
  Legacy main is a derived compatibility fixture, not the unmodified historical
  image: its base ID and added asset checksum are recorded in
  `legacy-adoption/provenance.txt` and the curated README.
- [x] U2: The same seeded backup restores into an owned instance and exact data is readable and usable.
  EVIDENCE: `scripts/verify-docker-upgrade.sh:189-196` copies the seeded state to a
  separate root and runs the same exact assertion against the candidate. The raw
  backup path also restores a separate owned volume and checks readiness and
  candidate version at `scripts/verify-docker-upgrade.sh:256-267`. Local receipt:
  `historical-upgrade/controller.txt` records `UPGRADE_STATE_ASSERTED` for both
  candidate and restore, then `upgrade_command_exit=0 upgrade_cleanup_exit=0`.
- [x] U3: PR CI and image release verification run the existing production File Organizer cases with all cases executed and owned cleanup.
  EVIDENCE: Static wiring is present: CI builds the exact candidate and supplies
  `VERIFY_UPGRADE_CANDIDATE_SOURCE="$GITHUB_SHA"` to the required production suite
  at `.github/workflows/ci.yml:207-229`; image-release verification invokes the same suite at `.github/workflows/release-image.yml:119-128`. The suite invokes the File Organizer
  runtime replay at `scripts/verify-shipping-production-suite.sh:76-79`. Local
  candidate receipt `file-organizer/verification.txt` records 13 passed tests; its
  `command.txt` records `command_exit=0`, `app_log_exit=0`, and
  `owned_cleanup_exit=0`. No hosted CI run for the current head is claimed here.
