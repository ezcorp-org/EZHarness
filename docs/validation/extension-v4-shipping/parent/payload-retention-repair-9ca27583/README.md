# Request-body retention repair at 9ca27583

The parent independently ran the permanent HTTP regression with pinned Bun 1.3.14. Normal mode passed all 10 cases (15 assertions). Selecting the previous native-body handling failed the same retained-request predicate: expected exit 1. Both actual logs are retained. Default CI uses only the repaired path, so a future runtime fix does not cause a false failure.

The first full typecheck exited 1 because a newly added launcher test had a broad subprocess-pipe type. The parent fixed that test, repeated its real runner integration (exit 0), and passed all four typecheck sections (exit 0). The original failure and corrected follow-up are separate. All four copied source files match committed `9ca275838faf30666da5dba1c0eba141dd053050` exactly; normal commit hooks passed.

The separate two-batch private HTTP reproduction records 10 warm calls, then two 500-call batches. The JavaScript-stream case keeps Request counts at 2, 2, and 2 after collection. Its second RSS sample is 37,871,616 bytes lower than its first. The original result and exact available input copies are retained with a per-file hash review. This is isolated HTTP evidence, not a successful 30-minute production resource run.

No heap snapshots or authenticated app traffic are included. The pending production rebuild and full regression runs have their own receipts.
