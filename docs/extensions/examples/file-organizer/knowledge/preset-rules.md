# Organization presets & the quick-rule mini-DSL

The File Organizer recognizes garbage and routes new files using **rules**.
Rules come from three places: built-in **presets**, one-line **quick rules**
(the mini-DSL), and structured **custom rules** authored by the agent.

## Built-in presets

Toggle these per-folder on the **Folders & Rules** page.

### `junk-sweep` (destructive → quarantine)
- `*.tmp` — temp files
- `*.bak` — backup files
- `.DS_Store` — macOS folder metadata
- `Thumbs.db` — Windows thumbnail cache
- `*.log` older than 30 days

### `downloads-router` (non-destructive → move)
- `*.png` → `Images/`
- `*.pdf` → `Documents/`
- `*.zip` → `Archives/`
- `*.dmg` → `Installers/`

### `duplicate-killer` (destructive → quarantine)
- Files with identical content (sha256) to another file. Hardlinks are
  excluded from dedup-delete; symlinks are never touched.

### `stale-archiver` (non-destructive → move)
- Files older than 90 days → `Archive/`

## Quick-rule mini-DSL

Author a single rule from one line on the Hub or via the agent's
`teach_rule` tool:

```
<glob> [older <Nd|Nh>] [larger <Nkb|Nmb|Ngb>] -> <quarantine|DestFolder>
```

Examples:

```
*.tmp older 7d -> quarantine
*.zip larger 100mb -> Archives
report-*.pdf -> Documents
```

- The glob supports `*` (any run, no slash) and `?` (single char). It is
  compiled to a linear-time, anchored regex (ReDoS-safe).
- `older` takes a duration in days (`7d`) or hours (`12h`).
- `larger` takes a size in `kb`, `mb`, or `gb`.
- The destination `quarantine` makes the rule destructive (reversible);
  any other word is a routing subfolder under the watched root.

## Safety invariants

- **No hard deletes.** "Delete" = move to `.trash/<id>/` with an undo
  manifest. Only the TTL/size-cap prune ever hard-deletes.
- **Never overwrite.** Collisions get a deterministic ` (2)` suffix.
- **Symlinks skipped, hardlinks excluded from dedup** (both opt-in later).
- **Circuit breaker.** A rule about to act on more than half a folder's
  files in one tick is paused — a guard against an over-broad rule.
- **Stability gate.** A file is acted on only after it's been quiescent
  (size + mtime unchanged) for the configured number of ticks; in-progress
  downloads (`.crdownload`/`.part`/`.partial`/`.download`, `~$*` office
  locks) are always skipped. (A bare `.tmp` is a legitimate junk target,
  so it is NOT skip-listed — the stability gate defers it while it's still
  being written.)
