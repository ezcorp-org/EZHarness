# Owned VM seccomp audit check

Run `scripts/shipping-audit-vm.sh` under the shared validation lock. The script
copies `mcp-seccomp.bpf` from the specified immutable candidate image into a
temporary initramfs, then boots that initramfs with the local KVM kernel and
`audit=1`.

Inside the guest, the probe loads the copied production BPF, prints its PID,
calls logged `getpid`, and calls undeclared `io_uring_setup`. The script only
passes when the guest serial log contains an audit `type=1326` row for that
same PID, plus the expected allowed and denied syscall effects.

The guest uses no host network. It changes no host audit or sysctl setting.

The guest loads the unmodified BPF artifact directly with `seccomp(2)`. This
proves the artifact's kernel audit emission and the production reader's exact
PID ingestion. It does not replace the separate production launcher and
descriptor-passing replay, which is required to prove the full bwrap envelope.
