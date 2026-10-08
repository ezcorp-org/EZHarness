# Incus release runtime contract

A staged release has an empty `.ezcorp` directory with mode `0755`. The default
release verifier and smoke test keep this rule.

The service mounts private runtime storage over that directory. Its protected
supervisor configuration must set
`admissionAuthority.runtimeSource` to the exact absolute source path, for example
`/var/lib/ezharness-qual-data/runtime`. The supervisor supplies its existing
`appUid` and `appGid`. No runtime source is inferred from environment variables.

In this context, verification requires:

- A canonical source path outside the release, with no symbolic links.
- A source parent owned by the release owner and app group, with mode `0730`.
- Source ancestors owned by the release owner, with no group or other write access.
- Source and target directories owned by the app UID/GID, with mode `0700`.
- An exact target mount entry and equal source/target device and inode numbers.
- The full immutable release inventory, modes, and owner checks.

Admission records the runtime device and inode at launch. Each observation
checks the mount contract and that original identity. Replacing both source and
target requires a service restart.

Each readiness request scans the complete immutable tree before and after the
protected readback. Each scan reads fresh metadata once per entry, including
the root and symbolic links. It rejects duplicate paths and more than 120000
entries. It does not reuse metadata from an earlier request.

The readback has an eight-second maximum inside an eleven-second total success
deadline. Both scans count against that total. A readback within its own limit
can still fail if the complete request is late. The client keeps its twelve-second
timeout, and the admission proof keeps its fifteen-second lifetime. Scan deadline
checks are cooperative; the client still closes the socket if a filesystem call
stalls. A timed-out readback process group is killed and the process is reaped.

Readiness failure uses the public cause `readiness_unavailable`. Private structured
warnings distinguish only `deadline_exceeded`, `authority_rejected`, and
`unavailable`. Raw verifier errors do not enter that response or warning.

The complete managed Bun client/socket regression is
`scripts/incus/incus-admission-readiness-consumer.test.py`. It covers composed
deadlines, immutable changes between scans, and malformed readback output.

The actual mount/startup regression is in
`scripts/incus/incus-admission-authority.test.py`. It runs through the real
supervisor, verifier, privilege drop, and child process. It is also included in
the existing supervisor Bun test wrapper. Run it with:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/incus/incus-admission-authority.test.py
```

This test requires Linux, util-linux `unshare`, `newuidmap` and `newgidmap`,
unprivileged user and mount namespaces, and a subordinate UID/GID range of at
least 62041 IDs for the test user. It uses a private mount namespace and root
folder. It binds the available Python runtime directories, including `/usr` and
`/lib` on Ubuntu or `/nix/store` on NixOS. A missing prerequisite fails the test;
it does not skip the regression. The test changes no host service or host root
file.
