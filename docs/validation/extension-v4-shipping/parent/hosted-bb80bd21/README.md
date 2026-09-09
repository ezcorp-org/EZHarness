# Hosted validation at bb80bd21

Source: `bb80bd21de2eb6c9dbe33454b227ff6887a35563`. [Ordinary CI](https://github.com/ezcorp-org/EZHarness/actions/runs/34173371290) runs the normal workflow and browser configuration.

The [backend parent review](backend-parent-review.json) verifies all twelve raw first-pass shard logs with no failed cases or retry sweep. It also records actual coverage, web, static, database, and dependency log summaries and hashes. The [browser parent review](browser-parent-review.json) verifies all five raw browser logs, their full passing counts, and no native crash or structured HTTP 500 record.

Expected negative-case logs, existing startup warnings, and thirteen production-only mock skips remain visible. No zero-console-warning or new all-screenshot review is claimed. The main shipping report records the final production result and the unchanged 83 unapproved policy findings. Raw logs and browser state remain private.

The [production parent review](production-parent-review.json) verifies all eight candidate-image checks, eleven launcher cleanup records, nine current application logs, exact source/image identity, and all eleven resource samples. All 34 technical jobs pass. The resource run completes ten cycles and 100 reconnects; memory growth is 7,864,320 bytes against the unchanged 67,108,864-byte limit. A second Terra review independently agrees. The only failed job is Gate integrity, with 83 unapproved findings exactly reproduced locally in 4.26 seconds.

The final publication changes documentation and retained evidence only. Its source, test, dependency, and configuration files must remain identical to tested bb80bd21. Any automatic documentation-head CI run is separate from the completed source proof above.
