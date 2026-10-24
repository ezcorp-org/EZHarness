# Follow-up 2 (2026-10-23)

Added at the request of the agent resuming this work on another machine:

- the 27 tools bound for the W4H-35 hold (`w00/w4h-merge/.../bound-tools.txt` lists them with their hashes);
- the run-13 kind-proof driver: `w4h-35/repro/kind-proof.sh` (current, with the L3 previous-log step), `kind-proof.sh.v-f97db4a0` (the version run 13 used), `kind-proof.sh.v-dec11148` (the approved leftover version), `hosted-images.ts`, `hosted-settings.ts`, `known-unresolvable.txt`, `kind-podman-shim/` and the driver tests;
- the shared lock and word tools `w00/coord-word.sh`, `w00/lock-read.sh`, `w00/gated-flock.sh`;
- the session-11, C9-resume and run-13/14 launch and session scripts, and the R2 expected records.

Same redaction tool and checks as follow-up 1. Paths and private values are placeholders.

## Added by hand after a manual scan

The tool's name rules dropped these tool files (a word id variable name, test strings like 'BEGIN PRIVATE KEY marker', backup-name rules). Each was read for private values, rewritten with the same path rules, and gitleaks-scanned:

```
w00/coord-word.sh	34d9989d558e3b61	34d9989d558e3b61
w00/lane-table.tsv	ce85597098ee4f72	ce85597098ee4f72
w00/gate-leg-fixtures/passed-session5-default.log	b1a0297506aab4a1	b1a0297506aab4a1
w4h-35/repro/key-sweep-allow.test.sh	6420cb2af54f592e	707b04fbe93c9fd8
w4h-35/repro/kind-proof-records.test.sh	88dfe5cbeb9c5c60	c1ca9d7b1ff11251
w4h-35/repro/kind-proof.sh.v-dec11148	dec1114866ad9437	439630695bace97b
w4h-35/repro/kind-proof.sh.v-f97db4a0	f97db4a004ccfc69	e3c36685f496e3ef
```

One CIDR in kind-proof-cidrs.test.sh line 5 was rewritten to <PODMAN-NET>/24.
