# W4G-8: the stdin-fault test fails under the CI's conmon

Brief: `/tmp/factory-platform-evidence/w00/briefs/w4g.md` (amendment 21:55Z, W4G-8). Owner w4f-3, branch `wp/w4g-8` off integ/w00
`842ad9fe1`. Evidence root: `/tmp/factory-platform-evidence/w4g-8/` (report.txt). Hosted log: `w00/wave4g/ci-logs/run2/110562263836.log`
(Coverage shard 0, lines 498-514).

Cause: the CI pins conmon 2.2.1 (the release binary, built without journald) by an `[engine] conmon_path` drop-in
(scripts/lib/extension-runner-conmon.sh), and ubuntu's podman defaults to the journald log driver. The product guest and every other
podman run in packages/@ezcorp/extension-runner/tests/podman.integration.test.ts pass `--log-driver=none`. The controlled fault "the
superseded stdin channel is what used to kill the guest with its supervisor" (added in 9156b824a) reproduces the previous transport, which
ran with `--log-driver=none` (9156b824a^:podman.ts), but left the flag out, so conmon was asked to log to journald and exited 1.

Reproduction: the same conmon release binary (checksum 1d97294c...), the same drop-in content, placed in a scratch HOME's
`.config/containers/containers.conf.d` with a storage.conf pinned to this user's store, because the runner's command helper passes only
PATH, HOME, XDG_RUNTIME_DIR and the D-Bus address to podman (an env override never reaches it: unfaithful-envoverride-*.log).

| Requirement | Red | Green | Commit |
|---|---|---|---|
| R1 reproduce the hosted failure faithfully | red-ci-one.log, red-ci-file.log: "[conmon:e]: Include journald in compilation path..." / "conmon failed: exit status 1"; file 18 pass 1 fail (the hosted shape); control red-host-one.log passes on this host's conmon | n/a | n/a |
| R2 fix the root cause: the fault's podman run states the transport's log driver | the same test without the flag is red-ci-one.log | green-ci-one.log 1/1, green-ci-file.log 19/19 (CI conmon), green-host-file.log 19/19 (host conmon); hook 19/19 (commit1-hook.log) | 9a027714d |

Hook list per commit: 1 (the podman suite, run under the heavy lock), 0 (this docs commit).
