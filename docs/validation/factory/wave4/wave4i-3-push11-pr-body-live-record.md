# PR 341 description: which body is live (read back 2026-10-16, after validator-8's finding)

Timeline (each read back from GitHub with `gh pr view 341 --json body`; hashes are sha256/16 of the body with trailing newlines removed):
1. 04:2xZ  pr-body-applied.md    de2b276e1d989ecc  the cut-down body, hosted line "pending: ci 38850371515 ..."
2. 04:5xZ  pr-body-applied-2.md  99ef04ed97dc1672  the integrator's comparison wording ("59 jobs, 55 success, 3 skipped, 1 failure ...")
3. 04:57:28Z (PR updatedAt) pr-body-applied-3.md 866c454abbd57820  team-lead's parity wording - LIVE NOW
The live body read back now (raw file pr-body-live-now.md) normalises to 866c454abbd57820 = pr-body-applied-3.md; its raw sha256/16 is
9a3aa78ec72501bf (gh adds one trailing newline). Correction: the receipts commit d2845e151 described the body as the cut-down
body "then the hosted comparison" (applied-2); applied-2 was live only from 04:5xZ to 04:57:28Z and was replaced by applied-3.
