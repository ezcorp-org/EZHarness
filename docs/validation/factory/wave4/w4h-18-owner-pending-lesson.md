# W4H-18 pending lesson (2026-10-09, after the freeze)

Pattern: the lead ordered "report R2 (unit green + mutants) before R3". The order arrived after I had already run R3, the legs and
the gate commit in one turn. My only R2 report was inside the final report, so R3 ran under the lock with no stage report before it.
Rule: when a brief or a ruling names a stage order ("report X before Y"), send a SendMessage at the end of each stage before
starting the next heavy step, even when the next step needs no ruling. The lock-queue time is not a reason to skip the report.
