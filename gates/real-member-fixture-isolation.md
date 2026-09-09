# Real member fixture isolation

- [x] Confirm both actual suite failures before changing fixtures.
  EVIDENCE: `/tmp/ez-ci-real-entire1.log` records a shared caller owner's declaration-write HTTP 429. `/tmp/ez-ci-real-entire2.log` records invitation acceptance HTTP 429 after creating a new owner for each caller case.
- [x] Give each coherent caller scenario group its own real invited member session; keep keys and conversations isolated per case.
  EVIDENCE: each describe owns one invited, profile-checked member session and disposes its request context after the group. Every case still creates its own member-role API key and conversation through the real HTTP surface.
- [x] Retain exact role, owner, device callback, declaration rejection, revocation and run assertions without retries, sleeps, skips or production limit changes.
  EVIDENCE: all original case assertions remain. The ownership case now also checks a real administrator-owned conversation returns 404, in addition to the original unknown-ID check.
- [x] Pass all seven real caller cases and report the broader suite status separately.
  EVIDENCE: `/tmp/lifecycle-caller-group-real.log`, seven tests pass on fresh rootless runner + real PGlite + production HTTP server, own port 4191. The declaration cases complete in 96/45/55 ms and all four runtime cases complete in 222/195/168/131 ms, so the proof does not depend on delays between cases. Full web TypeScript passes in `/tmp/lifecycle-member-fixture-types.log`; scoped lint and diff checks pass. Parent owns the final combined 53-case run after independent source fixes are merged.

The declaration group exercises one client identity's declaration lifecycle. The round-trip group exercises a separate client identity's runtime behavior. Invalid declarations are rejected before the production per-user write limiter. No numeric pool or rate-budget allocation is introduced.
