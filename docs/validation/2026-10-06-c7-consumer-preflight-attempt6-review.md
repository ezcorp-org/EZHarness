# Attempt 6: actual consumer checks before recovery

Status: actual read-only preflights passed, normal app state was restored, and
the final execution index is sealed. One execution is authorized within the
user's continuing goal only after independent final-index review and fresh
host checks pass. This record does not claim cleanup success.

This is one fresh, scoped cleanup under the user's continuing end-to-end goal.
It preserves [attempt 5 and its signed abort](2026-10-06-c7-audit-wire-attempt5-result.md).
It must not replay that request or the original UNKNOWN START.

## Scope

The exact target remains START `c7b5f35d-aa75-421f-aa6b-0741840c8c39`, guest
`ezh-e527e87eb409d89f6e70d58c8ea4a49b`, connection
`fdede86e-6cef-4d66-913a-49c8c3bf36e8` revision 1. The guest is STOPPED;
host generation is 1 and backend generation is 2. The isolated app remains
on source `5080f3792dbbedcdae17b81368ed9ee83ba41b80`, manifest
`f935dbb456db40581cf1642f1f6bd2049e28062f605298ea395dff0195191748`.

The [prior reviewed sequence](2026-10-05-c7-audit-wire-attempt5-review.md)
still defines the limits: one temporary source-restricted forced-command key,
verified thaw-first rollback, fixed runtime and review-age limits, one scoped
certificate fence and one supported cleanup. No new guest, account, provider
activation, network/firewall/NixOS change, or database restore is included.

Attempt 6 adds a read-only check of the exact owned guest and current provider
certificate after the operator slice is frozen, before certificate fencing.
It retains the actual production audit command through the temporary SSH gate.
Both must pass before one-time independent review publication. An uncertain
effect is never repeated.

## Actual preflight evidence

- Receipt 273: the final public loader passed under real UID/GID 62040.
  Its helper map was derived from actual `wrapper.FILES`, exactly four names.
  The loader's checks ran unchanged; only final core dispatch was intercepted.
- Receipts 274–276: final dependency consumer, installed supervisor/v3 audit
  composition, and source bootstrap checks passed. Mocked boundaries in these
  checks do not establish live SSH or cleanup success.
- Receipt 278: the unchanged installed DURABLE verifier passed under UID/GID
  62040 against a new detached copy of the stopped database. The exact sealed
  target pins matched. Live database bytes, metadata and directory identities
  stayed unchanged; clone handles closed. There was no signing or admission.
- Receipts 280–282: normal startup and independent readback passed. The app,
  original five configurations, provider, runner marker and preserved guest
  match the prior state. There is no active recovery hold.

The detached-copy helper is
`73d6e3489710bf5d7939b9fc729ea6e21850c0fbcf1cb40609039c8a80e1b184`.
Five focused tests and independent source review passed before its actual use.
Additional actual-consumer entry-chain tests passed, and current runner,
socket and signer identities passed read-only checks. These do not prove future
post-admission rows or restoration.

## Sealing and completion

| Item | SHA-256 |
| --- | --- |
| Execution index | `1922044c5b8556c16c3a207a846dc9ca0d64e31b12ef55e7a69cfaad07decc9e` |
| Dependency index | `be46d18e6665924220ca50ff0624b54e049be0146673b7320472aa7eba4110e7` |
| Runner | `1b1a06ce9703459cf9b6e24108b481e5083145ba804aa6e41aecf56b156119fa` |
| Operational component | `aaa05a041d3958aa4b3bd8edef44b0eea294a938f12f239cf754d54e9db2e506` |
| Post-abort restoration | `053c3df9dcab67e20fdb8432ea6cdfee85b20601f6f84f61cc3e7f824de4e7c6` |
| Post-abort pins | `53909e93aa2c1d9010f5ac393bb5bdf89c8fb7a64984e96d7cbb41f4e9e70bb1` |
| Full sanitized metadata | `828adfdd020fab904a0e8c4ed0470206db27186b3dc8a99894e8757218d4bbca` |

The index and entry `next_attempt.py` are in
`/root/ezh-qualification-stage/oct05-c7-recovery-packet-attempt6`.
The index pins 29 code/config files and 15 actual evidence files. Metadata is
`/home/dev/work/EZCorp/EZHarness/.worktrees/incus-final-live-sol61-oct05/.cache/c7-attempt6-prep/final-sanitized-metadata.json`.
Fresh nonce: `a4ee7a5c089edbc4ccd5c084d34d41ff`; review ID:
`incus-fenced-cleanup-c7b5-start-v2-oct05-attempt6`. Hold identity SHA-256:
`63da3da7a65b24e8de7e95d1826460dead3c8c68d4f271d01d3b4b2cf05345b7`.
Runtime, operational ledger and server stage use new attempt6 paths. The
420-second runtime, 600-second fallback and existing margin/freshness checks
are unchanged. Prior ledgers remain immutable. Heavy owned builds stay paused.

Success requires a separate
DESTROY SUCCEEDED, binding ABSENT, actual released reservations, independent
backend absence, restored certificate/app, and closed temporary access. Keep
the original START UNKNOWN as history. A failed request requires supported
readback or signed abort, never manual hold removal.

This packet is not complete sandbox end-to-end proof. The verified new bundle,
live qualification, normal UI/native-agent flow, repeated lifecycles and final
repository checks remain separate gates.
