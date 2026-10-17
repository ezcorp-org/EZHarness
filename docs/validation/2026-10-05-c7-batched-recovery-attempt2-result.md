# c7 attempt 2: safe stop before access

The user approved review packet SHA-256
`7f470c0e99cef9b0a44e3ee861c56050e671345d71b23d3c2665e48942ae0c57`.
The sole live operator executed one attempt. It ended SAFE_ABORT. Its approval
is consumed; no retry, new lease, or cleanup is authorized by that approval.

## Result

The actual dispatcher refused the timer-arm request with
`Exact temporary key hash required`. The generated key line already ended
with a newline, but its checksum included another newline. The dispatcher
correctly rejected the inconsistent bytes before timer creation. The expiry
validator uses the same check; no successful expiry call is claimed.

The previous template check exercised the binder and its allowed changes.
The mocked helper fixtures used internally consistent hashes. Neither check
sent the final generated policy through the actual dispatcher and expiry
loaders. A regression must cover that complete path before a new packet is
submitted for approval. Do not weaken any hash validator.

## Independent restoration evidence

Private receipts 182–187 and the attempt ledger were independently reviewed:

- Timer and service absent; both root key paths absent; operator slice unfrozen.
- No key-install, freeze, certificate-fence, signing, or recovery admission.
- The exact existing Incus certificate remains restricted to `ezharness`.
- All five original app configurations restored to their recorded hashes.
- The original empty runner-marker semantics restored: root:62040, mode 0600.
  Its new inode is 3229584; the old inode 2876472 is not claimed to survive.
- Isolated app source `5080f3792dbbedcdae17b81368ed9ee83ba41b80`, manifest
  `f935dbb456db40581cf1642f1f6bd2049e28062f605298ea395dff0195191748`, is healthy.
- START `c7b5f35d-aa75-421f-aa6b-0741840c8c39` remains UNKNOWN at host
  generation 1 with its saved stable handle. Guest
  `ezh-e527e87eb409d89f6e70d58c8ea4a49b` remains STOPPED and is the only guest.
- Earlier cleanup 8157 remains SUCCEEDED with binding ABSENT.
- No database restore, c7 cleanup, or c7 reservation release occurred.

The approved standalone `abort-preview` and `restore-marker` phases restored
local state after independent proof of no server-access effect. Their original
paused-actor, no-admission, exact-backup, and known-config checks all remained
in place. No fabricated expiry success was used.

The timed-work window is closed. Source checks can resume. Preserve this
attempt's files and ledger; any successor needs corrected final artifacts,
actual no-effect validator checks, independent review, and new exact approval.
