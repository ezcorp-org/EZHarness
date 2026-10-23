# validator-8: W4H-36 validation plan — docs line v10, contracts rows, leftovers ledger, follow-up PR body (documents only)
Brief w00/briefs/w4h-36.md f3a287e59570e1ad. Branch wp/w4h-36-docs-v10 from 390c49a90. Standing rules:
plan-common-w4h-32-36.md 147bb9ec215b3a14 (S1, S7, S10; no code legs).

V1 Documents only: the diff touches docs/ and the contracts document only (git diff --stat); any code file = finding.
V2 Docs line v10: same structure and voice as v9 (ASD-STE100); each lesson is a rule with its trigger; every lesson in the
   brief's list present; each lesson traceable to a coordinator-log entry or a pending-lesson file (I sample every one).
   My own lessons of this wave (pending-lesson.md) are present in substance: sync-base-leg v1 path parse, tracer PS4
   default, sha computed before the report, the vacuous-test helper rule.
V3 Contracts rows: each new row matches the code at its branch (integ/w00, wp/w4h-28-reference-run): the runner wire codes
   (400 RunnerError with text; 500 runner_internal_error {errorClass, errorCode}; artifact_missing as 400 with AB-2 noted);
   readiness warnings and provider_readiness_error as committed by W4H-28; the C03 validator-bound row from ef3b44213
   verified and NOT duplicated (git grep).
V4 Leftovers ledger leftovers-2026-10-16.md: append-only history (the 10-13 file unchanged; diff check); each removed item
   names its landing commit (I check the commit exists and contains the change); this wave's leftovers all present (I list
   them from my plans: AB-1/AB-2 row, rehydrate, AD-1 limit, the .old-file style items, test.com fixture, describe.skip,
   Docker-only, the CRAP informational leg, etc.).
V5 tasks/lessons.md and tasks/todo.md text blocks as files under evidence/w4h-36/ (not committed by the
   owner).
V6 Follow-up PR body followup4-pr-body-draft.md: every landed package with its merge commit; every product defect the real
   run found and fixed (real-4 OAuth bundle, readiness masking, runner unmasking, budget per node, AC-3 known cost, etc.);
   the single real run's evidence (run <MSG-ID>, usage 1801 tokens / 240 micro-dollars, release
   ordinary/releases/w4h28/real-9/run1, effectDigest sha256:96b8b369...) matching my reads exactly; the leftovers.
V7 Identity and secrets: identity-check files on every changed file clean; no token, no account id other than masked, no
   personal address; fixture values only.
Verdict per S10.

## Addendum A (2026-10-16, validator-8): owner report 1 (outline, contracts cross-check, team-lead's rulings)
Facts: no docs check script and no markdown lint in package.json (so no tool leg; my reads replace it). v10 outline: 34
lessons (owners 1-19, validator 20-24, integrator 25-28, coordinator 29-34) plus one-line recurrences; landing records
(W4H-29, W4H-30, PR 341 attempts, W4H-31 with placeholders, W4H-28 with the real-run facts); 21 leftovers with sources.
Rulings (team-lead): C03 exists (no duplicate) and gains a memoryBytes clause; C10 gains ONE row for the readiness document
(the document, the fixed order of failures, all six codes, the warnings entry); C05 gets the runner wire-codes row from
2a0c65e74; W4H-36 merges after W4H-28 and removes W4H-28's stale "row belongs here" note in its own commit; the cap lesson
wording: "ordinary commits keep the cap; a sync merge runs every mapped file in the lock; the cap is never raised to run
fewer tests".
Checks added:
- C03 memoryBytes clause matches validator-composition.ts:116-121 at the W4H-28 head (bounds.memoryBytes ?? allocation;
  refused when above the allocation, together with the cost check).
- C10 readiness row: the six codes exactly as the union at factory-broker.ts:28-33 (a1290b31a): provider_not_configured,
  provider_credential_unusable, provider_readiness_error, model_not_available, model_pin_mismatch, credential_kind_required;
  the order as the code builds it (model_not_available pushed before the credential failure, :164-165; model_pin_mismatch
  from its own path, :213); credentialFailure / readinessFailure / warnings fields as in :107-175; no message field.
  Re-checked at the head W4H-28 freezes (its code may move).
