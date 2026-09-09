# Runner CI delegation

- [x] Reproduce the hosted CI `Cannot set property Delegate` failure against a real systemd manager.
- [x] Test supported runtime unit drop-in provisioning, controller checks, ordering, and fail-closed behavior.
- [x] Verify supported static-unit delegation against a real systemd manager and run the unchanged rootless kernel probe.
- [ ] Verify the repaired path on Ubuntu GitHub Actions before claiming CI is green.

The failing command also fails on local systemd 260. The existing NixOS host
configuration had hidden this because local validation used `--probe`, not
`--install`. systemd does not accept changing this property on a loaded static
service through `set-property`. Use a per-user unit drop-in before restarting the
ephemeral CI user manager, and reject a job running inside that manager.

Primary references: [systemd delegation](https://systemd.io/CGROUP_DELEGATION/)
and [rootless controller setup](https://rootlesscontaine.rs/getting-started/common/cgroup2/).
The real Podman initialization probe remains mandatory; checking unit properties
alone does not prove kernel isolation.

Local evidence: seven executable shell-fixture tests pass with 21 assertions;
both scripts pass `bash -n`. A disposable real `Type=exec`, unprivileged systemd
service reproduces the old command's rejection, then accepts the runtime drop-in
after reload/restart: `Delegate=yes`, `DelegateControllers=cpu memory pids`, and
the service user owns and can write its `cgroup.subtree_control`. The disposable
unit and drop-in are removed afterward. `Type=exec` waits for process setup;
the real user manager uses `Type=notify` and also waits for readiness.
`/tmp/ez-ci-delegation-probe.log` records the unchanged real Podman probe passing.
Ubuntu hosted execution remains a required, separate gate.
