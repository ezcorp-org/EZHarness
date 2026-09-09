# Owned VM seccomp audit check

Run `scripts/shipping-audit-vm.sh` under the shared validation lock. The script
copies the retained MCP launcher, `mcp-seccomp.bpf`, bwrap, shell and their
libraries from the specified immutable candidate image into a temporary
initramfs. It boots that initramfs with the local KVM kernel and `audit=1`.

Inside the guest, the actual launcher passes the filter on descriptor 3 to
bwrap. A test wrapper adds bwrap's `--info-fd 4` metadata so the host can compare
the reported child PID with the probe's PID. The launcher PID differs from its
sandbox child. The probe calls logged `getpid` and undeclared `io_uring_setup`.
The script requires a `getpid` audit `type=1326` record for the exact sandbox
child in one captured kernel window, plus the allowed and denied syscall
effects. In this guest,
the rows are `SCMP_ACT_LOG` (`code=0x7ffc0000`) records, including `getpid` and the
probe's `writev` output. The undeclared `io_uring_setup` returns ENOSYS but has
no audit row, so this receipt does not describe it as audit emission.

The second arm removes only the filter setting. It uses the same syscall
assertions and must fail because `io_uring_setup` no longer returns ENOSYS.
This control proves that the filter caused the denied result.

`shipping-audit-ingest.ts` runs the production parser and delegates every
observed write to the real audit query in a fresh, owned on-disk PGlite
database. It awaits all writes, compares exact record counts and fields, then
requires zero persisted rows for a wrong PID. Existing or external databases
are refused.

The guest uses no host network. It changes no host audit or sysctl setting.
The VM command has a 45-second bound and removes its owned resources.

This is a retained MCP component check. The current v4 Podman runner uses
`packages/@ezcorp/extension-runner/seccomp.json`, a different profile. The
retained MCP soak reader currently has no live runtime caller. This result
does not certify a live v4 audit pipeline or imply that the reader is wired
to it. The canonical opt-in test is
`EZCORP_AUDIT_PROOF=1 bun test ./src/__tests__/mcp-seccomp-enforce-integration.test.ts`.
It requires a suitable local KVM/kernel/compiler environment and is not a
required hosted CI job.
