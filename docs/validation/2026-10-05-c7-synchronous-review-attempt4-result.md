# Attempt 4: review handoff passed; verifier refused

Status: supported offline abort, natural access rollback and full prior-state
restoration passed independent review. No guest cleanup or current-source E2E
success is claimed. Attempt 4 is consumed and cannot be replayed.

The [sealed attempt](2026-10-05-c7-synchronous-review-attempt4.md) passed actual
timer, key installation, forced-root probe, freeze and lease checks. The
independent reviewer published once; the waiting operator consumed the review
and dispatched immediately. Private receipt 228 records 1,212 milliseconds
from review publication to the revoke intent. This closes the prior stale-review
handoff defect.

The supervisor returned `independent runner client fence verification failed`.
Its hold remained set. The response alone could not prove whether admission
had occurred, so no recovery request was repeated and no hold was removed by
hand. One supported offline signed abort then completed:
`94253636-cb6f-4cd9-b58a-f5245365cb5d`. Private receipt 226, the signed abort
receipt, committed database readback and exact archived hold were independently
verified. They prove this attempt did not admit cleanup. The original START
`c7b5f35d-aa75-421f-aa6b-0741840c8c39` remains UNKNOWN and its guest remains
preserved.

The natural 600-second rollback completed without a manual expiry call.
Private receipts 229–230 prove both root key paths absent, the operator slice
thawed, and timer/service inactive with successful exit. The actual expiry
reported thaw, matching key removal and prior absence restored. This closes
temporary access; it does not restore the revoked provider certificate.

## Reproduced integration defect

The production v3 fence verifier sends a pinned `audit.py frozen-until` SSH
command with the recovery request's deadline. The temporary forced-command
gate accepts only lease tokens and five transport commands. It also applies a
five-second transport-call limit to every non-lease command. Thus it refuses
the actual verifier command at the boundary between these components.

The first hypothesis that the supervisor itself received a 420-second request
was disproved: the saved request was created with 179,995 milliseconds left.
The 420-second outer runtime and 180-second supervisor request are distinct.
No deadline limit should be changed on the basis of that rejected hypothesis.

A read-only attempt after expiry could only show the current expired-window
refusal, so it does not establish the original subprocess stderr. A controlled
local regression now runs the actual supervisor verifier, actual v3 serializer
and actual forced-command parser together. The unchanged attempt4 parser fails;
a narrow audit-only candidate passes six tests. The candidate accepts only the
exact pinned audit path/hash/verb and bounded deadline, verifies the rollback
lease, then executes a fixed argument array. Existing transport calls retain
their five-second limit. Independent review reran all six composition tests
and all 21 earlier dispatcher regressions successfully. A fresh sealed packet
must still pass actual final-file validation before use.

The earlier 21-file consumer check covered the transport wires but omitted this
production verifier wire. It must not be cited as proof of this composition.
The new local tests are controlled fixtures, not live qualification.

## Verified restoration

The restoration candidate is separately limited to certificate, configuration
and startup phases, all gated on the exact committed abort proof. Candidate
SHA-256 `8bd5ad5bdc7118d196b78a277dd48e40d80eea4bc969a4c26f8c4914ee8e0110`
passed seven local tests and actual read-only validation of the saved proof,
archived hold, installed source, paused actors, database identity, five backups
and absent runner marker. The archived hold retains its actual root:62040
ownership. Remote artifact checks and independent final review passed before
execution. This restoration did not extend or rebind the consumed deadline.

Private receipts 232–234 record the three successful phases; independent
receipts 235–239 confirm healthy source 508/f935, all five original configuration
hashes, the exact original restricted certificate, no active hold, and no
database restore. The empty root:62040 mode-0600 runner marker has new inode
3293067. Both temporary key paths remain absent and the operator slice is
thawed. The original c7 START is still UNKNOWN with the exact stopped guest at
backend generation 2. The older 8157 cleanup remains SUCCEEDED/ABSENT.

## Remaining work

- Seal the reviewed component correction with a fresh nonce and final-artifact
  composition check before any new cleanup attempt. Preserve this abort record.
- Complete cleanup, current-source installation and the real user workflow.
