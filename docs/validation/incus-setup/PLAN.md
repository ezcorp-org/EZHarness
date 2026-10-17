# Incus deterministic setup artifact plan

Status: complete for review; live apply is blocked pending certificate and approval
Date: 2026-09-22

- [x] Reinspect the supplied Incus server with read-only commands and retain a sanitized inventory.
- [x] Define closed, bounded recipe and inventory formats with explicit pinned values.
- [x] Implement pure inventory normalization, compatibility checks, ordered plan generation and plan hashing.
- [x] Implement fixed inspect, dry-run apply and post-apply verify commands without model or shell inference.
- [x] Classify retry, reconcile and review-required outcomes and make repeated application converge.
- [x] Test determinism, drift rejection, idempotence, dry-run safety, unknown outcomes and verification failures with Bun 1.3.14.
- [x] Publish the exact current-host plan, validation result and remaining approval/apply steps.

The apply command must remain dry-run unless the caller supplies the explicit execution flag. This task does not authorize that flag against the live server.

## Review

The review artifacts are in this directory. The generated plan is blocked only because the provider public certificate is not available. The final verification confirms that no live server resource changed.
