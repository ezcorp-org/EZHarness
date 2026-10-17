## Summary

Third follow-up to #318, updated. Besides this PR's first content (W4H-27 and W4H-26), the branch now carries the fix for the SDK-closure inventory test (W4H-29), the timing-free resources proof (W4H-30), a sync of main #339 (W4H-31), and the receipts and the tasks text of that round. PR 341 is updated in place; no new PR.

**W4H-28 (the reference run with the real model and its seven product fixes) lands with the next push; this description will then grow to cover it.**

1. **W4H-31 — sync of main 934531e2e (#339).** The merge keeps both sides: `processSpawn` reaches every runner start site, including W4H-26's supervisor launch and the preparation path; main's spawn-guard suites pass; W4H-26's preparation fixes and W4H-27's byte-equality check survive (mutants red). Main's own ci on 934531e2e: 54 success, 3 skipped, 1 failure (the runner readiness precheck).
2. **W4H-30 — the resources proof's socket count no longer depends on timing.** It was not a leak: the runner client's keep-alive pool kept one or two idle connections to the runner socket for about 5 s, and a boot-time HTTPS keep-alive to the Kilo catalog stayed open. The runner client now uses a fresh connection per call (about +0.1 ms per call) and the Kilo fetch sends no keep-alive. The check and the proof are unchanged.
3. **W4H-29 — the SDK-closure inventory test follows the shared builder.** This PR's first hosted run found one real red: W4H-26's builder consolidation left the test's source list stale. One-line fix; every merge hold now runs the 51 repository inventory and registration tests.
4. **W4H-27 and W4H-26 (this PR's first content).** The Compose installation comes up (the workflow bundle is built at image build time and verified by digest; a CI job checks the image under the shipped isolation), and a reference-code task runs through the product (two v4 runner packages, a package-preparation role, a supervisor build operation). The details are in the earlier description of this PR.
5. **Receipts and docs.** The receipts of every merge and hold above (`docs/validation/factory/wave4/`, `SHA256SUMS` append-only); the round's lessons (37 bullets) and 17 leftover items in `tasks/lessons.md` and `tasks/todo.md`.

## Validation

- Identity: only the project's noreply identity on every commit; a pattern check refuses any other address in every changed file and receipt, and prints none.
- W4H-31: validator-8 ACCEPT at 9cc6fed78 and OK to publish on the hold re-run (verdict 2ed52d08e6bfabbe). The hold judged main's own lines as informational and the resolution lines as binding (the W-SYNC form). Full hold re-run status 0 (906 of 906 legs; the only non-zero legs are four list-bound files that cannot run on this host and the informational CRAP leg). The first hold run was red on its tooling, not on the product; each tooling defect was fixed red first.
- W4H-30: validator-8 ACCEPT at 5ee55026a; two arms of 6 × 10 cycles: main held 1 or 2 runner sockets in 66 of 66 samples, the fix 0 in 66 of 66.
- W4H-29: validator-8 ACCEPT at 6c15783d9; red on the old head (7 pass, 1 fail), green with the fix (8 pass); two mutants red.
- This PR's earlier hosted runs: attempt 1 (486e6a558) the W4H-29 red; attempt 2 (d2add3048) one intermittent red in "Production proof (resources)", pre-existing (4 of 41 earlier attempts), root-caused by W4H-30; attempt 3 green except the precheck.
- Hosted (this branch): ci 38850371515: parity with main 934531e2e — one class-A red (runner readiness precheck; needs the factory-real host and its three secrets) and its three cascade skips; everything else green.

## Leftovers

The full dated list is in `tasks/todo.md`. The ones this round added for main:
- Test hygiene: tests that never run (`describe.skip` in source), Docker-only tests, a fixture address on a real domain (`web/e2e/reliability.spec.ts`), two tests over Bun's 5 s default timeout.
- gitleaks `generic-api-key` fires on the product's `tokenActorExtensionId` log field in test logs; allowlist by exact field regex through the gate-change route (recorded in `w4h-31-merge.json`; it joins `tasks/todo.md` with the next push).
- The production image calls api.kilo.ai at boot (a network policy question); the live GPU probe names no spawn policy.
- Host: the shared proof services run under the user's systemd manager, so an OOM kill of the manager kills them all.
- User items: the W07 GitHub App and branch ruleset; a `factory-real` runner host with its three secrets; a Docker Hub login or mirror; the nightly mutation threshold (about 56 percent measured against 80).

## Gate changes

None in this push beyond main's own. gate-integrity at the W4H-31 publish: the main leg (against origin/main 934531e2e) 0 findings against the empty expected set; the base leg (against the previous integration head b80a00f47) names 41 files, every one byte-identical to main 934531e2e (main's own gate changes, already gated on main).

