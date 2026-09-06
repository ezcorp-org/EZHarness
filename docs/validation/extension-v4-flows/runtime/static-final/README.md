# Final static validation

This receipt records static validation after this runtime worktree fast-forwarded to the parent integration commit `6c92c855a33ecb6e3b60519f8a15743eaf37b3ec`.

The commands used the shared validation lock and an environment whose recorded executables were Bun `1.3.14` and Node `v22.22.2`. `raw/provenance.log` records the source commit, executable versions, and clean status before these receipt files were added.

| Check | Command | Exit | Raw output |
| --- | --- | ---: | --- |
| Root typecheck | `bun run typecheck` | 0 | [root-typecheck.log.gz](raw/root-typecheck.log.gz) |
| Root lint | `bun run lint` | 0 | [root-lint.log.gz](raw/root-lint.log.gz) |
| Web check | `bun run --cwd web check` | 0 | [web-check.log.gz](raw/web-check.log.gz) |

The lint and Svelte checks reported existing warnings but no errors. Their full diagnostics are retained byte-for-byte in the linked compressed raw logs; no warnings were suppressed and no production source changed during this validation.
