# W4H-33b lessons (for the integrator)
1. When a test gains a runtime need (here: the Podman runner, after a network gate was removed), check its lane in the
   same commit: run the lane set function (web_bunleg_files, web_host_files) and route it by the classifier. A local
   in-lock leg that has the need hides the gap.
2. A changed web/src/lib file reaches the PR mutation job. Before freeze, check that its covering tests load in
   Stryker's sandbox; an alias that points outside web/ fails only there and reads as "survived with no test run".
3. A proof job that installs the pinned conmon needs an explicit --log-driver on every podman run. Reproduce with
   "podman --conmon <pinned conmon>" on a small image; no image build is needed.
4. Never probe the heavy lock with "flock -n"; read the process list instead.
5. A test that drives host-integration suites is itself host integration: mark it, or the release snapshot seals it
   without its targets and the isolated build fails. A rule now checks every sealed test's path literals.
6. A fixture identity lives in pairs: the place that logs in and the place that creates the account. Move both in one
   commit, and search the old address in the whole tree, not only the test tree (seeds, proof scripts, Compose, CI).
7. A source change in a bundled extension (tests and docs too) changes its source lock; regenerate per commit so each
   finding's commit carries only its own lock lines.
8. A freeze-leg script must refuse unless HEAD is the frozen sha and the tree is clean, and must log the head it ran
   at (validator-8, W4H-33b). bin/legs*.sh now do this through W4H_FROZEN_HEAD.
9. A freeze includes the repository typecheck even when it needs a lock slot (W4H-33b: the merge hook's fast typecheck
   refused a test-only TS2769 that no single-file run sees). Ask for the slot before the freeze report.
