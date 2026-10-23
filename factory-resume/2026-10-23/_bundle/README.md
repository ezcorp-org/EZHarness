# factory-resume/2026-10-23: resume bundle for the W4H-35 factory release round

A curated, REDACTED copy of the team's evidence text (the coordinator log, the handoffs, the release task list, the 10-23 ledger,
every validator verdict and plan, the briefs, the integrator queue, and the scripts of the open work), so the work can resume
elsewhere. Redaction was done on the COPIES only; the evidence originals are unchanged. `evidence/...` paths are relative to the
original evidence root. Placeholders such as `<USER>`, `<WORD>`, `<PID>`, `<IMAGE-ID>`, `<PODMAN-NET>`, `<PORT>` replace classes of
values; whole lines about the user's own machine or remote access are replaced by `<USER-DISK-SURVEY: ...>` or `<REMOTE-ACCESS: ...>`.
See `redaction-map.md` (classes and counts only, never values).

Process ids and local container ids: their redaction is BEST EFFORT. Numbers that the source names as a process (and a list of
known values) are replaced, but free-text mentions of process ids (for example after a program name) and some container-id
prefixes may remain. They carry no access value; they are not claimed to be absent.

`scan-hits.tsv` lists every remaining hit of the fixed scan list with its reason; `pid-rule-residuals.tsv` lists every number after
a process word that the pid rule still finds, with its reason; `left-out.tsv` lists the files left out; `file-list.tsv` lists every
kept file with its sha256. Raw logs, binaries, images, coverage dumps and files over 5 MB are not included.
