# Owned VM seccomp audit check

Run `scripts/shipping-audit-vm.sh` under the shared validation lock. The script
copies `mcp-seccomp.bpf` from the specified immutable candidate image into a
temporary initramfs, then boots that initramfs with the local KVM kernel and
`audit=1`.

Inside the guest, the probe loads the copied production BPF, prints its PID,
calls logged `getpid`, and calls undeclared `io_uring_setup`. The script only
passes when the guest serial log contains an audit `type=1326` row for that
same PID, plus the observed allowed and denied syscall effects. In this guest,
the rows are `SCMP_ACT_LOG` (`code=0x7ffc0000`) records for `getpid` and the
probe's `writev` output. The undeclared `io_uring_setup` returns ENOSYS but has
no audit row, so this receipt does not describe it as audit emission.

The guest uses no host network. It changes no host audit or sysctl setting.

The guest loads the unmodified BPF artifact directly with `seccomp(2)`. This
proves the artifact's kernel audit emission and the production reader's exact
PID ingestion. It does not replace the separate production launcher and
descriptor-passing replay, which remains open for the full bwrap envelope.
It also does not prove that the BPF caused ENOSYS rather than a kernel without
`io_uring_setup`; that needs a no-filter guest control.
