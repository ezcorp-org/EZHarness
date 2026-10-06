# Attempt 5: live audit route passed; packet loader refused

Status: authoritative no-admission abort, natural access rollback, and complete
app/server restoration passed independent review. No cleanup or complete
sandbox E2E success is claimed.

The [attempt 5 packet](2026-10-05-c7-audit-wire-attempt5-review.md) passed the
actual timer, temporary-key, freeze and lease checks. Before certificate
fencing, the repaired production audit command passed through the actual
forced-root SSH gate (private receipt 256). Independent review then published
once and the waiting operator continued without a model handoff.

Recovery stopped with `independent operator recovery verifier failed`.
The private diagnostic identifies phase DURABLE, exit 1, and the exact loader
error: `Closed packet dependency pins required`. The generated public pin map
listed six helpers; the unchanged loader requires exactly four:
`admission.ts`, `restore.py`, `server_transport.py`, and `wrapper_core.py`.
The extra `audit.py` and `wrapper.py` entries belong in the outer review index,
not that loader's closed map. This was a packet-generation error. The previous
21-file validator did not execute the public loader's main entry point.

The failed request was not repeated. One supported offline abort used the
unchanged installed Bun/TypeScript abort CLI directly, preserving the broken
wrapper and packet. It retained the supervisor's exact target, signer,
stopped-actor, nonce and database readback guards. Private receipt 260 and
independent signature/proof checks confirm committed abort
`b6f45e02-725b-4488-b2da-2f68dfdf7870`; the hold was archived by the supported
path. This establishes no cleanup admission. It does not resolve the original
UNKNOWN START or release its reservations.

Natural fallback receipts 262–263 prove both temporary key paths absent,
operator slice thawed, timer/service inactive and successful expiry. The
actual abort evidence hash is
`33b1f0fd69234c3b86cbb087a5d257bb81a920ec8357a39a7208feb67a065f32`.
The pre-reviewed disposition helper `9ad4162a…` consumed this actual reviewed
evidence; no future proof was fabricated. Certificate and configuration
phases 264–265 passed. Startup and final checks 266–271 passed: the app is
healthy on source `5080f3792`, all five original configurations match, the
restricted certificate is restored, temporary keys are absent, and the server
slice is thawed. The exact c7 guest remains STOPPED, its START remains UNKNOWN,
and its reservations remain held. The recreated runner marker has inode
3330744; this is not a claim that its old inode was restored.

Receipt 272 seals the 49-file attempt ledger with SHA-256
`63581146a0642c1aa4e9cef8fd929f9af259b822053e1adab42582cace5b6879`.
Its receipt SHA-256 is
`d308a597fd1d0ae164f22ba36e2622b1020b2551665a8d10052a7e97ad695921`.

## Added preflight

The actual failed public wrapper was independently run under real UID/GID
62040 with an isolated Python environment. Its production path, manifest,
file metadata, closed helper set and digest checks ran unchanged. Only the
final core dispatch was intercepted, preventing database or server effects.
It reproduced the exact failure before any recovery window.

Reviewed checker: `.cache/c7-public-wrapper-preflight/check.py`, SHA-256
`4a08e518b0329462a02b168b792875d466caa37e7d2706987e2f92325f9ec175`.
Any successor must derive the helper names from the actual loader contract and
pass this check against its final staged public files before binding a clock.
The broken attempt5 files and their evidence must remain unchanged.
