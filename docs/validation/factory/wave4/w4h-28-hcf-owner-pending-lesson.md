# W4H-28 pending lessons (owner)

- A cleanup list never holds a shared root (lead, 2026-10-14). Never derive a cleanup path from a parent of a temporary directory. A test pushed `join(root, "..")` (= /tmp)
  into its cleanup list; `rm -rf /tmp` failed with EACCES and deleted nothing, by luck. A cleanup list holds only
  the exact results of `mkdtemp`, one per case.
- A proof harness that stops a stack must stop it in a `finally` path that also runs on a harness error, and must
  remove its own runner store with `podman unshare rm -rf` (the guest wrote files as a mapped user).
- Before a full proof, read how an existing end-to-end spec drives the same product path. The console spec
  already published release trust, the release switch and the contract over HTTP; reading it first would have
  saved one full proof try (factory_release_trust_missing at acceptance).
- A factory source carries its own `version`. To publish a second version of the same definition, change the
  source's `version` too; publishing 1.0.1 over a source that says 1.0.0 is factory_version_conflict.
- An output port shape decides which release profiles can resolve. The freeze node's artifact-shaped candidate
  port made both the S3 and the GitHub profile impossible; check a port against every consumer's schema before
  a proof, not during it.
- A host reply bound that is right for control messages can be wrong for one route that carries artifact bytes.
  Bound that route by name; never raise the bound for every route.
- gated-flock.sh takes `<label> <log>` before the command. Read a wrapper's usage line before calling it. My first call
  passed `bash proof/full.sh` as label and log, so the wrapper appended its log lines to full.sh itself (found and
  removed at 19:4xZ; they sat after `exit`, so they never ran, but `bash -n` failed).
- An outer timeout must wrap the pass AND its cleanup, never cut between them (lead, 2026-10-14). real-1's outer
  `timeout 5400` would have killed the harness before its own 5400 s wait ended and before its cleanup ran; I paused the
  timeout (SIGSTOP) so the cleanup could run, then resumed it. Fix in place: the outer bound is now derived from the inner
  waits plus the run plus a cleanup margin (real.sh: provider wait + lock wait + 3,600 s), so every inner bound ends first.
- A pass that waits for a person never holds a shared lock while it waits (lead, 2026-10-14): wait lock-free, then take
  the lock only for the work.