- C05 runner row: 400 + text for a genuine RunnerError; 500 runner_internal_error {errorClass, errorCode}; artifact_missing
  (400, AB-2 noted) — matches 2a0c65e74 at the W4H-28 freeze head.
- Lessons: 34 counted; each owner/validator/integrator/coordinator lesson traceable (I sample all five of mine: 20-24);
  every recurrence line names the earlier lesson it repeats.
- Landing records: W4H-31 placeholders filled before merge (0 placeholders left, grep); W4H-28 facts equal my reads.
- Leftovers: the 21 compared with my list in V4; a missing one = finding.
- Sequencing: the stale-note removal is its own commit after the W4H-28 merge (git log); no other W4H-28 file touched.

## Addendum B (2026-10-16, validator-8): pre-check of head 7e4dbaae0 (not frozen; the verdict waits for the final head)
- 7e4dbaae0 widens the C10 row to all six codes, the details and the warnings entry (ruling 2). Read against factory-broker.ts
  at a1290b31a: the six codes as the union (:28-33); at most one credential code after model_not_available; credentialFailure
  and readinessFailure {errorClass, code?}; warnings only when the ladder served a credential past a broken one, each
  {code provider_credential_unusable, credentialFailure} (:175); "no detail carries a message"; the call-time check uses
  the same path. Matches. The final head will merge integ after W4H-28; I re-check the row there.
- Current files: v10 e8c43e09645d9eac (the one in my verdict), ledger 5d28aa0bf718ad8f, PR body 3f140334a4161105.
- Count: the owner reports 35 lessons; v10 e8c43e09645d9eac has 34 bullets (20 owner, 3 validator, 1 validator and
  integrator, 4 integrator, 6 coordinator) incl. the cap lesson. F1 (two validator lessons missing) would make 36.
- F1-F3 of verdict-w4h-36.txt d4f387981a44d3cd are not yet fixed in these files (expected: the report predates the verdict).

## Addendum (2026-10-16, validator-8): the transport-ceiling contract row (ruled by team-lead after W4H-28 AW)
Ruling (team-lead): W4H-36 adds a contract row for the factory gateway response ceiling in its final-round contracts commit.
Checks at the W4H-36 final verdict:
- The row states the ceiling = the largest contracted reply bound, 64 MiB (it must agree with the host-preparation row, line
  167 at 6c0b99d37, and the 4 MiB bound for every other host-service reply).
- The row states that a limit outside 1..ceiling is refused by name ("factory gateway byte limit is invalid").
- The row names the implementation (packages/@ezcorp/factory-transport/src/index.ts, GATEWAY_MAX_RESPONSE_LIMIT_BYTES) and the
  test (the Node orchestrator test gateway-activities.test.ts: 64 MiB + 1 refused, 64 MiB accepted).
- The value in the row equals the constant at the merged head (read, not assumed); one row, no duplicate.

## Addendum (2026-10-16 ~10:35Z): the ruled rebase onto c8ae394ca (team-lead)
- Ruling: the three accepted docs commits are rebased onto c8ae394ca with `-c rerere.enabled=false`; the old shas are kept under proof/w4h-36-pre-rebase at 7e4dbaae0; a fourth commit goes on top.
- R1. `git range-diff 390c49a90..7e4dbaae0 c8ae394ca..<new head>`, run by me: the three pairs are "=" (patch-equal); any "!" pair is a finding unless only context lines moved and I explain each one.
- R2. Each rebased commit's diff equals the old commit's diff byte for byte (`git diff A^ A` vs `git diff B^ B`, sha16 compare); the new parent chain starts at c8ae394ca.
- R3. Identity: author and committer are the <USER> noreply identity on all four commits; identity-check commits is clean.
- R4. The rebase record shows the rerere flag and no "using previous resolution" / "Resolved ... using previous resolution" line.
- R5. The fourth commit: docs and contracts files only, its content against the brief and my plan rows (transport-ceiling row included); identity-check files clean on its changed files.
- R6. Then the final freeze for the verdict.

