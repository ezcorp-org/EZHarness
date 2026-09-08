# Hosted backend checkpoint — 0733ca51

This is a safe record of the assigned hosted backend checks for commit `0733ca51daf570227bd801b14991700ad0ca0c12` in `ezcorp-org/EZHarness`.

All 18 assigned jobs completed successfully on their first pass. They include coverage shards 0–11, coverage extras, residual integration tests, backend critical tests, the per-file coverage gate, external Postgres, and the dependency audit. The complete job metadata, terminal summaries, timestamps, and private raw-log integrity map are in [checkpoint.json](checkpoint.json).

Coverage extras ran Bun groups totaling 1,435 passing tests across 81 files and Vitest with 291 passing files and 4,708 passing tests. The per-file gate reported 1,260 threshold files, 134 new source files, and 395 patch files. The Postgres job reported 24 passing tests, 93 assertions, and no failures. The dependency audit reported four allowlisted findings and six below the configured floor.

Raw hosted logs are not published because they can contain credentials or sensitive runtime data. `checkpoint.json` retains each private log's stable job-based name, byte count, and SHA-256. This checkpoint does not cover web-security coverage or establish success of all workflow and publication requirements.
