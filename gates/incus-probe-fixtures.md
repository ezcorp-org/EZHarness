# Incus control probe fixture gate

Scope: prepare only the AMD-side inputs needed by the four production control denials. The service does not call Incus or claim a live qualification.

- [x] An admin-owned `plan(scope, operationId)` checks the active reviewed release, connection, image, existing host capacity, and a second declared preset without live qualification. It returns exact IDs, file paths, and a digest before local writes.
- [x] `apply(scope, operationId, digest)` creates four distinct private AMD canaries and four user-purpose projects; only the missing-control and drift cases get bindings. The bindings pin the selected release, connection revision, preset and digests. No quota, reservation, operation, or backend resource is created.
- [x] Repeated Apply returns the same receipt. A forged scope, changed digest, or invalid operation ID makes no file or database change.
- [x] A private `plan.json` lets cleanup use the exact saved scope after release disable. Cleanup removes only reviewed canaries, denied admission requests, bindings, and projects. It refuses altered files, new project authority, reservation, or provider operation. Repeated cleanup succeeds.
- [x] Six focused PGlite tests, full typecheck, Biome, production build, and focused LCOV passed. The final focused source has 229/229 lines and 38/38 functions covered.
- [ ] Wire the service through an admin-only same-origin route and run the four denials on the isolated app. The current work is a local fixture seam, not a live qualification result.

The operator configures one existing 0700 root directory on AMD. Requests contain only scope, operation ID, and reviewed digest. The route must not accept a filesystem path or bypass `IncusQualificationStore.authorizeFixture`.
