# Gates: Guest Incus transport

Scope: Host mTLS transport invokes only the fixed versioned helper inside a verified running guest.

- [x] T1: Fixed helper path, approved guest user, instance ownership, and exact connection pin are checked before execution.
  EVIDENCE: `guest.ts` requires `scope.approvedGuest` and the approved preset, compares the pinned guest user, helper version and source digest, then reads the named instance in the pinned project and checks its ownership, Running state, profile, and Incus `volatile.base_image` fingerprint. It sends only `GUEST_HELPER_PATH` with approved UID/GID and `/workspace` cwd. Real TLS WebSocket test confirms no HTTP upgrade bytes reach a wrong peer certificate.
- [x] T2: File/process request and response framing is bounded and translated to provider v1 without leaking raw host credentials.
  EVIDENCE: `encodeGuestRequest` and `decodeGuestResponse` cap messages at 2 MiB; `pinned-websocket.ts` caps frames and cumulative output at 2 MiB. Host overwrites user and sandbox identity and adds scoped idempotency. `guest.test.ts` checks stat output and file removal receipt. Host errors are sanitized. Once POST /exec is attempted, any mutation failure, including a malformed helper response, carries a stable unknown operation identity. The helper journals file mutations and derives a stable process handle for exact replay.
- [x] T3: Real-socket or protocol-level negative tests prove no unsafe fallback on missing helper, wrong version, timeout, and forged sandbox ID.
  EVIDENCE: Bun 1.3.14 `bun test ./src/infrastructure/incus-transport` passed 37 tests. `pinned-websocket.test.ts` uses a real TLS socket for good and wrong peer certificates. Guest fake protocol tests cover missing helper, wrong version, oversized reply, stopped or replaced image, forged sandbox name, timeout, and malformed process start response. Targeted Biome passed. No live Incus guest is provisioned for this gate.