- A poll with long gaps must not reuse a pooled keep-alive connection (2026-10-14). real-2 polled /api/providers every
  30 s; the server had closed the idle socket, the reused socket failed ("The socket connection was closed
  unexpectedly"), and the harness treated that one transport error as fatal and stopped its own stack at 17:41:15Z,
  seven minutes into a four-hour window (web log: SIGTERM from the harness's stop, no crash, no OOM, no timeout). Fix:
  each slow poll sends `Connection: close`. That was NOT enough: real-3 ended the same way at 18:32:28Z, and the web
  server still held one request in flight at shutdown, so the server held a request past its idle timeout (the host was
  short of disk and swap). The real fix: a read with no effect is retried at the next poll, recorded, and ends the wait
  only after ten failures in a row. A wait a person depends on never dies on one transport error. Verify a fix by
  rerunning the case, not by reasoning about it.
- real-2 and real-3 failure facts (lead's request, 2026-10-14):
  - Transport error, both passes, verbatim: "TypeError: The socket connection was closed unexpectedly. For more
    information, pass `verbose: true` in the second argument to fetch()" at stack.ts:142 (session.call).
  - Server side at that moment: NO log line. The web log goes from the boot lines (17:34:34Z / 18:14Z) straight to the
    harness's stop ("graceful shutdown begin ... SIGTERM" 17:41:16Z / 18:32:38Z). At real-3's stop one request was still
    in flight and never finished ("in-flight drain timed out ... stillInFlight 1", 18:32:57Z): the provider read was
    stalled inside the server, not answered late.
  - Host at that moment (my gate log, 2-minute samples): 17:39-17:45Z MemAvailable 0 GiB, swap free 96 / 628 / 0 KiB of
    17 GiB, disk 94 GB; 18:29-18:31Z MemAvailable 0 GiB, swap free 24 / 76 KiB, disk 92 GB. At 18:33Z, after real-3's
    stack stopped, MemAvailable 10 GiB and swap free 486 MiB. My stack's own share is about 1.5 GiB RSS over 17
    processes (measured on real-4), so most of the pressure was other host load.
  - Verdict: the web server was unhealthy under memory exhaustion. With no memory and no swap, a request that reads the
    database stalled past the server's idle timeout and the server dropped the connection. `Connection: close` could
    not prevent that: the connection was new, the request itself stalled. The harness fix (retry, ten in a row ends by
    name) makes the WAIT survive. It does not make the server healthy: a run started under the same pressure would
    stall the same way. So the single real run starts only when MemAvailable and swap are back above the resource gate's
    floors, which the lock wrapper (gated-flock) already enforces before it takes the lock.
- real-5's 503 (2026-10-14, 23:02-23:42Z) was the shared proof PostgreSQL, not the web server. A host-wide memory
  exhaustion at 23:00-23:02Z (kernel OOM killer: chromium, bun test processes, desktop services; my stack is about
  1.5 GiB of it) killed the user's systemd manager (`user@1001.service: Main process exited, code=killed, status=9/KILL`,
  23:02:25Z). systemd then SIGKILLed every process left in that unit, including the conmon of
  factory-platform-proof-postgres (rootless podman lives under the user manager), so its `on-failure` restart policy never
  ran. The database stayed down until someone else started it at 23:38:23Z; its crash recovery fsynced the whole data
  directory (many databases from many sessions) and accepted connections only at 23:42:00Z. In that window the web
  server's settings read failed and every page answered 500/503; at 23:43Z it answered 302 again with no restart (its
  pool reconnects). The harness wait survived: an HTTP error answer is not a transport failure. Fix at the root is outside
  this package: host memory (other load) and the placement of a shared service in the user manager. I did not restart or
  touch the shared container. Lesson: when a product page fails, read the database's own log (`interrupted; last known
  up at`) and the journal (`user@<uid>.service ... KILL`) before suspecting the product.
- A command line that catches "everything else" as one generic code hides the one fact the user needs. The Codex import
  printed `{"error":"codex_login_import_failed","errorClass":"Error"}`: the class of drizzle's wrapper, not of the cause.
  Reproduced end to end with the old CLI against a closed port (red/codex-import-e2e-old.log, the user's exact line). The
  attempt fell inside the database outage above (no stdout line: it failed before the first log line, at the first
  query). Fix: every step refuses by its own code with WHERE it failed (key names, claim path, variable name, host:port,
  the deepest cause's class and code), never a value; a --dry-run runs every step but the write. A tool a person runs
  once must say why it failed in its first answer.
- I passed the proof PostgreSQL admin password as a `podman exec -e NAME=value` argument once (23:47Z, read-only query,
  local process list only). Rule: `-e NAME` with the value in the environment, never `NAME=value` in argv.
- Never pass a secret through a shell (validator-8, 2026-10-15). The import wrapper eval'ed the web secret into its
  environment and put the database password in DATABASE_URL: a value with $, a backtick, a backslash or a quote would
  be mangled, and every secret sat in /proc/<pid>/environ. A tool reads a secret file BY PATH in its own process and
  sets what it needs in-process (1c505eaea). The real deployment's secrets are plain [A-Za-z0-9_-], so the eval was
  not the cause of the user's failure here; it was still a defect.
- "Not configured" must be a positive answer, never the catch-all of a failed read (validator-8). Readiness turned a
  database error into provider_not_configured; now only the ladder's typed refusal is (6b43ce6e5, contract row first).
- One marker path, owned by a pid (lead's ruling 1): a per-label marker with a timestamp could not tell a live pass
  from a dead one. proof/real-run.pending = "<wrapper pid> <label>", atomic write, removal only by the owner.
- The user manager came back at 23:38:20Z through a manual `sudo systemctl start user@1001.service` (not ours); the
  proof PostgreSQL started 3 s later (RestartCount 0: no restart policy fired). real-5's processes survived the OOM
  (they live outside user@1001.service); the web server reconnected by itself at 23:42Z.
- A credential ladder that falls through on "any error" masks the cause (P-F3, validator-8). Each step must say
  which of three things happened: nothing stored (fall through), stored but broken (fall through, and say so as a
  warning), or the store itself failed (refuse). Classify by type, never by message.
- Leftover (not this package): the shared proof PostgreSQL and every rootless podman container run under
  user@1001.service, so an OOM kill of the user manager kills them all with no restart policy run.
- A "persistent deployment" must keep every store the database points into (real-8, 2026-10-15). The proof kept the
  product database, its secrets and master key, but each pass made a new extension runner store and removed it at
  cleanup. The database's one reference-code release had been built into real-5's store; real-8's runner could not
  start it (collectArtifacts: Error ENOENT), and the runner's catch-all answered "Runner request was invalid" (400),
  blaming the caller and hiding the cause. Fixes: the harness keeps the runner store with a kept deployment; the runner
  names artifact_missing and answers any other unknown error as runner_internal_error (500) with class and code
  (2a0c65e74); a failed activation ends the pass at once. Lesson: list every store an installation references before
  calling a deployment "the same installation", and never let a catch-all choose a 4xx.
- Rotating a credential: write the new value to a 0600 pending file BEFORE changing it in the server, and verify on
  the path that actually checks it (2026-10-15). My first rotation ran ALTER ROLE, then "verified" on the container's
  127.0.0.1 path, which pg_hba trusts (any password logs in): the check failed, the script stopped, and the new value
  existed only in the dead process. Host logins (scram over the published port) with postgres.env failed for about
  30-60 s until the repaired script (pending file first; host-side verification) rotated again at 15:05:27Z. Read the
  server's auth rules before verifying a password change.
- An assertion inside a helper's callback is invisible to gate-integrity (2026-10-15, AG). The two P-F3b tests passed
  every expect into withOAuthRowReadFailing's callback; a helper that never ran the callback would have kept them green.
  Rule: a helper that scopes a fault returns the values; the test body asserts them. Check: the "helper skips its
  callback" mutant must turn the test red.
- A harness behaviour without a test is a claim, not a proof (AB-3). The fail-fast lived inline in a top-level script
  no test could reach; moving the pass lifecycle into a small module made a fake-product test with a time bound possible.
- Name a summary figure for what it counts (AC-3). "Known cost" summed only the stop/reconciliation ledger, so every
  run that completed normally showed Known 0; the test-provider proofs could not show it (their cost is 0). A real,
  non-zero-cost run is the first time such a figure is checked; read each displayed number against the ledger it sums.
- Before calling a receipt incomplete, compare the receipt's schema with its earlier instances (AD-2): full-9, full-10
  and real-9 had the same shape; the "manifest.json listed" note came from an object listing, not from the receipt.
- A test that spawns a waiting process must stop it on every path, and the process must end on its own when its world is
  gone (AB3-1, validator-8). `flock <file> bash -c 'until …'` forks: killing flock left bash looping with ppid 1, and the
  temp directory it waited on was deleted, so it never ended. Hold the lock on the process's own descriptor (one
  process), loop also on "my directory is gone", await each kill, and assert with pgrep that a failing case leaves none.
- A leg script's exit code is the leg's verdict; print-only gates are invisible (2026-10-16, freeze blocked). focused.sh
  echoed "patch rc=1", "crap rc=1" and a failed test, then exited 0, so three final-leg summaries said "focused rc=0" and
  I reported them green. Rule: every gate a leg runs feeds its exit; read the leg's own output, not only the summary line,
  before saying green. Also: a changed file needs its OWN tests in the coverage list (the ruling-B and budget files were
  covered by tests the list never ran), and web `*.server.test.ts` files run under vitest, not bun test.
- A locked artifact digest is only as stable as every input of the build (2026-10-16). The S3 adapter's artifact embeds
  the provided SDK bundle (sdk + extension-contract, src and dist) and the builder's NODE_ENV; my own extension-contract
  change moved it, and the lock's comment claimed it could not move.
- (team-lead's wording, 2026-10-16) A leg script that always exits 0 masks the leg; summaries must read the leg's own
  result, and every leg script gets a planted-failure check. Done here: legs/lib.sh (every leg's rc feeds the exit) and
  legs/legs.test.sh (one planted failure per leg, dry). Also: "one source, one artifact digest" needs the builder's
  environment kept out of the build (Bun inlines NODE_ENV/BUN_ENV by default); keep the source's runtime reads.
- Run a changed source's own canonical producer (2026-10-16). factory-transport is Node/V8-canonical: the merge refuses
  Bun records for it, so my Bun probe "covered" lines that the gate could never count, and the Node suite that owns
  the file was red (a test pinned the old 16 MiB ceiling my ruling-B change raised). Before choosing tests for a changed
  file, read scripts/coverage-config.ts for its canonical producer and run that producer.
- Run the repository's invariant tests, not only the guard set (2026-10-16, validator-8's hold at 6c0b99d37). The guard
  leg ran guard-suites.sh's 41 files, which exclude git-spawn-context-guard and guest-sdk-closure; a new script spawned
  git bare and a new module named the SDK source directory, and both invariants went red unseen. Every file in
  w00/invariant-tests.txt is now its own leg. And when a guard names an exception list, fix the code, not the list:
  one owner names the SDK directory (factorySdkSourceDirectory), the list stays untouched.
- A line-coverage gap in a test can be the instrument, not the test (2026-10-16, credential-store-bundled lines 21-22):
  count the calls before writing a cover-only call. The fake's list()/modify() were dead, and Bun's line map for the
  compact one-line read() put its hits on a closing brace. Fix: keep only what the product calls, one statement per
  line, and assert what it was asked for. Also: /tmp ages out after 10 days (systemd-tmpfiles); evidence is mirrored
  to /home/dev/work/EZCorp/factory-evidence-mirror/w4h-28 at each freeze.
- A file a test writes outside the repository is not source, and the merge must say so (2026-10-16, ci 38887660827).
  A bundle the credential-store test built in /tmp was instrumented and merged (76,700 lines at 11.2%) and dropped the
  hosted global floor to 75.91%; the local hold never saw it because no local leg ran the global floor over a full
  merge. Fix the funnel (merge-lcov), not one test. And test the obvious alternative before choosing it: Bun's
  coveragePathIgnorePatterns ("../**") matches paths relative to the folder at flush time and dropped all 529 real
  records of a test that left the process in /tmp.
