# Gates: sandbox preset integration and review

Scope: Integrate both leaves, exercise the production boundary, and perform an adversarial independent review.

- [x] G1: Focused contract and host tests pass together on the final source.
  CHECK: bun test ./packages/@ezcorp/extension-contract/src/sandbox-presets.test.ts ./src/extensions/v4/sandbox-preset-qualification.test.ts
  EXPECT: /pass/
  EVIDENCE: Pinned Bun 1.3.14 final isolated runs: contract package 25/25, qualification 4/4, lifecycle 9/9, candidate verifier 12/12, runtime 25/25, and publication 10/10.

- [x] G2: Typecheck and schema checks pass on the integrated source.
  CHECK: bun run typecheck && bun run --cwd packages/@ezcorp/extension-contract schema:check
  EXPECT: /pass/
  EVIDENCE: Pinned Bun 1.3.14: repository typecheck passed; schema check passed 1/1; contract build passed.

- [x] G3: An independent Sol reviewer finds no unresolved correctness, bypass, compatibility, or DRY defect.
  EVIDENCE: Independent Sol review found three correctness gaps and one DRY issue. All four were fixed and re-reviewed. Final reviewer result: no unresolved findings; affected shared-fixture suites pass 56/56 and diff check is clean.

- [x] G4: The implementation documents what is enforced now and does not claim live-provider SP04/SP06 evidence that does not exist.
  EVIDENCE: Contract README and task review state that the production verifier rejects sandbox provider releases until C06 exists, and that no live connection subsystem or SP04/SP06 evidence exists.
