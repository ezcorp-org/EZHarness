# W4H-31 pending lessons (owner)

- Every new worktree needs the same setup, in one script, before any gated leg. These steps cost two queue turns here:
  `svelte-kit sync` after an --ignore-scripts web install (W4H-29 had already found this), and the storage directory in
  env.sh (I copied the W4H-30 env.sh, which lacked it, instead of the W4H-26 one). Each failed late, under the lock.
  Build env.sh and the setup from one checked template, and make each gated script check its own preconditions first.
- A sync merge of main maps more tests than the hook cap. Raise the cap and run them all in the lock. Do not skip them.
  Here 153 files ran.
- When a merge adds an optional field that a runtime refuses without, typecheck cannot find a missing site. Audit every
  call site by search, and add a test at each site you own, then check the test with a mutant.
- I wrote my own lcov merge in W4H-30. The repository already has scripts/merge-lcov.ts. Search the repository before
  writing a helper.
