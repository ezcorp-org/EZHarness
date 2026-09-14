# W01 — decoupling guest lifetime from the supervising process

## The defect

`launchDetached` starts the container with `podman run --detach -i` and then returns
`processSpawn(podman, ["attach", name])`. The supervisor process holds the stdin pipe of that
attach client. When the supervisor dies, the pipe closes, `podman attach` forwards the EOF into
the container's stdin, and the guest exits.

Measured on a faithful reproduction of the real code path (`logs/attach-eof-repro.log`): the
container is `running` while the parent lives and `exited exit=7` at the first observation 250 ms
after `SIGKILL`, where 7 is the guest's own stdin-end handler.

The plan requires the opposite: "Losing the controlling attachment must not terminate the guest or
authorize another effect." The SIGKILL test passed only when a replacement supervisor's attach won
that sub-second race, which is why it failed under the validator's host load. A bounded retry would
have made the test reliably green while the product still violated the rule.

Podman 5.8.2 has no CLI escape. `podman attach --no-stdin` cannot write, and the attach stream is
the only writable path to container stdin, so a client's EOF always reaches the guest.

## Mechanism

A FIFO triple in a per-attempt directory under the runner root, bind-mounted read-only at
`/channel` (see the addendum: the first implementation mounted it read-write, which was a HIGH
severity defect). The container runs a shim that opens `in`, `out`, and `err` with `O_RDWR` and hands
those descriptors to the real extension as its stdin, stdout, and stderr.

`O_RDWR` is the whole trick. A FIFO reader sees EOF only when every writer closes, and the shim
holds a write descriptor for the guest's entire life. No external process's death can EOF it. The
supervisor connects by opening the same FIFOs; its death closes only its own descriptors.

Validated before implementation (`logs/fifo-channel-feasibility.log`, probe at
`fifo-channel-probe.ts`): container `running` after launch, still `running` after a writer's
`SIGKILL`, still `running` afterwards.

Guest termination still has to be observable. The shim exits when the extension exits, which drops
its `O_RDWR` handles, so the host's reader on `out` sees EOF. That EOF is the close signal, taking
the place of the child-process `close` event.

## Files touched, all owned by W01 under freeze section 12

- `packages/@ezcorp/extension-runner/src/protocol.ts` — `FramedExecution` takes a
  `ChildProcessWithoutNullStreams`. It gains a `FramedTransport` interface covering exactly the
  nine members it already uses. `ChildProcessWithoutNullStreams` satisfies that interface
  structurally, so all nine consuming files compile unchanged. Additive; no frame policy changes.
  The bounded-frame limit, the 32-pending cap, duplicate and replayed response-ID rejection, the
  output limit, and the reverse-effect path are untouched.
- `packages/@ezcorp/extension-runner/src/podman.ts` — FIFO creation, the `/channel` mount, the
  shim, a FIFO-backed transport, `attach()` reconnecting to existing FIFOs, channel cleanup.
- `packages/@ezcorp/extension-runner/tests/podman.integration.test.ts` — the deterministic SIGKILL
  case and the controlled-fault variant.

No consumer-facing signature in freeze section 6 changes. `StartRequest`, `Runner`,
`FactoryHostLaunchProtocol`, `FactoryAttemptOpen`, and the device grant are all unchanged.

## How v4 extension behavior stays unchanged

Builds never touch this path: `build()` uses `this.run()` and `this.launch()`, which stay on the
ordinary non-detached child process. Only `startExecution` changes, and its contract is unchanged
because `FramedExecution` behaves identically over the new transport. The full shared Podman suite
is the proof, and it must stay green.

## How the test becomes state-driven

No wall-clock waits and no retry loop.

1. Start the guest from a child supervisor and wait for its `READY` line.
2. `SIGKILL` the child and `await child.exited`, so the kill and its pipe closure are observed
   facts rather than elapsed time.
3. Assert `inspect(workerId)` still reports `running` BEFORE any attach. Under the old design this
   is exactly the assertion that raced; under the new one it is a settled state.
4. Attach from a fresh supervisor, recover, then cancel and assert every owned resource is gone.

Controlled fault: a runner subclass that closes the control channel when the supervisor dies
reproduces the old behavior and must fail step 3. Without it the new assertion could pass
vacuously.

## Estimate

Four to eight hours, dominated by verification cycles under shared-lock contention rather than by
the edit itself.

## Requests for surfaces I do not own

None. The change is confined to W01-owned files.

One coordination note, not a blocker: the shim defines how a guest receives its control channel, so
it becomes the guest-side contract W02's Python bridge must implement. It deserves an entry in the
interface freeze. The host-side contract is unchanged, so W02 is not blocked meanwhile.

---

# Addendum: hardening the channel against the guest

## The defect I shipped

The first implementation created the per-attempt channel directory `0o700`, immediately widened it
to `0o777`, and bind-mounted it read-write. `channelTransport()` then reopened `in`, `out`, and
`err` by path with a plain `open()` and no file-type check, both on launch and on every attach.

That made the directory itself guest-writable, and it was the only read-write mount any guest
received. The shipped seccomp allow-list permits `unlinkat` and `symlinkat`, so a guest could
unlink a channel entry, replace it with a symlink to an arbitrary absolute host path, and wait for
the host to dereference it. Revalidation demonstrated this with a live proof of concept in the
exact shipped mount and security configuration. Severity HIGH, and entirely my own regression: the
pre-existing `/workspace` mount stays `ro=true` and was never exposed.

## Two independent barriers

Either one alone defeats the attack. Both are present.

**The guest cannot change a directory entry.** The mount is `ro=true` and the directory is `0o755`:
traversable and readable by the mapped guest uid, writable by no one but the runner. Only the three
FIFO inodes carry `0o666`, the narrowest mode the guest needs to open them read-write. No `0o777`
anywhere.

A read-only bind mount still permits opening a FIFO for reading and writing, because the kernel's
EROFS check covers changes to directory entries and to regular files, not passing data through a
pipe. The regression asserts this rather than assuming it: the same guest that is refused `unlink`,
`rename`, `symlinkat`, and regular-file creation successfully opens `/channel/in` read-write.

`runnerChannelMount()` is exported and used by both production and the test, so the test cannot
drift from the flags that ship.

**The host never opens a channel path blindly.** Every open adds `O_NOFOLLOW`, so a planted symlink
fails at the syscall rather than being dereferenced. The opened descriptor is then `fstat`ed and
must be a FIFO whose device and inode equal the ones recorded when the runner created it. Anything
else is refused with a typed `channel_untrusted` error. This applies identically on initial launch
and on every attach and recovery.

The recorded identities live in `<root>/channels/<container>.channel.json`, a sibling of the
channel directory rather than a file inside it, so the guest cannot see or alter the values the
host checks against. A missing or incomplete record fails closed.

## What did not change

The deterministic SIGKILL case and its controlled-fault variant, the frame policy, the
reverse-effect denial, the read-only rootfs, `--cap-drop=ALL`, `--security-opt=no-new-privileges`,
and `--network=none` are all untouched. Builds still never use this path.

## Tests

- A real sandboxed guest in the production profile: `unlink`, `rename`, symlink swap, and
  regular-file creation are each refused by the kernel, while the read-write FIFO open succeeds,
  and the host-side entry is still the same FIFO inode afterwards.
- Unit coverage for the identity check: a mismatched inode, a mismatched device, a regular file in
  place of the FIFO, a planted symlink, a missing identity record, and an incomplete one.
