# Incus provider 0.1.2 upgrade identity — 2026-09-24

The user approved isolated release digest `4c0e2eee0f9105d28a5173ec695bd42c6b84de58233570fb0ffb2dcf03a6ac18`.
The isolated app approved it as `31bfe22b-e03e-48c6-b323-514a1b74685a` and activated it with operation
`01b27c9e-c7b6-4b70-8153-2a56626f1611`. An independent inspect readback showed release
`9ec8e626-0a5d-4ed6-9333-a3fd1aa25472` active at generation 3 with no diagnostics.
This activation made no Incus server change.

The first 0.1.2 Plan, saved as `37e81460-ac0d-4a51-a513-8b4c68373f0a`, was blocked
on `unexpected_trust_entry`. Planning generated a new client certificate even though the
server still trusted the valid, reviewed 0.1.1 client certificate. No Apply was attempted.

The upgrade path now reads the latest verified setup and its encrypted, host-only client
identity. It reuses that identity in a **new connection record bound to the new release**
only when the old release has a consumed approval, the old connection is unrevoked, no
unfinished sandbox binding or operation remains, the certificate is valid, and fresh
server inventory shows the exact restricted `engine` trust entry for the same project.
The usual setup planner still rejects any other trust entry or server drift. A same-release
replan can also reuse its current approved identity. The key is not placed in the plan,
API response, or repository.

A focused upgrade test reproduced the old-release trust case, denied reuse for an
unfinished binding and for an `OUTCOME_UNKNOWN` operation, then proved a drained new
release gets the same certificate and private key without any SSH runner call. The
isolated app still holds the old unknown CREATE; it must be reconciled through the
separate signed operator recovery before another Plan can be called safe or applied.
