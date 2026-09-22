# Gates: MVP provider declarations

Scope: C01 declarations only; no provider activation or live support claim.

- [x] C1: Authoritative types and generated schema agree.
  EVIDENCE: Parent ran schema:check, exit 0, on integrated commit 9802fef2e.
- [x] C2: Compatibility and invalid declarations are tested.
  EVIDENCE: Parent contract package run: 21 pass, 0 fail; tasks/evidence/pluggable-contract/parent-root-tests.log.
- [x] C3: Changed executable lines are fully covered.
  EVIDENCE: Parent root-invoked coverage and check-patch-coverage: exit 0, one changed source file; tasks/evidence/pluggable-contract/parent-patch-coverage.log.
- [x] C4: Package build succeeds.
  EVIDENCE: Parent ran extension-contract build (tsc -b), exit 0.

The first parent coverage run used the package working directory and emitted package-relative SF paths, so the root patch gate reported missing data. Re-running the exact root-invoked producer fixed the receipt path; no code or gate change was needed.
