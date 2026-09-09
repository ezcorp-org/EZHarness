# Source mapping

| Curated file | Raw source | Capture identity |
|---|---|---|
| `inputs/chat-tools-original-2bdf4708.ts.txt` | `git show 2bdf4708594db3e27e25269e7c4fbb7cf0dc87f7:src/__tests__/chat-tools-integration.test.ts` | original hosted head |
| `inputs/auto-note-original-2bdf4708.ts.txt` | `git show 2bdf4708594db3e27e25269e7c4fbb7cf0dc87f7:src/extensions/first-party-integration/auto-note/legacy-subprocess.integration.test.ts` | original hosted head |
| `inputs/chat-tools-final-wip.ts.txt` | isolated repair worktree `src/__tests__/chat-tools-integration.test.ts` at the focused-run capture | SHA-256 `c84938d576efb18d270bde9319df1657679359781275ecbcf4ffffa34b01408b` |
| `inputs/auto-note-final-wip.ts.txt` | isolated repair worktree `src/extensions/first-party-integration/auto-note/legacy-subprocess.integration.test.ts` at the focused-run capture | SHA-256 `ef72e0470cc978d9387538c9c0e2e5724381729d166cdae0fdaf9f8c2b43db01` |
| `controls/auto-note-old-close-control-reconstructed.ts.txt` | reconstructed from the captured final auto-note input by replacing only the termination and `close()` waits with the prior fire-and-return behavior | reconstruction; not a pre-run source capture |
| `logs/old-close-control.*` | isolated worktree `.cache/flake-repro/old-close-control.*` | actual red control |
| `logs/final-covered.*` | isolated worktree `.cache/flake-repro/fixed-bounded-covered-final4.*` | actual green focused coverage |

The parent later corrected a narrow TypeScript cast in the integrated chat test. That correction is outside this focused-run capture; this folder preserves the exact inputs that produced its logged red/green results.
