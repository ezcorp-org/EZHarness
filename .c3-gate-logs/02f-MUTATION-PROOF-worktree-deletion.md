# Mutation proof — the worktree-deleting `rmSync`

Root cause of the previous agent's destroyed worktree, reproduced and fixed.

## Setup

```
/tmp/c3-rmproof/fake-worktree/CANARY.txt   ("I am the worktree")
EZCORP_DB_PATH=/tmp/c3-rmproof/fake-worktree/db
bun test ./src/__tests__/db-connection-real-init.test.ts --timeout 30000
```

`preload.ts:17` yields to an explicit `EZCORP_DB_PATH`, so the pinned value
wins and the suite's cleanup computes its target from it.

## Result — WITH the fix (`EZCORP_TEST_DB_TEMP_ROOT` ownership check)

```
drwx------  backups
.rw-r--r--  CANARY.txt
drwxr-x---  db
CANARY_PRESENT=YES
```

The suite created `db/` and `backups/` inside the pinned directory — exactly
what it would do inside a real worktree — and deleted nothing.

## Result — MUTATED back to the original line

Mutation applied to the `afterAll`:

```ts
const p = conn.getDbPath();
if (p && p !== ":memory:" && p !== "external") {
  rmSync(dirname(p), { recursive: true, force: true });
}
```

```
CANARY_PRESENT=NO
WORKTREE_PRESENT=NO
```

`/tmp/c3-rmproof/fake-worktree` — the whole directory, not just the DB — was
recursively removed by the test suite. That is the mechanism that erased the
previous agent's checkout mid-run.

## Consequence for the handoff brief

The brief instructs: "Pin `EZCORP_DB_PATH` **under `/tmp`, NOT inside your
worktree** — an in-worktree DB path is the prime suspect for the deletion."

The diagnosis is right and the instruction is wrong in a way that matters:

* Pinning the variable **at all** is what arms the bomb, because pinning is
  precisely what makes `preload.ts` yield ownership of the path.
* Following the instruction literally (`EZCORP_DB_PATH=/tmp/c3-cert-db`) made
  `dirname(p)` equal `/tmp`, and the full backend lane came back
  `20814 pass | 2 fail`, both failures in this one file, as the cleanup tried
  to recursively delete `/tmp`.
* The correct action is to set **nothing**. `preload.ts:18` already mints
  `mkdtempSync(join(tmpdir(), "ezcorp-test-db-"))` per test process — already
  under `/tmp`, already outside the worktree, and already per-process isolated,
  which a single shared pinned path is not.

Backend lane exit codes:

| env | exit | result |
|---|---|---|
| `EZCORP_DB_PATH=/tmp/c3-cert-db` | 1 | 20814 pass, 2 fail (this file) |
| unset (preload owns it) | 0 | see `02g-backend-test-clean-env.txt` |
