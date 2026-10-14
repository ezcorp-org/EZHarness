# W4H-27 pending lessons (owner)

- A proof is only as current as the bytes it ran. W16 G7 rendered the shipped Compose file correctly, but it ran an
  image whose lock had a plain SWC addon; a later main sync swapped in a carrier addon that needs an executable user
  cache, and no proof started the image again. Guard a shipped configuration with a check that runs on every change,
  on an image built from that change, with its flags read from the shipped file rather than restated.
- `git log -S` on a lockfile misses a version that only a merge commit introduced. Read the merge parents, or bisect
  the first-parent history by the value, before saying a dependency "has not changed".
- A file name `tsc` emits into `dist` can collide with a build artifact written into the same `dist`
  (`workflow-bundle.ts` vs `workflow-bundle.js`); a forced rebuild then overwrites the artifact silently. Name build
  artifacts apart from every module name.
- `postinstall` runs `build:packages` on every install, in every CI job and every Dockerfile. A build step that needs
  a tool only one image has (Node in the factory image) belongs in its own script, not in a package's `build`.
- A unit test that compares a default to its source of truth (the reference adapter) does not prove the default is
  valid; parse it through the real parser. The local release profile matched its source exactly and was still
  refused, because the source carried a sixth field.
- In zsh, `for f in $F` does not split a string; a red-first loop that swaps base files must run under bash, or it
  silently tests the new code twice.
- Never append a command to a pipeline that ends in `head -0` to "discard" it: it still runs (a lock-free tsc ran
  outside tc-gate this way).
- A proof harness that lives only under /tmp rots: W16's prove-selfhosted.ts lost its ./temporal-http-checks.ts
  import and could not be re-run when it mattered. Keep proof harnesses in the repository with their helpers, and
  parameterize tenant names instead of hard-coding them.
- Check the commit identity before the first commit: `git config user.email` in a new worktree must be the address
  main uses (`git log -1 --format=%ae origin/main`), never a personal one; this repository is public.
- An idempotent `up` must not touch a shared service that already runs. Re-publishing the fleet host on every `up`
  recreated the pool and restarted the supervisor for every installation; ask the runtime whether it serves first.
