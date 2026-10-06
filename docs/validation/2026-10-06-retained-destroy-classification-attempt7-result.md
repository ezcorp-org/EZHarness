# Retained cleanup classified; temporary access closed

One attempt under the [reviewed plan](2026-10-06-retained-destroy-classification-attempt7-review.md)
succeeded. Saved DESTROY `8720a719-b3cd-44d7-a00d-5a57f4262fca` is now
FAILED / OPERATOR_PROVEN_NO_EFFECT, with no provider handle. Its guest remains
STOPPED. This step did not delete a guest or release its resource reservations.

The original c7 START remains historical UNKNOWN. The proof establishes the
retained DELETE outcome at the fenced cutoff; it does not assert that an old
RPC was never sent.

## Verified evidence

- Installed source: `301e88e9316447881abf00006eea4b42c25ccb08`.
  The exact execution index was
  `d2ca9cfd70a660f440a7576b9df3a8048f170497751d12d66571fb1878b12ecf`.
- Actual service-user loading, closed dependency consumers, and a fresh
  stopped-copy production DURABLE check passed before timed authority.
  The live database bytes remained unchanged by that check.
- The actual server timer, forced route, frozen state and production audit
  wire passed. Independent review published one receipt; no clock or review
  was refreshed, and the recovery was not replayed.
- The signed version 3 response returned the same operation ID. Independent
  signature verification passed. Canonical receipt SHA-256:
  `443e4bc6de87b238671b659e5550996a9ee6b92214215c8df8b47e7a00b5d0df`.
- The first observation followed the stopped-process cutoff by 67,893 ms.
  The observations were 7,017 ms apart. Both showed the same owned STOPPED
  guest at generation 2, original START tags, and no active operations.
- Receipt 325 confirms FAILED / OPERATOR_PROVEN_NO_EFFECT, no provider
  handle, and the retained STOPPED binding. The normal supervisor verified
  transport restoration, cleared the hold, and started the app. This normal
  path did not create a fallback restoration receipt or hold archive.
- Forced thaw removed temporary access. Receipt 327 independently confirms
  the original restricted certificate, stopped guest and quiet backend.
- Receipt 328 proves natural timer completion, both temporary keys absent,
  the user slice running, and timer/service units inactive and no longer
  loaded. SHA-256:
  `7edb43db6657a6ce472871737d8effc6ac47c0fc0a431fb308ef48639e2885dd`.
  The expiry reported no key removal because forced thaw had already removed
  it; both actual key-absence checks passed. Independent review closed the
  recovery window.

## Normal app restoration

The first configuration phase stopped before its write intent: the sealed
runner retained the old binder checksum. All five current configurations were
unchanged. The corrected success helper uses the reviewed attempt 7 binder
and compares all three actual runtime files. An actual-source regression
reproduced the refusal and passed the corrected checks before any write;
eight focused tests and independent review passed. No pause was replayed and
the sealed runner was not changed.

Corrected helper SHA-256:
`2ec673b605ea7b75a2e5b8dfe29b39fb5b3ea3450d0613bd815bbdae6fbc182a`.
Its configuration and start phases exited 0. Independent receipt 330 verifies
the five original configuration hashes, healthy services, installed 301/5aa56,
hold absence and restored marker ownership/mode. The normal marker has a new
inode, 3359748; the temporary marker, inode 3357736, is preserved. No database
restore or guest cleanup occurred during this disposition.

## Remaining work

Use normal recoverCleanup for a new linked STOP and distinct DESTROY. Prove
backend and storage absence, released reservations, and compensated historical
operations.

Live resource-load diagnosis, qualification, the normal UI/native-tool flow,
ten feature lifecycles and final repository gates remain open. This recovery
pass is not a claim that the complete sandbox workflow or release is ready.
