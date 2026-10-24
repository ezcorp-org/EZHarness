# Gates: pluggable infrastructure wave 1 Incus setup

- [x] G1: Inspect output is normalized, bounded and contains the facts needed for a setup decision. Evidence: `current-inventory.json`; the inspection and sanitization tests pass.
- [x] G2: Identical inputs produce an identical plan digest with zero model calls. Evidence: `current-plan.json`; the reordered-input determinism test passes.
- [x] G3: Apply is dry-run by default, idempotent and records per-step receipts and safe retry rules. Evidence: `current-dry-run.json`; the dry-run, skip, drift, post-effect and uncertain-result tests pass.
- [x] G4: Verification checks storage, network, restricted project/profile, quotas and scoped access without claiming live qualification. Evidence: `current-verification.json` and `VALIDATION.md`; the result remains blocked and makes no SP04 or SP06 claim.
