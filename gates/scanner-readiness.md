# Scanner readiness and stable controls

- [x] Reproduce delayed initial storage load leaving camera controls enabled and moving their position.
  EVIDENCE: Runner observed late status insertion moving the button about 22px; /tmp/v4-scanner-readiness-red.log has four failing desktop/mobile readiness tests before source fix.
- [x] Disable scan/upload/manual/search actions until load settles, preserve visible error recovery, and reserve status height.
  EVIDENCE: Native disabled fieldset is present before JavaScript starts. Main exposes aria-busy until initial list resolves or visible reload guidance is shown. Status reserves two lines. Controlled browser tests prove physical click does not activate while loading and button Y changes by at most one pixel after readiness.
- [x] Run desktop/mobile controlled browser tests, portable source tests, and regenerate source lock.
  EVIDENCE: /tmp/v4-scanner-readiness-final.log — 12 desktop/mobile tests pass; /tmp/v4-scanner-ready-source.log — 262 tests, 2732 assertions pass; /tmp/v4-scanner-ready-types.log passes test typecheck. Lock regenerated and checked. Desktop/mobile screenshots /tmp/scanner-ready-{1,3}.png reviewed. Final sealed candidate /tmp/v4-scanner-ready-candidate-final.jsonl verified artifact 702df830fca434e24763d0bef829781f1e7d9013b23519b49a02cfaa273f52f7 (catalog proof, not live capability exercise).
- [ ] Actual protected host pointer/tap camera test passes with runner owner.
  EVIDENCE: pending