## Addendum (2026-10-16 ~11:00Z): pre-judgment of the W4H-36 landing form (team-lead's message) — SOUND with conditions
Verified: merge-tree --write-tree 15d71f83b 7cac5837c (rerere off) = e58ee93f5a55deab, clean; c8ae394ca..7cac5837c = 1 file +5 -3;
15d71f83b does not touch the contracts document; precedents 8221bec84 and ebad5d824 are two-parent detached merges; the hook
with 0 targets prints "no test file maps ... skipping" and returns 0; hold-w4f.sh 9173e9ee9a2b6146 skips an empty pg/unit list.
Conditions:
- P1 BLOCKER as staged today: the W4H-33 commit-locked.sh line 9 `[ -s "$LIST" ] || exit 3` refuses a 0-line list. The W4H-36
  copy must accept an existing empty list (`[ -f "$LIST" ]`), keep EZ_PRECOMMIT_TEST_MAX=$(grep -c . "$LIST") = 0, and the commit
  record must show the hook's "no test file maps" line and hook-mapped-staged.txt empty (= LIST). That diff line, beyond path and
  labels, is the one allowed change; OK on exact hashes.
- P2 at the prep's real base: TREE recomputed with rerere off; the merge's diff against its first parent byte-equal to
  `git diff c8ae394ca 7cac5837c` (sha16 compare); identity commits c8ae394ca..7cac5837c, then base..merge, clean.
- P3 unit.txt = exactly w00/invariant-tests.txt (51, sorted cmp); importers 0; no leg exit 97; config-check last.
- P4 merge-commit-gates: the origin/main expected set = exactly W4H-33's two ruled deletions; the base leg PASS.
- P5 the NOTEST identity leg names the contracts file and exits 0.
- P6 tasks commit: dry run on copies, a second run refuses; lessons-2 after the part-1 block and before "#### Owners"; leftover-2 at
  the END of the leftover list; the correction OLD -> NEW exactly once; I re-check presence with my own copy (part 1 and part 2
  present, OLD absent, NEW once). A tool change (replace-once) is staged red first for my OK on exact hashes.
- P7 receipts: verdict-w4h-36.txt at the hash on file when copied (b03894938839f588 now), range-diff-3.txt dfbe2081a2b0782a,
  range-pairs.txt, the owner's freeze file; SHAS append-only.
- P8 followup5 body 334d1c7e127aa9ec judged at the push with the W4H-33 and W4H-36 facts; applied = live read back.
- P1/P5 templates pre-judged (integrator-5/w4h36-templates/, 2026-10-16 ~11:15Z): after normalising the W4H-33 folder name to
  __W4H36_DIR__ and w4h-33 to w4h-36, launch.sh.tmpl a0ba5ad3308f6f1b and hold-own-pg.sh.tmpl ad26dd0f24b7cb02 equal the W4H-33
  files; commit-locked.sh.tmpl 2b8b74f9d1ba76c1 differs in line 9 only (`-s` -> `-f`, with the P1 comment). extra-legs.sh.tmpl
  477b7370f416ee8c: one leg, `NOTEST=1 file_leg identity-contracts <contracts file> bash identity-check.sh files <file>`
  (heavy-lib.sh :41-42: file_leg runs leg, or fails by name when the file is missing). Sound. The OK binds the step-d hashes.
