# Follow-up 1 to the resume bundle: the session-11 drafts and the other-machine handoff

This commit only ADDS files on top of the bundle commit ea694eedb (its files are unchanged). It adds what another machine needs to
redo W4H-35 session 11: `w4h-35/merge-prep/session11/08.patch` .. `11.patch`, their commit messages (`w4h-35/merge-prep/msg-fix-ci-01.txt`
for 08, `msg-s11-09.txt`, `msg-s11-10.txt`, `msg-s11-11.txt`), `w4h-35/merge-prep/session-11-plan.txt`, `w4h-35/merge-prep/s11-set-shas.txt`,
and the handoff `w00/HANDOFF-OTHER-MACHINE-2026-10-23.md`.

The same curation as the bundle (redaction on the copies; see `../README.md`), with one added rule: synthetic test fixtures stay
verbatim, so that the patches still apply. These are addresses at a reserved test domain (RFC 2606/6761, for example `test.local`,
`example.invalid`) and UUIDs whose first 12 hex digits are zero. The patches 08..11 are byte-identical to their sources, and their
sha256 values are the ones in `session-11-plan.txt` and `s11-set-shas.txt`. In `s11-set-shas.txt` the two absolute evidence paths read
`evidence/...`; the hashes are unchanged.

Records here: `file-list.tsv`, `left-out.tsv` (empty), `scan-hits.tsv`, `redaction-map.md`, `pid-rule-residuals.tsv`. The file list of
this commit with sha256 is `../MANIFEST-followup-1.md`.
