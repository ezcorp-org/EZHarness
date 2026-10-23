# validator-8: standing rules for the W4H-32..36 plans (2026-10-16; each plan refers here instead of repeating them)

Base: every package branches from the accepted W4H-31 merge 390c49a90. Briefs: w00/briefs/w4h-<n>.md (shas in each plan).
S1 Identity: author and committer = the <USER> noreply address on every commit (identity-check.sh commits mode); the files
   and content modes clean on every changed file (pattern check 3a9da7ef720e7a0e; reserved-domain fixtures only); no
   personal address in diff, log or evidence; I write "<a non-noreply address>" for any hit.
S2 Contract rows FIRST: each row commit precedes the code that implements it (git log order); the code matches the row
   field by field.
S3 Red first BY ASSERTION: I re-run each red myself on the commit before the fix (a load error or a missing module does not
   count; then mutants decide). Green at the frozen head.
S4 Mutants: the ones in the brief plus mine; each must make a NAMED test red; a survivor is a finding (test gap).
S5 Tests and coverage: the hook-mapped suites and the owner's focused list, plus the repo's inventory and registration tests
   that scan the tree (my rule after PR 341); 100 percent of changed lines (my changed-lines tool; resolution lines too if
   a merge is involved); new-file gate; CRAP informational unless ruled.
S6 Gates: gate-integrity default, main and base = exactly 0 (a vacuous test behind a helper callback counts; assertions in
   the test body); lint, boundaries, factory-boundaries, schema drift, build:packages; typecheck by the tc rule (lock-free
   >= 16 GiB, else in the lock >= 12 GiB).
S7 Security: no token or secret in any file, test, log, receipt or message (sweep: JWT-like, Bearer, sk-, gh*_, key=value
   with long values, URL passwords); secrets only by path or environment as the brief allows; nothing printed.
S8 Isolation: my legs run in my own snapshot or on copies; never in an owner's or the integrator's worktree while a hold may
   use it; Podman only; my own PostgreSQL and storage; temp files only under validator-8/; remove only what I created, by
   name; never prune; never kill a process I did not start.
S9 Heavy legs only through w00/gated-flock.sh (live-pid yield to w4h-28/proof/real-run.pending), the gate once inside;
   floors disk >= 104 G, swap >= 2.5 GiB, mem >= 6 GiB, in-lock 12 GiB; never hold the lock while waiting for a person.
S10 Verdict: append-only file with sha256 (first 16 hex) after the write, mode 0644; ACCEPT only when every leg of the plan
   holds; otherwise REJECT or FINDING with file:line, and team-lead rules.

S11 (2026-10-16): own-pg.sh pulls by digest after the integrator's change (plan-w4h-31.md, own-pg.sh addendum); my own
PostgreSQL legs use own-pg.sh only after that change is installed and checked; until then I record the image digest my
container ran (podman inspect) in each verdict.