- Reorder (team-lead, on the user's word, 2026-10-16 ~11:40Z): W4H-36 lands FIRST onto c8ae394ca. P4 changes: the origin/main expected set
  is EMPTY (W4H-33 has not landed); a per-folder expected file, never the shared w00 file. P2 base = c8ae394ca (TREE recomputed there).
- Prep + trio OK (2026-10-16 14:10Z): folder w4h-36-docs-v10-7cac5837c-on-c8ae394ca; config.sh 767fb4d2314581eb (BASE c8ae394ca, TREE
  978ee8e5f5e561c9 = my merge-tree with rerere off); diff(c8ae394ca, TREE) byte-equal to diff(c8ae394ca, 7cac5837c); LIST empty (0 bytes);
  unit.txt cb5f997c81c2f434 = the 51 invariant paths (normalised); guard list 2e49e0ffddf84113 = my guard-list-check at c8ae394ca (41);
  commit-msg.txt c16dc100db761926 identity clean. Staged = templates with the folder name only: launch.sh.new 0f215ec3bd1fc638,
  commit-locked.sh.new b31a35f3af1fad4a, hold-own-pg.sh.new ad26dd0f24b7cb02, extra-legs.sh.new 477b7370f416ee8c.
  P4 as staged: the shared w00 expected file is EMPTY (e3b0c44298fc1c14), as for W4H-28; accepted for an empty set only if the record
  shows that hash and nobody edits the shared file before the hold (W4H-33's repair uses a per-folder file).
- Commit record OK (2026-10-16 14:15Z): merge 84f1cdb3c; commit.exit 0 (lock 14:10:20-14:13:09Z); tree 978ee8e5f (= TREE); parents
  c8ae394ca, 7cac5837c; <USER> noreply; identity commits c8ae394ca..84f1cdb3c 5 clean; diff(c8ae394ca, merge) byte-equal to diff(c8ae394ca,
  7cac5837c); hook "no test file maps ... skipping", EZ_PRECOMMIT_TEST_MAX=0, hook-mapped-staged.txt 0 bytes; staged-files = the contracts
  file only; stage.log "Automatic merge went well" (commit.sh 22db59d4e7eb94e0, rerere off); integ/w00 still c8ae394ca (detached form);
  the void W4H-33 merge kept by proof/w4h-33-merge-15d71f83b.

## Round 2 judged (2026-10-16 ~15:20Z; copies in validator-8/r2-check/)
- Item 3 OK: round2/delta/delta.test.sh.new 0c28401067a2f5d2 with fixtures delta-v11.test.draft-b10f1292.md (b10f1292a1ea2d1e) and
  delta-v11.test.correction-798c0926.md (798c09260467ea29): 44 checks = the 16 + 28 of the installed delta-v10.test.sh 255c3164e239a6ee and
  delta-v11.test.sh 7461e0a69808b93e, assertions equal (only the folder variable differs); 44/0 installed tool, 32/12 pre-v11; my ten
  earlier delta mutants all RED (1 to 14 fails each); the live v10 draft refused by name. The fixtures install with it into docs-commit.
- Item 1 NOT YET: block 3 514075d95176f0a3 and extract-blocks.py 2c6625d9b94f08b6 are right as text (facts = W4H-33 pending-lesson 15 and
  the D2 withdrawal record; extract "as stated" exit 0 at fef0d7d2a; both planted failures FAIL by name), but v10 4cedeb576aad41a9 places
  the bullet in section 1c WITHOUT a heading, at the end of the part-2 block; the installed delta tool f62b8f1668b35f44 refuses it at
  fef0d7d2a: "heading present but 1 bullet(s) missing". Fix: give 1c its own '#### ' heading (the tool then inserts it right before
  "#### Owners", i.e. right after the part-2 block), extract-blocks keeps the heading in block 3; or a tool change (append to a present
  block), red first, for my OK.
- Item 2 NOT YET (on-disk v2, NOT the stated hashes): actionlint-labels-agree.py.new 671be58a2bcd334c and test f2a3438523eefbdd (8/0);
  mutants: w00-subset RED 6/2, missing-as-AGREE RED 7/1, but repo-subset (repository labels a subset of w00) SURVIVES 8/0 (L1: the
  direction "w00 has a label the repository lacks" is untested); missing w00 with an absent repository file SURVIVES (L2); nested list
  SURVIVES (minor). hold-w4f.sh.new adc86f1bf7d8325e = installed 6da567de911b4896 + one actionlint-labels leg line.
- Sequencing agreed: 2 and 3 lock-free after their OK; the old delta tests retired by name after delta.test is installed and green;
  hold-w4f.sh.new only after the follow-up's hold, on its own hash OK.
- Round 2 item 2 re-judged at team-lead's re-staged hashes (2026-10-16 ~15:35Z):
  OK  actionlint-labels-agree.py.new 671be58a2bcd334c (equality both ways; NO REPOSITORY FILE exit 0 distinct from AGREE; w00 missing exit 2).
  NOT YET actionlint-labels-agree.test.sh.new f2a3438523eefbdd: L1 stands — a checker accepting repository labels that are a SUBSET of
      w00's survives 8/0 (the w00-extra-label direction is untested); L2 small (absent repository file + missing w00 file).
  OK  call-line.test.sh ca157c3012b761af (3/0; path typo .yml mutant RED 1/2: it would otherwise pass as NO REPOSITORY FILE). It does not
      test -I; I read the line: -I present.
  OK  hold-w4f.sh.new adc86f1bf7d8325e: diff from 6da567de911b4896 = one added line after the actionlint leg, guarded by touches
      (workflows|actions|actionlint.yaml), NOTEST=1 leg, python3 -I, checker + both paths; a red leg sets st=1 (heavy-lib leg). Installs
      only after the follow-up's hold is complete and judged.
  OK  ledger leftovers-2026-10-16.md 2ce1552e2b6939ab: since my FINAL ACCEPT 2837a8e79add335d only 70e and 70f added (+ the range note).
- Round 2 items 1 and 2 re-judged (2026-10-16 ~15:45Z) at SHAS.txt 28bd32b14d0fadcf: OK.
  Item 1: v10 cb7bfe47d999ed31 (diff from 4cedeb576aad41a9: the placement note and the 1c heading only), tasks-lessons-block-3.md
  ce484f8af7c5ccb2, extract-blocks.py 3548b7d738d3e918. My dry run with the installed tool f62b8f1668b35f44 on copies at fef0d7d2a:
  "+1 bullets in 3 block(s)", todo unchanged, lessons +14 -0, block 3 once and directly before "#### Owners"; run 2 refuses "already
  applied". extract-blocks at fef0d7d2a "as stated" exit 0, block 3 byte-equal; on the applied copy FAIL (part 3 no longer pending).
  Item 2: actionlint-labels-agree.test.sh.new 93c62f25c9cd812d with the checker 671be58a2bcd334c: 10/0; repo-subset RED 9/1 (L1 closed),
  w00-subset RED 8/2, missing-as-AGREE RED 9/1, missing-w00 RED 9/1 (L2 closed); nested-list still survives (minor, recorded).
  Install now: the checker and this test (lock-free). hold-w4f.sh.new adc86f1bf7d8325e only after the follow-up's hold, on its own word.
  Block 3 is applied in the next tasks commit by the installed tool.
- Part 3 landed; three FINAL files pre-read OK (2026-10-16 17:02Z, hashes recomputed at that time = the FINAL lines):
  followup5c d6a8a26315759a52 = live 36a18afab8ff17c9 + the receipts line (verified detail), = the side file byte for byte; one token
  <HOSTED-COMPARISON-3>; it is the base for that fill (not a push body by itself). extract-blocks.py f397da0333d326f3: only STATE part3
  pending -> landed (+ comment); at b0b7bedf1 "as stated" exit 0; my planted cases (block 3 dropped, block 3 doubled) each FAIL "NOT
  EXACTLY ONCE" by name. v10 8d437d29f44b70c8: only the header sentences (landed at b0b7bedf1; present exactly once).
- Part 4 judged (2026-10-16 17:04Z; FINAL hashes recomputed then = the FINAL lines): v10 5d235bfac9e0f333 (diff from 8d437d29f44b70c8: the
  header "part 4 pending" sentence + section 1d), extract-blocks.py df45f5ceb9eb4389 (only part4 pending, the 1c end marker "## 1d.", block 4
  from its heading), block 4 23c7f12e7d3382c9, block 3 unchanged ce484f8af7c5ccb2. Facts against my records and the log: the 5.4 GiB dip
  (tc-gate 14.5 -> 9.1), two refusals 15 min apart (14:47:09Z, 15:02:06Z), the retry condition (15.02/15.23 GiB, log 5661), the hold line
  installed after the follow-up hold, disk 98G < 104G at the start gate (log 5678), the FINAL-line rule. Minor wording: the three body
  versions crossed my naming over ~90 s (15:42:03-15:43:32Z), not "within a minute" — not blocking.
  extract at b0b7bedf1 "as stated" rc 0, blocks 3 and 4 byte-equal; installed delta tool dry run at b0b7bedf1: "+7 bullets in 4 block(s)",
  todo unchanged, lessons +23 -0, block 4 once, after block 3, directly before "#### Owners"; run 2 refuses. Planted (part 4 applied):
  8 items "ALREADY at integ". OK: all three; extract-blocks df45f5ceb9eb4389 for its next use.
- Part 4 wording fix OK (17:06:34Z, FINAL hashes recomputed): v10 d9ab2f5e5c91d1bd and block 4 2a52b7d387817066 = the earlier OK'd
  versions with only "within a minute" -> "within about ninety seconds" (1 line each); extract-blocks df45f5ceb9eb4389 unchanged, "as stated";
  block 4 re-extracts byte-equal; my delta-tool dry run at b0b7bedf1: +7 bullets in 4 blocks, block 4 once before Owners, run 2 refuses.
- Part 5 judged (17:40:34Z, FINAL hashes recomputed): extract-blocks.py 4e8c6369cd3252c2 OK (only part5 pending, block 5, 1d end "## 1e.";
  "as stated" at b0b7bedf1; planted 14 ALREADY). Mechanics of v10 9b59fba7dfb6f73e / block 5 2f8cd10e102ec5e3 OK (dry run +12 bullets in 5
  blocks, order 3<4<5<Owners, run 2 refuses). NOT YET v10/block 5/ledger 3f03f53ed5b7dda0 for P5-1: the peer-gateway facts (block 5 bullet 5,
  ledger 70h) say the child was left "when its server closed" and "close it in the test's cleanup"; w4h-28b measured close() ends it and the
  orphan comes from a service process ending WITHOUT close(); the frozen fix c3affbfd5 is in the product (gateway ends at stdin EOF).
- P5-1 fixed (17:43:07Z, FINAL hashes recomputed): v10 304b09ad72800a1b, block 5 b298ce6c4b2a48f8, ledger fb4b9721f97978a7 = the previous
  versions with only the peer-gateway bullet and 70h changed (now: a service process ending WITHOUT close(); fixed at c3affbfd5, the stdin
  end-of-file exit). extract-blocks 4e8c6369cd3252c2 "as stated", block 5 byte-equal; dry run +12 in 5 blocks, run 2 refuses; identity
  clean. OK. Note for a later version: 70g still says "owner to be ruled"; team-lead ruled W4H-35 (its C7, after the kind proof).
- Ledger d244e11c99bc1899 OK (17:47:26Z): only 70g (owner W4H-35, C7, as ruled) and 70h (c3affbfd5 frozen and ACCEPTED). Note: name the
  verdict by hash 932b230d673f68c1, not "top section", in a later version.
- Ledger d928bab84fd67c19 OK (17:48:12Z): only 70h's citation now "verdict-w4h-28.txt at 932b230d673f68c1"; supersedes d244e11c99bc1899.

## Part 6 judged (2026-10-16T22:14:08Z, on w4h-36's three FINAL lines): OK
- v10 0f2a62b58c211390 (backup 304b09ad72800a1b): diff = header lines 6-7 (parts 4 and 5 landed at 8fb4474e9; part 6 pending for the W4H-32 round) + section 1f (5 bullets, placement after part 5 and before Owners). Facts check: old publish.sh f55db31d526c443a lines 11-12 (gate) and line 16 (the reattach.log redirect); union-exit.py 3ec27ab6246a68c7; installed publish.sh e3919a185e9386f0; plan-gate.md d80f5a5ccff58e22 and 87271bce4f5bc1da.
- extract-blocks.py 4cb9595987be8b25 (backup 4e8c6369cd3252c2) OK before its next use: diff = STATE (part4/5 landed, part6 pending), 1e ends at '## 1f.', block 6 from 1f. My run at 8fb4474e9 (tasks/ from git): rc 0, 'as stated'; blocks 3/4/5 unchanged (ce484f8af7c5ccb2, 2a52b7d387817066, b298ce6c4b2a48f8); block 6 = 2219d5fd781ccd0d byte-equal to w4h-36's file.
- My dry run with the installed delta tool f62b8f1668b35f44 on copies (part6-check/): run 1 rc 0 '+5 bullets in 6 block(s)', one insert of 25 lines = block 6 + blank line, directly before '#### Owners'; todo unchanged; run 2 rc 1 'already applied'.
- Ruled (2026-10-16T22:15:11Z, team-lead): the part-6 OK stands (five lessons, block 6 2219d5fd781ccd0d). The four further lessons (order rule; harness contract; graph mock pass team rule; hold routing by the product's lane classifier) become part 7 / block 7, same form, for the same W4H-32-round tasks commit (blocks 6 and 7). My checks on w4h-36's FINAL lines: v10 diff = header + section 1g only; extract-blocks.py change = STATE part7 pending + 1f end + block 7 only; blocks 3-6 unchanged; my extractor run at 8fb4474e9 'as stated'; block 7 byte-equal; dry run: blocks 6 and 7 each once, in order, before Owners, todo unchanged; run 2 refuses. Sources pre-checked: log 19:05Z/19:09Z/20:49Z, pending-lesson.md 233ce5809f9af8f6 l209-211, ci.yml:505 and test-file-sets.sh:496 at 8fb4474e9. Count: REBASE_NCOMMITS=15 = 14 + T1c (team-lead agreed).
- Nine-lesson part 6 judged (2026-10-16T22:16:22Z, w4h-36's FINAL lines): content OK. v10 36856cd19c08c70e (backup 0f2a62b58c211390): +15 lines, -0, the four lessons as the first bullets of 1f; sources check (log 19:05Z/19:09Z/20:49Z; verdict-w4h-32 aa6fdcbdff3067f9; pending-lesson 233ce5809f9af8f6 l209-211; ci.yml:505, test-file-sets.sh:496 at 8fb4474e9; cwj v3, wbc v2). extract-blocks.py 4cb9595987be8b25 unchanged: my run at 8fb4474e9 'as stated'; blocks 3/4/5 unchanged; block 6 8f0b750eb4fe5124 byte-equal. Dry run: one insert of 40 lines = block 6 + blank line before Owners; todo unchanged; run 2 refuses. FORM CONFLICT: team-lead's later ruling keeps block 6 at five lessons (2219d5fd781ccd0d) and puts the four in part 7 / block 7; w4h-36 wrote one nine-lesson block 6. Both forms carry the same nine lessons; team-lead picks. push15 folder: all 17 integrator hashes re-computed and equal.
- Form crossing (2026-10-16T22:17:00Z): team-lead's newest word kept the nine-lesson block 6, while w4h-36 had already re-built the two-block form. My stop to w4h-36 arrived after the write. On disk now: v10 b13932a2fe026edf, extract-blocks.py 89e0cc52a22a7bc2, block 6 2219d5fd781ccd0d (= the five-lesson file I OK'd), tasks-lessons-block-7.md present; the nine-lesson FINALs (36856cd19c08c70e, 8f0b750eb4fe5124) are no longer on disk, so my nine-lesson OK has no file to stand on. I recommended keeping the two-block form; team-lead confirms the form to w4h-36 and me; then I judge it on FINAL lines with the two-block dry run (blocks 6 and 7 each once, in order, before Owners; run 2 refuses).
- Part 7 judged OK (2026-10-16T22:17:34Z; form frozen by team-lead at w4h-36's latest FINAL lines = block 6 + block 7): v10 b13932a2fe026edf (from 0f2a62b58c211390: +1 header sentence, + section 1g with the 4 lessons, same text and sources as checked before; 1f unchanged). extract-blocks.py 89e0cc52a22a7bc2 OK before its next use (diff vs 4cb9595987be8b25: part7 pending, 1f ends at '## 1g.', block 7 from 1g). My run at 8fb4474e9: rc 0 'as stated'; blocks 3-6 = ce484f8af7c5ccb2, 2a52b7d387817066, b298ce6c4b2a48f8, 2219d5fd781ccd0d; block 7 = 4002e75f9108ba78. Dry run (installed f62b8f1668b35f44, copies): '+9 bullets in 7 block(s)'; one insert of 42 lines = block 6 + blank + block 7 + blank, directly before Owners; todo unchanged; run 2 refuses.
