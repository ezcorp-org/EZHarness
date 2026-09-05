# CI memory-limit diagnosis

- [x] Reproduce the real Ubuntu monitor failure without changing assertions or limits.
- [x] Isolate the failing component by changing only conmon.
- [x] Verify the exact pinned upstream release asset and rerun the unchanged real kernel test.
- [x] Test HTTPS/checksum/architecture enforcement and install ordering; retain the real kernel probe.
- [ ] Confirm the repaired Ubuntu GitHub Actions lane passes.

Ubuntu 24.04 Podman 4.9.3, conmon 2.1.10, and crun 1.14.1 were extracted with
their runtime libraries and run unprivileged on the local cgroup-v2 host, using
a separate storage root. This is a real toolchain reproduction, not a full
Ubuntu-kernel VM. All original isolation flags and the pinned Bun image remain.
The initial runner kernel-control probe passes, but the actual memory test fails
at the same assertion as CI: `/tmp/ez-oom-ubuntu49-red.log`. The stopped container
reports `OOMKilled=false`, not a premature running-state query. No claim is made
that exit code 137 alone identifies the cause.

The same Podman and crun pass after changing only conmon to 2.2.1. The exact
upstream amd64 asset passes its published SHA-256 and the unchanged kernel test:
`/tmp/ez-oom-ubuntu49-pinned-conmon.log`, one test, 12 assertions. The original
local Podman 5.8.2 baseline also passes. Twelve executable setup tests pass with
42 assertions; shell syntax and formatting checks pass. No runner production
logic, timeouts, test assertions, resource limits, or security controls change.

The CI installer uses a root-owned versioned monitor, an explicit configuration
drop-in, and an exact selected-path check. The [upstream release](https://github.com/containers/conmon/releases/tag/v2.2.1)
publishes the pinned amd64 and arm64 SHA-256 values. Only the amd64 binary was
executed locally; arm64 selection is covered by the install fixture.

Full unchanged Podman integration suite with Ubuntu 4.9.3 and the exact pinned
monitor: `/tmp/ez-ubuntu49-pinned-conmon-full.log`, 10 tests and 55 assertions pass.
Actual system configuration selection is verified in a private mount namespace:
the real installer writes the monitor as `root:root`, mode `0755`, then execution
drops to the normal user. Ubuntu Podman reads the real
`/etc/containers/containers.conf.d` drop-in and reports exactly
`/usr/local/libexec/ezcorp-extension-runner/conmon-2.2.1`, without a `--conmon` or
`CONTAINERS_CONF` override: `/tmp/ez-conmon-system-dropin-proof3.log`.
No extension runs privileged and the shared host configuration is unchanged.
The fixture uses a fresh runtime directory because reusing Podman's existing
pause process would re-enter its older mount namespace and hide the fixture.
