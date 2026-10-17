# Gates: isolated app dedicated-UID cutover

Scope: preserve the isolated app's state while moving it into supervised services.

- [ ] G1: Sealed settings and source identity are verified under a real traffic hold.
  EVIDENCE: The restored source holder is PID 708161, start ticks 30357176, on boot `12e34c4a-efb4-4b11-8e95-8b74e262b5b5`. A reversible local TCP hold and runner-first stop are prepared and their read-only checks pass. No hold rule, receipt, or sealed `/etc/ezharness` file exists yet. See [action packet](../docs/validation/2026-09-24-dedicated-cutover-readiness.md).
- [ ] G2: Database and project tree move with digest, ownership, and rollback copies verified.
  EVIDENCE: The source database and projects remain under the live dev-owned `/tmp/ezh-incus-isolated-app.QMhk6Qhv` parent. Target, quarantine, and rollback paths are absent. A private project-stage script is prepared but not run. See [action packet](../docs/validation/2026-09-24-dedicated-cutover-readiness.md).
- [ ] G3: Dedicated runner and app services start; old fixture, health, and project access pass.
  EVIDENCE: Disposable UID 62040 app smoke returned HTTP 200 and UID 62041 rootless Podman ran a pinned image with a temporary store; both left no new process or data. These used the installed pre-PR #303 bundle. Both dedicated units are loaded but inactive with MainPID 0. The restored old Vite process owns port 4301. The new runtime token and socket are absent; UID 62041 still has a user session and Podman pause process. No dedicated-service or authenticated-runner readback has run. See [action packet](../docs/validation/2026-09-24-dedicated-cutover-readiness.md).
- [ ] G4: Rollback guards and failure evidence are recorded; no unrelated app or runner is changed.
  EVIDENCE: The prior DB-copy restart failed without the GCC library path; the restored app is healthy with it. The action packet pins that path, exact hold-rule rollback, and a guarded DB restore script. No hold, DB stage receipt, project digest, or live rollback test exists. This review changed no service or data. See [action packet](../docs/validation/2026-09-24-dedicated-cutover-readiness.md).
