# validator-8: W4H-28 validation plan (prepare only; wait for the owner's R1 and team-lead's ruling)

Package: the reference.code.v1 run reaches a release. (1) the in-guest model adapter through the broker contract; (2) a
repository-read broker operation; (3) the toolchain claims lane on pinned validator images; (4) real published pins for
generateCandidate's configurationDigest and the reference S3 adapter. Proof: the full run on the composed application through
public HTTP to a LOCAL S3 release, test provider first, then ONE bounded real-model run on team-lead's GO.
Brief w00/briefs/w4h-28.md (sha d4f46b2429d0cba9). Base W4H-26 89716018f, rebased onto integ/w00 after the merges.

## Standing rules for every leg
Identity first (author and committer = the noreply address on every commit; the personal address 0 times in diff, log,
evidence). Snapshots outside the evidence folder, removed after. Heavy legs under gated-flock, the gate once inside. My own
PostgreSQL and my own private storage (own-storage.sh); no shared service touched. Verdict append-only, noreply-only.

## Legs
V1 Reproduction of today's stop on main or the base: the run stops at generate-private-candidate with
   factory_native_package_untrusted (W4H-26 final-5.json shows it; I reproduce it on my own stack with the test provider).
V2 Contracts before code: every new broker operation (model call, repository read) and the toolchain lane have their contract
   rows (C05 and the broker contract) in a commit before the code that implements them; the code matches the rows field by field.
V3 No credential in the guest (closest read):
   - the guest's container: env, mounts, materials and command line hold no provider token, GitHub token or credential path
     (podman inspect of the real guest containers in the proof; the guest's network is none, only the broker channel);
   - the adapter's request carries no model credential, only the operation and its bounded input;
   - a guest that tries the provider directly fails (no network) and a guest that names another model is refused
     (model_pin_mismatch); mutants on both checks go red;
   - secret sweep of all evidence (tokens, Bearer, JWT, keys, URL passwords, sk-, gh*_).
V4 Bounds and usage: one model call per attempt (a second call in one attempt is refused by name); the budget envelope refuses
   a call past the declared bound BEFORE the provider is called; usage in the journal operation = the provider receipt's =
   the task budget settlement = usage.json (field by field: input, output, total, cost). Mutants: bound check removed, second
   call allowed, usage not settled.
V5 Repository read: the guest never holds a token; the operation returns a pinned snapshot of the tested base (the run's
   repository and commit only; another repository or commit refused by name); the tree id recomputed with real git; the sealed
   snapshot digest recomputed (as my W4H-26 D7 replay).
V6 Toolchain lane: every validator image pinned by digest in the repo and covered by the deployment-locks check; the lane's
   containers (podman inspect) run the pinned digests, network none, read-only root; the five claims PASS on the valid fixture
   and each protected negative fixture FAILS its claim and blocks release (W10's pass line); mutants: one claim skipped, an
   unpinned image accepted.
V7 Real pins: generateCandidate's configurationDigest equals the digest I recompute from the installation's modelProvider
   configuration (canonical JSON); the S3 adapter digest equals the digest I recompute from the published package bytes, and
   the package is installable through the product path; fleet-init no longer prints factory_release_adapter_unpublished and
   declares the generateCandidate profile (tokens 50,000, the gpt-6-luna pin) and the default S3 release profile; the
   startup document parses. Mutant: a placeholder digest back -> refused by name again.
V8 The test-provider proof, replayed and reproduced on MY OWN stack: every node's status, candidate generations, claim verdicts,
   the accepted complete tree and the release receipt; the LOCAL S3 release read back from my own storage (manifest and object
   digests = the accepted tree's blobs; the manifest digest = the receipt); the GitHub draft-PR refusal recorded verbatim.
V9 The ONE real-model run (owner's, on team-lead's GO; I do not call the model): exactly one bounded run; model id gpt-6-luna
   only; credentialKind oauth; usage within the bound and equal to the product's accounting; the child bytes' shas recomputed
   and present in the accepted tree; the release read back; no secret in any record.
V10 Red-first for each of 1-4 by assertion (load errors do not count; mutants cover them), mutants per leg above, gate-integrity
   main = exactly 0 (any finding = STOP), lint, boundaries, the hook-mapped suites with lcov, 100 percent of changed lines (my
   changed-lines tool), CRAP, the guard set, typecheck by the tc rule.

## Verdict
ACCEPT only when V1-V10 hold. A credential reachable from the guest, a bound that is not enforced before the provider call,
a usage mismatch, an unpinned image, or a placeholder pin = REJECT with the finding.

## Addendum A (2026-10-14): team-lead's R1 rulings; owner design r1/design.txt (2efaab8aeb6f8854)

Commit order to check (V2): P4 pins, P0 material read, P1 model adapter, P3 toolchain lane, P2 repository read; each part's
contract row (C05 guest broker; C10 pin; C04 adapters and live reads) in a commit before that part's code.
P0 material read (new, ruled in scope): frame factory.guest-material-read.v1 {artifactId, digest, page}; the scope comes from the
   VERIFIED attempt token (tenant, project, run); only candidate_output and material kinds of the same run; total <= 512 KiB;
   refusals material_not_found (other run, unknown id), digest_mismatch, oversize, invalid_request. Checks: a read of another
   run's material refused by name (real composed run: a second run's material id asked from the first run's guest); the SDK
   client verifies sha256 of the assembled pages. Mutants: the run scope check dropped; the digest check dropped; the size
   bound dropped.
P1 model adapter (V3, V4): callFactoryGuestModel moved from graph-guest.ts into the SDK (one copy: graph-guest.ts must import
   it; grep for a second implementation). Budget: budget_exceeded when maxOutputTokens + ceil(inputBytes/4) > maxTokens minus
   the attempt's measured journaled tokens, refused BEFORE the claim and before any journal row (no operation row, no provider
   call: checked on the route with a counting provider). One call for generate and one for review: a second call in one
   attempt refused by name. Mutants: the budget check after the claim; the bound ignored; a second call allowed.
   Usage: the journal operation's measured usage = the provider receipt = the task budget settlement = usage.json.
P2 repository read: frame factory.guest-repository-read.v1 {operationId, operationIndex, source, commitSha}; startup
   repositories.sources by name; the token only through a file and git http.extraHeader (never in argv or env: I check the
   host process listing and the git invocation in the test, and the evidence sweep); refusals repository_source_unknown,
   repository_commit_unknown, repository_too_large. The recorded tree is a sealed material; I recompute its tree id with git.
P3 toolchain lane: podman-guest validator runtimes; environmentDigest = docker.io/oven/bun@sha256:9114c058... (no new image);
   the validator package's own locked dependency set (exact versions and sha512) mounted read-only; `bun <script>` only, /tmp
   noexec (the podman integration test must exercise the noexec path, and a mutant that execs a shim must fail there).
   Claims: the base FAILS declared-tests, the slugify candidate PASSES all nine; an unlocked package fails frozen-install by
   name. How the locked set is fetched at package build (network, registry pin) gets a close read against W02.
P4 pins: the model configurationDigest = digest(referenceModelConfiguration) recomputed by me; referenceCodeModelPin carries
   computed digests (no literals); the S3 adapter @ezcorp/s3-immutable-publish rebuilt by me from committed source gives the
   pinned digest (reproducible); fleet-init declares the generate profile (tokens 50,000, gpt-6-luna) and the default S3
   release profile; the startup document parses; protectedChecks names no model (Q4); a placeholder digest back is refused.
Proof (V8): run 1 = reference.code with the S3 release as a DECLARED definition parameter (Q1); 10 claims PASS; the approval
   through public HTTP; the release read back. Run 2 = reference.code.v1 (GitHub PR): refused at release; the refusal recorded
   verbatim. Q2: the owner publishes under its own tenant prefix on the shared S3 services and lists every object written; I
   check that list against the stores read-only (list and head only, no write; credentials never printed) and that no other
   prefix changed (a before/after listing of the other prefixes the owner's tenant credential can see; I record what my
   read access can and cannot cover). My own reproduction of run 1 uses MY private storage, not the shared one.
Leg B (V9) as planned: one bounded real run on team-lead's GO; I make no model call.

## Addendum B (2026-10-14): team-lead's ruling on the preparation reply (A) and the freeze ports
Preparation reply (H3 from W4H-26 changes):
- The W4H-26 C05 row "Prepare a bound package for dispatch" is amended in a commit BEFORE the code: the supervisor answers
  artifactDigest, manifest and evidence only (no artifact bytes).
- The product reads ITS OWN stored release artifact by the binding's digest, recomputes the digest, and compares it with both
  the binding's digest and the supervisor's answered digest; a mismatch on either is refused by name. Mutants: the comparison
  with the binding dropped; the comparison with the supervisor's answer dropped; each must make a named test red.
- The 4 MiB host response bound (supervisor-services.ts:57) is unchanged (diff check) and the reply now fits under it: I
  measure the reply size for the ~30 MB validator package in the proof (the supervisor log or a captured response length).
- Carried W4H-26 checks I re-run on this path: the supervisor still recomputes the source digest before building; the build
  identity and the durable-record behaviour (T1, N6, N7) unchanged except for the reply shape (the H4 restart tool reruns).
Freeze node two ports: `candidate` (for the release) and `frozen` (the sealed record for validators). Checks: each port's value
  and digest in the proof record; the release profile resolves through `candidate`; the validators read `frozen`; a mutant
  that drops one port makes its consumer's test red.
Base: the owner's branch rebased onto 486e6a558 (head so far edaf7a81c); the W4H-29 list fix lands separately, so the
  guest-sdk-closure inventory test is expected red until it is merged; I run it in every hold anyway (lesson from PR 341).

## Addendum C (2026-10-14): ruling (A) WITHDRAWN, ruling (B) applies — supersedes Addendum B's "Preparation reply" part
(the freeze-ports part of Addendum B stays)
The product holds no artifact bytes (package-preparation.ts:235-238), so the supervisor's reply keeps carrying the artifact files
and verifyArtifacts stays. Ruling (B), narrow:
- One named constant raises the PREPARATION reply bound to 64 MiB with its reason; it applies to that route only (the host
  service's body bound as used for /v1/host/preparations, and the client's PREPARED_LIMIT_BYTES). Check: every other host route
  still answers under 4 MiB (diff of supervisor-services.ts and of each route's bound; a test that a non-preparation route
  above 4 MiB is still refused) — a global raise is a finding.
- The memory bound is stated where the constant is (one reply held in memory at most 64 MiB, per preparation, with the
  preparation concurrency that bounds the total).
- Tests: a >4 MiB artifact set prepares and verifies (red on the 4 MiB code); a reply above 64 MiB is refused by name on the
  host side and on the client side.
- Unchanged and re-checked: the digest recompute and both comparisons (client: files digest = the named artifact; product:
  build digests = the binding's, verifyArtifacts = the binding's artifact). My W4H-26 D6 mutants re-run and must die:
  client artifact digest dropped; product binding artifact dropped; supervisor source digest dropped; peer tenant check dropped.
- Mutants for the raise: the constant applied globally (a non-preparation route accepts >4 MiB) -> red; the 64 MiB check
  removed on either side -> red.
- In the proof: the measured reply size for the validator package, under 64 MiB.
Leftover noted: a product-readable content-addressed artifact store would remove the transfer.

## Addendum D (2026-10-14): the budget defect (per-node maxCostMicros) and the GO for one real run
- Defect: reference task nodes declared no resources, so each node held the full run cap (1,000,000 cost micros); a real
  model's cost made freeze inadmissible (budgets.ts:441); the test provider's zero cost (registry.ts:69) hid it.
- Fix check: the definition declares per-node maxCostMicros (generate 250,000; every other task node 50,000); red-first by
  assertion (a node without its own bound holds the run cap); the sum of the node bounds stays within the run cap; a mutant
  that drops generate's bound (or sets it to the run cap) makes the test red. A test with a NON-zero provider cost (not the
  zero-cost test provider) shows freeze admissible after a generate that spends its share.
- The definition digest changes with the bounds: the pinned configurationDigest and the S3 adapter pin are re-checked, and
  the startup profile still parses.
- V8 adds: the test-provider proof full-9.json (755cb865be6a4d5b) replayed; the written-object inventory
  objects-written.json (45bf7e91ec828ccd; 692 versions in bucket tenant-01 under ordinary/ and archive/) checked read-only
  against the stores (list and head; no write); the S3 release candidate.json and manifest.json digests recomputed from the
  objects; the manifest digest = the receipt's effectDigest; run 2's refusal recorded verbatim.
- V9 (the ONE real run, team-lead's GO after the fix and a provider-configured readiness check): usage equal across the
  journal, the provider receipt, the settlement and usage.json; within the per-node bound and the run cap; no credential in
  any evidence file.

## Addendum E (2026-10-14T23:50Z, validator-8 respawn): everything the owner added after Addendum D
Read for this addendum (read only): the owner's branch at 4b9a00113 (5d44d2aaa, d0a862546, 61deb0323, 4b9a00113 on top of
1d5a1cd90), proof/full.ts, real.sh, run-pending-watch.sh, import-codex-login.sh, journey.md, the coordinator log to 23:35Z.
The branch is NOT yet rebased onto the W4H-31 result (9cc6fed78). The diagnostics change for the import is not committed yet.
Interpretation: "P0-P4 of the real run" = each of the five parts must be visible in the single real run's records (E1).
Placement key: [L] = lock-free (unit legs, greps, reads, list/head); [H] = in the heavy lock through gated-flock.sh with
GATED_FLOCK_YIELD_FILE = the current proof/real-N.run-pending. I never hold the lock while I wait for a person.

E0 Freeze inputs. The frozen head, its parent chain from 1d5a1cd90, identity (author and committer noreply on every commit,
   personal address 0 times in diff, log, evidence), the owner's gate file and report. Re-validation rule: compare trees
   pairwise with my earlier legs; only the delta gets new legs. [L]

E1 P0-P4 in the ONE real run (extends V9). From the real-N.json and the product records of the single gpt-6-luna run:
   - P0 material read: the guest material-read frames name only the run's own artifacts; each page digest recomputed. 
   - P1 model adapter: exactly one model operation per attempt for generate and for review; model id gpt-6-luna only in the
     provider receipts; credentialKind oauth; budget refusals none (or by name, before the claim).
   - P2 repository read: the snapshot's tree id recomputed with real git; source and commit = the run's.
   - P3 toolchain lane: the claim verdicts and the pinned image digests of the lane containers (from the record; podman
     inspect only if the containers still exist and are the run's).
   - P4 pins: configurationDigest and the S3 adapter digest in the run = my recomputed values (Addendum D re-check).
   Cases by name: one run id only; generate usage <= 250,000 cost micros and <= 50,000 tokens; freeze admissible.
   [L] (records); a rerun of any part = [H] and only on my own stack with the TEST provider, never the real model.

E2 Web binding (5d44d2aaa: stack-documents.ts webBinding + webBindingRequest, stack.ts, 5 tests). [L]
   - Cases: no PROOF_WEB_* -> host 127.0.0.1, a free port, origin http://127.0.0.1:<port> (every earlier proof unchanged);
     host <ANY-ADDR> -> the proof's own calls use 127.0.0.1; a non-IPv4 host refused; port 0, 65536, non-integer refused;
     an origin with a path, https, or a trailing slash refused; the record's webBinding holds host, port, origin only.
   - grep: stack.ts has no remaining literal 127.0.0.1 on the web call path (session(port, host)).
   - Mutants: isIP check dropped; apiHost wildcard mapping dropped; origin check dropped; port range check dropped. Each must
     make a named test red; a survivor = a finding (test gap).

E3 OAuth bundle defect (d0a862546: registerBunOAuthFlows() at load in src/providers/credential-store.ts; red-first
   src/__tests__/credential-store-bundled.test.ts with fixtures/bundled-oauth-entry.ts).
   - Red-first: the test file at d0a862546^ fails by assertion ("Cannot find module './openai-codex.js'" or the key
     check), not by a load error of the test itself. I re-run it, I do not only read red/oauth-bundle-red.log. [L]
   - Gap check: the test bundles with Bun.build (target bun, no splitting); the web server is built by the web build with
     chunks. Binding leg: build the web server at head and derive a key from a FIXTURE oauth credential through the built
     chunk with its lazy initializer run (the owner's corrected check, oauth-check-2.log); same check with the call removed
     must fail with the module error. [H] (web build)
   - Idempotence: a second call (module loaded twice, test isolation) raises nothing; read the pi-ai function. [L]
   - Mutant: the registerBunOAuthFlows() line removed -> the bundle test red. [L]

E4 Readiness code and typed error, test isolation, persistent deployment (61deb0323; C10 amendment).
   - Cases by name: a stored OAuth login whose key derivation fails -> failures [provider_credential_unusable] with
     credentialFailure {errorClass, code?}; nothing stored -> provider_not_configured unchanged; an API key -> ready.
   - No message: a fixture cause message carrying a marker string must not appear in the readiness document, the
     FactoryProviderReadinessError fields copied to records, the /api/ready body, or any log line. Note:
     ProviderCredentialUnusableError's own message still quotes the cause message; I check every place it can be logged. [L]
   - Masking check (possible finding): resolveCredentialForPin now calls getCredential and maps EVERY other thrown error to
     credential null (provider_not_configured). I list what getCredential can throw (database, decrypt, store errors) and test
     one database failure: if it reads "not configured", that is the same masking class as real-4 and I report it. [L]
   - Mutants: unusableCredential always undefined; the cause message copied into credentialFailure; the isBrokenOAuth branch
     dropped (a survivor = a coverage finding). [L]
   - C10 amendment: the row text matches the code (code names, fields, "never its message"). The amendment is in the same
     commit as the code; Addendum A asked contract rows BEFORE code; I report the ordering and apply team-lead's ruling. [L]
   - Isolation: credentials.test.ts then factory-broker.test.ts in ONE bun process, both orders, pass; with the afterAll
     restore removed (mutant) the order credentials-first is red. Inventory: git grep for other test files that set
     OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY / OPENROUTER_API_KEY without a restore (listed, not fixed). [L]
   - Persistent deployment (PROOF_KEEP_PRODUCT=1, real.sh only): directory 0700 and files 0600 (metadata only, ls -l; I do not
     read the file values); only named files present; a test-provider pass never uses it (grep PROOF_DEPLOYMENT_DIR in
     full.sh/run.sh); a directory outside the allowed places refused deployment_dir_not_allowed (deployment.test.ts; mutant:
     guard dropped -> red); reuse = login, not setup; cleanup drops DB and directory ONLY after the single run succeeds;
     a failed pass keeps them. Note: the directory is tmpfs (lost at reboot) and is a stated limit. [L]

E5 Codex-login import (4b9a00113: src/providers/codex-login-import.ts, scripts/import-codex-login.ts,
   proof/import-codex-login.sh; tests 6/6 with fixture JWTs) and the pending diagnostics change.
   - Mapping cases (fixture JWTs only): access, refresh, accountId from the claim https://api.openai.com/auth
     chatgpt_account_id, fallback tokens.account_id; expires = exp * 1000; refusals by code; no refusal quotes a token;
     a missing file stores nothing; the summary = provider, masked account (last four), expiry. [L]
   - Same client: the client id of pi-ai's openai-codex flow = web/src/lib/server/oauth-config.ts (by name, not value
     copied into evidence). The stored row = what the browser sign-in writes (tagOAuthCredential; same fields). [L]
   - Mutants: claim path wrong; exp not scaled; mask returns the full id; a refusal carrying the token; modify() called before
     validation. Each must make a named test red. coverage-thresholds.json entry at 100 percent holds. [L]
   - CLI: no --from -> exit 64; argv holds only the path; stdout only the summary; stderr only a code and a class. [L]
   - Wrapper (read only, never run by me against real-5 with a real file): secrets reach the CLI only by environment;
     POSTGRES_PASSWORD unset after use; the web secret and salt pass through `eval` inside double quotes: I check the
     generator's alphabet. If a value can hold $, backtick or backslash, bash expands it, the secret is wrong, and decrypt
     fails: a possible cause of the user's codex_login_import_failed; I report it as a finding if so. [L]
   - Pending diagnostics (named cause codes shape/jwt/claim/db/secret/store, key NAMES only; --dry-run): one test per code
     that forces it (bad shape, bad JWT, missing claim, database unreachable, wrong secret, store failure); a database or
     decrypt message with a marker string never reaches stdout or stderr; --dry-run writes nothing (row count and updated_at
     of the openai-codex row unchanged; mutant: dry-run writes -> red) and still verifies the secret and the connection.
     The owner's dry-run check against real-5's deployment used a FIXTURE file in dry-run only: I check that real-5's
     credential row metadata (provider id, updated_at; never the value) did not change at that time. [L]

E6 Run-pending marker (harness; full.ts RUN_PENDING, real.sh EXIT trap, run-pending-watch.sh for real-5).
   - Cases on a copy with fake files (never the real marker): written when the provider reads connected (poll or boot on a
     reused deployment) and before the restart; removed first by finish() on success, on failure, on harness error; removed by
     the EXIT trap on SIGTERM/SIGINT of the wrapper; the watcher's 3 cases re-run. [L]
   - Stale marker (possible finding): after SIGKILL or a host reboot the marker stays; gated-flock.sh yields while the file
     exists and yield time is off the MAX_S clock, so every yielding heavy job waits for ever. I test this on a copy of
     gated-flock.sh with a temporary lock path and a temporary marker (never the real lock). Expected remedy (for the owner and
     integrator, not me): the marker holds the pass's pid and the yield ignores a dead pid.
   - Label check: the W4H-31 chain yields to real-5.run-pending; if the owner starts real-6, the chain's yield file must name
     real-6 (or a label-free path). A mismatch = a finding reported to team-lead at once. [L]

E7 The single bounded gpt-6-luna run evidence (extends V9 and Addendum D). [L] unless stated.
   - One run only: across real-1..real-N, exactly one model call series belongs to one run id; real-1..real-4 show no model
     call; count provider requests in the web and orchestrator logs.
   - proof/real-N.json: node statuses, claim verdicts, the accepted tree, the release receipt; usage equal field by field
     (input, output, total, cost) across the journal operation, the provider receipt, the task settlement and usage.json;
     within the per-node bound and the run cap.
   - objects-written.json (now 671452b6f24ada25, 818 versions): refreshed after the run; every new object under the owner's
     tenant prefix; list and head only on the stores (no write); other prefixes unchanged (before/after listing; what my read
     access cannot cover is stated). candidate.json and manifest.json digests recomputed from the objects; manifest digest =
     the receipt's effectDigest; the child bytes' shas recomputed and present in the accepted tree.
   - Cleanup after success: the persistent deployment directory and its database dropped; no stack process left.

E8 processSpawn rebase onto the W4H-31 result (9cc6fed78 or the integ head that contains it).
   - Every runner.start caller W4H-28 adds (toolchain-lane validator runtimes, the supervisor build operation, any guest
     start in P0/P2) passes processSpawn; git grep of start call sites vs processSpawn at the frozen head; no new call site
     without it. Mutant: processSpawn dropped from the lane start -> the #339 spawn guard denies (no-policy = deny,
     podman.ts:735-736) and the lane test goes red. [H] (podman suites)
   - Conflicts in host-launch-*, supervisor-process.ts, supervisor-services.ts: resolution-lines.py (lines that differ from
     both parents) must be covered; both behaviours kept (the 64 MiB preparation bound AND processSpawn). [L]
   - gate-integrity: main leg exactly 0; a base leg across a sync merge judged with sync-base-leg.py (W-SYNC rule). [L]
   - The W4H-31 suites re-run on the rebased head: extension-runner, #339 guards, the W4H-26 suites, Podman supervisor
     suites. [H]

E9 Security checks (binding; any hit outside a fixture = REJECT). [L]
   - JWT-like strings (eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.), Bearer, sk-, gh*_ tokens, "refresh"/"access" keys with
     long values, URL passwords: swept over the branch diff, w4h-28/ evidence (logs, proof records, receipts), my own files,
     and the coordinator log. Every hit must sit in a fixture (codex-login-import.test.ts, credential-store-bundled.test.ts)
     and decode to fixture claims.
   - Account ids: every value under accountId / account_id / chatgpt_account_id in the evidence is a fixture value or the
     masked form (…XXXX). I do not know the user's real id and I do not read it; a non-fixture unmasked value = REJECT.
   - ~/.codex/auth.json: no one reads it. I check the owner's journey.md, logs/ and its command records for any command that
     opens, stats, copies or prints it; text mentions and the user's own `!` command are allowed. I do not stat or read it.
   - Import tool: never prints a value (E5 cases); the persistent deployment files are checked by metadata only.
   - Non-noreply addresses: 0 in diff, log, evidence; any hit is written as "<a non-noreply address>".

E10 Heavy-lock list (all through gated-flock.sh, yield file = the current proof/real-N.run-pending, gate checked inside):
   E3 web build + built-server OAuth check; E8 podman suites + lane mutant + W4H-31 suites; the V8 own-stack test-provider
   reproduction (if the delta touches the proof path); typecheck in the lock if the host stays under 16 GiB lock-free.
   Floors: disk >= 104 G, swap >= 2.5 GiB, mem >= 6 GiB; in-lock 12 GiB. Everything else is lock-free.

E11 Verdict additions. REJECT on: any token or real account id outside fixtures; a read of ~/.codex/auth.json by anyone on the
   team; the bundle fix not effective on the real web build; a cause message in readiness or logs; dry-run that writes; a
   real run count other than one; a usage mismatch; a W4H-28 start site without processSpawn. FINDING (report, team-lead
   rules): a database error read as provider_not_configured; the stale-marker wait; the yield-file label mismatch; the eval
   quoting of the web secret; the contract amendment in the same commit as the code.

## Addendum F (2026-10-14, validator-8): team-lead's rulings on Addendum E's five items (Addendum E accepted, 5c3177b79e079d61)
F1 Marker (settles E6 stale marker and the label mismatch). One path for every pass:
   evidence/w4h-28/proof/real-run.pending, content "<pid> <label>". w4h-28 writes it; integrator-5
   changes gated-flock.sh, red first. My checks (copies only, temporary lock path and marker, never the real ones) [L]:
   - gated-flock yields while the marker names a LIVE pid; it ignores the marker when the pid is dead (no wait); a marker
     with a missing or malformed pid: the behaviour is stated in the test and is not an endless wait;
   - red first: the new dead-pid case fails on the 0671031ee4e95c2b wrapper; the earlier gated-flock.test.sh cases still pass;
   - pid reuse: a live pid of an unrelated process makes the job yield only. That is the safe side, stated as a limit;
   - the harness writes the pass's own pid (the full.ts process or the real.sh wrapper, the one that lives to the run's
     end) and the label; finish() and the EXIT trap remove the file only if it still names their own pid (a later pass's
     marker is not removed by an earlier pass's trap); mutant: removal without the pid check -> a named case red;
   - the W4H-31 chain and every later heavy job set GATED_FLOCK_YIELD_FILE to this path; my own heavy legs use it too.
F2 Import secrets (replaces E5's wrapper check). The CLI takes --deployment <dir> and reads the deployment's secret files
   by path; the wrapper has no eval; no secret in env or argv. Checks [L]:
   - grep the wrapper and the CLI: no eval, no export of a secret, no secret in an argv; the database URL is built inside
     the CLI from files (the PostgreSQL password included: from its file, not env);
   - the process listing during a fixture run (throwaway DB) shows only paths in argv; /proc/<pid>/environ holds no secret
     value (checked against the throwaway fixture secret, a marker value);
   - a secret value with $, backtick, backslash and a quote round-trips (fixture test), proving no shell expansion;
   - refusals by code for a missing deployment dir, a missing or unreadable secret file, a bad JSON shape.
F3 Readiness errors (extends E4's masking check; binding). An unexpected error in the credential resolution gives
   provider_readiness_error {errorClass, code?}, never provider_not_configured, in the readiness document AND in the
   broker's call-time check. Checks [L]:
   - cases: a database failure, a decrypt failure and a generic Error each -> provider_readiness_error with class (and code
     if present); nothing stored -> provider_not_configured; an unusable stored login -> provider_credential_unusable;
   - no message: a marker string in the thrown message is absent from the document, records and logs (as E4);
   - the call-time check refuses the model call by the same code before any provider request (counting provider);
   - mutants: the fallback back to credential null (provider_not_configured) -> red at readiness and red at call time,
     each by its own named test; the code renamed -> red;
   - the contract row for provider_readiness_error is in a commit BEFORE its code (rows before code from now on).
F4 Contract order. The same-commit C10 amendment in 61deb0323 is accepted with a disclosure line in the owner's report; I
   check the line is present. Every later addition: row commit before code commit (git log order). [L]

## Addendum G (2026-10-15, validator-8): shared-script baseline for the W4H-28 and W4H-31 checks
Hashes (sha256, first 16 hex), checked by me:
- w00/gated-flock.sh 00974a4959ad0e68 (live-pid yield); w00/gated-flock.test.sh ce4710de1c554a98: 33/0 on a copy; old wrapper
  0671031ee4e95c2b 26/7 (red first); my mutants killed (kill -0 removed: 7 fail; non-numeric check removed: 6 fail).
  Evidence validator-8/f1-check/run.log.
- w00/bash-line-cover.py 95d64f916f596f97 = byte-identical to validator-8/bash-line-cover.py (cmp); mode 600.
- w00/w4h-merge/w4h-31-sync-main-934531e2e/launch.sh a5db080c17147eda (yield file proof/real-run.pending).
Open (reported to team-lead): the owner's writers still write <label>.run-pending with a timestamp; a non-numeric or empty
marker waits without limit (validator-8/f1-check/malformed-probe.log). Each hold I check: the wrapper hash equals the latest
hash team-lead forwards; the host-fault change (gate waits while the user manager is down or within 5 min of a global OOM
kill; HOST-FAULT line and file; exit unchanged; no auto-requeue) is recorded by hash when forwarded, and I re-run
gated-flock.test.sh on a copy of each new version before I use it.

## Addendum H (2026-10-15, validator-8): team-lead's rulings on the two marker gaps
H1 Writers (w4h-28): full.ts, real.sh and the live watcher write proof/real-run.pending as "<pid> <label>" through a temp
   file + mv, and remove it only when it names their own pid; a format test. My checks [L], on copies with fake files:
   - git grep / grep: no writer of <label>.run-pending is left; the pid written is the process that lives to the run's end;
   - the temp file is in the same directory (mv is atomic only on one file system);
   - an earlier pass's exit does not remove a later pass's marker (mutant: remove without the pid check -> red);
   - the format test is red against the old timestamp writer.
   Until w4h-28's confirmation, I treat the chain as not yielding and start no heavy leg of my own.
H2 Wrapper (integrator-5, ruling (a)): an empty or non-numeric marker is stale (logged, ignored). My checks on a copy [L]:
   - red first: the new malformed-leftover cases fail on 00974a4959ad0e68;
   - my malformed-probe (empty file; ISO-timestamp file; MAX_S=5; outer timeout 15 s) now runs the command once, rc 0,
     with a "stale" log line and no "present" line;
   - the live-pid cases 9-10 still pass; mutant "non-numeric = present" back -> red;
   - the host-fault change in the same install: the gate waits while the user manager is down or within 5 min of a global
     OOM kill, writes the HOST-FAULT line and file, keeps the exit code, and does not requeue by itself. I check each
     part with stubs only (no real host read altered), and record the new hashes of gated-flock.sh, resource-gate.sh and the test.

## Addendum I (2026-10-15, validator-8): host-fault install checked (integrator-5; backups *.bak-20261014T2359Z-hostfault-c)
Hashes checked by me; tests run on copies (evidence validator-8/f1-check/hostfault-run.log):
- w00/resource-gate.sh 01c16040f62d6017; resource-gate.test.sh 9ea5b73bde26d173: 21/0 on the copy; old library
  530b792cc01e4ed4 10/11 (red first). Quiet window default and floor 300 s (resource-gate.sh:57-58).
- w00/gated-flock.sh ec2d7209a68d42c4; gated-flock.test.sh 939c12754d85669e: 46/0 on the copy; old wrapper 00974a4959ad0e68
  41/5 (red first). HOST-FAULT line and <exit file>.host-fault; older file moved to .prev-<time>; exit stands; no automatic
  requeue (re-launch by hand only, gated-flock.sh:25,57).
- OPEN: ruling (a) on gap 2 is NOT in this install. yield_active still returns "yield" for an empty or non-numeric marker,
  and case 11 still asserts that. My malformed probe on ec2d7209a68d42c4: empty and ISO-timestamp markers, rc 124, the command
  never ran, 15 yields each. My H2 checks run again when the (a) change arrives.

## Addendum J (2026-10-15, validator-8): the memcg rule of the host-fault gate, checked on the real kernel log
resource-gate.sh:41,45 counts only kernel lines with "global_oom". Read-only check of the last 24 h of the kernel journal:
19 oom-kill lines with CONSTRAINT_MEMCG, 437 with CONSTRAINT_NONE; 0 memcg lines carry global_oom and 0 CONSTRAINT_NONE
lines lack it. So a container's own memcg OOM does not hold the gate, and every global OOM does. Note for my heavy legs:
437 global OOM kills in 24 h; each holds the gate for at least 300 s.

## Addendum K (2026-10-15, validator-8): ruling (a) install checked (backups *.bak-20261015T0002Z-malformed)
On copies (evidence validator-8/f1-check/malformed-run.log):
- w00/gated-flock.sh 62dd303ed574f4c7; gated-flock.test.sh 153951080bf4f4b5: 50/0. Old wrapper ec2d7209a68d42c4: 42/8 (red
  first). My mutant (empty or non-numeric = yield again) b160034fa0d5cd11: 41/9 (killed). resource-gate.sh 01c16040f62d6017
  and its test 9ea5b73bde26d173 unchanged.
- My H2 probe: empty and ISO-timestamp markers now run the command once, rc 0, "malformed marker ... ignored" logged once
  outside and once inside the lock, no "present" line. H2 holds.
- Probe artifact (not a wrapper defect): my stub gate library defines only resource_gate; the wrapper also calls host_mark,
  so the stub printed "host_mark: command not found". The real library defines it.
- Minor finding: a marker "0 <label>" yields for ever (rc 124, 15 yields): `kill -0 0` signals the caller's own process
  group and always succeeds. The writer writes its own pid, so the risk is low; a pid pattern [1-9][0-9]* would close it.

## Addendum L (2026-10-15, validator-8): pid-0 fix checked (backups *.bak-20261015T0008Z-pid0)
On copies (evidence validator-8/f1-check/pid0-run.log): w00/gated-flock.sh 4778de25f63ec38a, gated-flock.test.sh
a7095b95505b4955: 58/0; the previous 62dd303ed574f4c7: 50/8 (red first). The diff is one code line (pid must match
^[1-9][0-9]*$) and one comment line. Probe: "0 real-6" now runs the command once, rc 0, logged malformed twice (outside and
inside the lock), no yield. A marker with a live pid still yields (rc 124 under a 6 s timeout, 6 yields). The probe stub now
defines host_mark, host_fault_since and host_unsettled. resource-gate.sh 01c16040f62d6017 and its test 9ea5b73bde26d173
unchanged. The wrapper side of F1/H2 is closed; H1 (the owner's writers) is still open.

## Addendum M (2026-10-15, validator-8): owner report b97b0c894 (import diagnostics) and open items
Facts (owner via team-lead; checked by me: identity noreply on b97b0c894; 3 files: scripts/import-codex-login.ts,
src/providers/codex-login-import.ts, its test; wrapper proof/import-codex-login.sh 1fff4e9cdce5a479 still has 1 eval):
real-5 ended 00:09:19Z by deadline; real-6 UP 00:10:36Z-04:10:36Z on the same deployment. H1 (writers) and F2 (--deployment,
no eval) are NOT done; team-lead sequenced the integration behind the real run instead of the marker for this run.
Checks for b97b0c894 at the freeze [L] (they replace E5's "pending diagnostics" item):
- One test per code that forces it: codex_login_unreadable; shape_unexpected {keys, tokenKeys}; access_token_not_jwt
  {segments}; jwt_claim_missing {claim, fallback}; web_secret_missing {env}; web_secret_mismatch {env};
  database_unreachable {address, database, errorClass, errorCode}; credential_store_write_failed; codex_login_import_failed
  {errorClass, errorCode}. Each detail holds NAMES or counts only: a fixture with marker values in every token field, the
  secret and the database password must leave no marker in stdout or stderr (mutants: a value copied into keys, into
  tokenKeys, into a message -> red).
- DATABASE_URL unset -> refused by code, no PGlite fallback (mutant: the fallback back -> red).
- web_secret_mismatch: how it is decided (the secretCheck round-trip) and that the check reads no credential value into
  output; --dry-run writes nothing (row count and updated_at of provider oauth rows unchanged; mutant: dry-run writes -> red).
- 23/23 tests and 100 percent lines and functions re-run by me; red-first evidence for the new codes.
- The owner's claims "the user's failed attempt wrote nothing" and "0 rows before/after the dry runs": I check the
  provider row COUNT and timestamps only (never a value) in the deployment database at the freeze.
Disclosure (23:47Z): the owner put the proof PostgreSQL admin password once in `podman exec -e NAME=value` argv. Checks [L]:
- a count-only search for that value over w4h-28/ evidence, w00/ and my files: the value is read into a variable from
  postgres.env and never printed; the result is file names and counts only; any hit outside postgres.env = a finding;
- the argv was visible in the host process list for the length of that exec; other sessions' transcripts are outside my
  reach and I state that limit. Rotating that local proof password is team-lead's decision; I report, I do not rotate.
Still open for the freeze: H1 writers; F2 (--deployment, no eval); F3 provider_readiness_error.

## Addendum N (2026-10-15, validator-8): ruling on the proof PostgreSQL admin password; baseline search done
Ruling (team-lead): rotate after the single real run completes and before the persistent deployment is dropped, by the
owner, in the same cleanup step (ALTER ROLE + postgres.env rewrite, value never printed), recorded. Not now: real-6 holds it.
Baseline search (00:2xZ 2026-10-15, before rotation): the value of POSTGRES_PASSWORD from postgres.env, held in a shell
variable, never printed; grep -rlF over w4h-28/, w00/ and validator-8/ with postgres.env excluded: 0 files. Assumption:
postgres.env's POSTGRES_PASSWORD is the admin password the owner passed at 23:47Z (the import wrapper uses that variable).
Reason for running it now: after the rewrite the old value no longer exists on disk, so a later search for it is not
possible. At the cleanup I run the same search once more just BEFORE the rotation (the owner tells me when), then after
the rotation I check that postgres.env holds a different value (comparison of sha256 of the two values in memory, no print)
and that the role still logs in with the new value (a read-only connection check).
Correction to Addendum N (same day): my shell state does not persist between steps, so an in-memory comparison of the old
and new values is not possible, and I will not write any hash of the value to a file. Replacement: the pre-rotation search
and the rotation check run in ONE command after the owner rotates: before that command the owner keeps the old file as
postgres.env.old-<time> (0600) for that command only; the command searches the old value (count only), checks old != new
and a read-only login with the new value, then the owner deletes postgres.env.old-<time> by name. The search runs with
postgres.env and postgres.env.old-* excluded.

## Addendum O (2026-10-15T00:16Z, validator-8): H1 writer switch checked on copies (evidence validator-8/h1-check/run.log)
Hashes: proof/run-marker.sh 38a81207ca4234ea; full.ts 76151b7a0b39ea83; real.sh 3b1594d1986a313e; run-pending-watch.sh
40b143642f9f74b0; run-marker.test.sh cba88d30d286d5c8.
- Code: write = "<pid> <label>\n" into a mktemp file in the marker's own directory, then mv -fT (atomic on one file
  system); pid must match ^[1-9][0-9]*$ and label ^[A-Za-z0-9._-]+$, else exit 64; remove = only when the first field equals
  the given pid; a malformed marker is cleared by any remover. full.ts writes PROOF_WRAPPER_PID (real.sh exports $$) at boot
  when ready and at the connect, and removes it in finish(); real.sh's EXIT trap removes by $$. No writer of
  <label>.run-pending is left in full.ts or real.sh; the watcher only READS real-6.run-pending and writes the single marker.
- Tests on my copies: head 18/0. Mutants: removal without the pid check 16/2; old timestamp format 13/5; a malformed
  marker not cleared 15/3. All three are killed.
- Live state at 00:16Z (read only): proof/real-run.pending absent and no real-6.run-pending (the user has not connected
  yet); real.sh real-6 pid <PID> started 00:10:10Z; watcher pid <PID> started 00:13:18Z, acting for <PID>.
- Limit (stated, not a finding): remove reads the owner and then removes the file in two steps; a new marker placed between
  them could be removed. Only one real pass runs at a time, so this cannot happen in practice.
- Two writers for real-6 only: the watcher writes and removes under the wrapper pid <PID>; real.sh's EXIT trap removes
  under the same pid, so the two cannot remove each other's marker. From real-7 on, full.ts writes the marker itself.
H1 is closed. Open: F2 (--deployment, no eval), F3 (provider_readiness_error), the password rotation at cleanup.

## Addendum P (2026-10-15, validator-8): F2 1c505eaea and F3 5a6787b46 -> 6b43ce6e5, read before the freeze
Read only (git show; no run in the owner's worktree). Identity noreply on all three; F3 row commit 5a6787b46 precedes the
code 6b43ce6e5 (rows before code: holds). Wrapper proof/import-codex-login.sh 6c816f47d14f65b2: no eval, no sourced file
(the only match of "eval" is a comment); it passes paths and a port only.
F2 checks at the freeze [L], in my own snapshot: the codex-import-deployment tests (secret, salt, password with $ ` \ ' "
round-trip and decrypt); /proc/<pid>/cmdline and environ of a fixture run free of secret values and of the names
DATABASE_URL / EZCORP_ENCRYPTION_*; Object.assign(process.env, ...) happens before the database module is imported
(dynamic import, codex-import-deployment.ts:61,71) and the CLI starts no child process; refusals deployment_incomplete /
deployment_dir_not_allowed / deployment_unreadable by test; mutant: the eval wrapper back -> the round-trip test red.
Note: the product CLI scripts/import-codex-login.ts now imports scripts/factory-graph-proof/codex-import-deployment.ts.
Both are under scripts/; a proof module in the CLI path is recorded as a note, not a finding.
F3 read (getCredential at 6b43ce6e5, credentials.ts:328-414): the message of ProviderNotConfiguredError is byte-equal to the
old one, so the ~30 callers and tests that match "No credentials available" still match. Two possible defects, to be
confirmed by tests at the freeze:
- P-F3a (wrong direction): with provider:accessMode:<p> = "oauth" (set by ProviderSettings.svelte:167) and nothing stored,
  getOAuthCredential throws a plain Error "No OAuth token for <p>" (line ~154); with "apikey" and no key, "Missing API key".
  Both are "nothing configured" but now read as provider_readiness_error. Test: accessMode oauth + no row -> expected
  provider_not_configured.
- P-F3b (masking stays): in the default ladder, every error of getOAuthCredential that is not isBrokenOAuth (a decrypt
  failure from a wrong web secret, JSON.parse of a corrupt row, a database error) is swallowed ("Fall through"), the API-key
  reader swallows its own errors (getApiKey catch), and the ladder then throws ProviderNotConfiguredError ->
  provider_not_configured. Only an error of the accessMode getSetting reaches provider_readiness_error. Tests: a stored
  OAuth row with a wrong secret; a database that fails on the OAuth row read only -> expected provider_readiness_error (or
  provider_credential_unusable), never provider_not_configured.

## Addendum Q (2026-10-15, validator-8): ruling on P-F3a / P-F3b (fixed before the freeze; Addendum P accepted)
Ruling: only "no row" / "no key" may fall through the ladder; red first with three tests; contract row first if the
mapping changes. My checks at the freeze [L], in my own snapshot:
- The three tests by name, red on 6b43ce6e5 by assertion (not a load error), green at the frozen head:
  accessMode=oauth + no row -> provider_not_configured; stored OAuth row + wrong web secret -> provider_credential_unusable;
  database failure on the OAuth-row read -> provider_readiness_error. Also accessMode=apikey + no key ->
  provider_not_configured (same rule; asked if absent).
- Each case at readiness AND at the broker's call-time check (no provider request in any refused case; counting provider).
- Mutants: the ladder swallows every OAuth error again -> the wrong-secret and database tests red; the "no row" plain Error
  read as a readiness error again -> the accessMode test red; a decrypt failure mapped to provider_readiness_error instead of
  provider_credential_unusable -> red.
- No message: the marker-string check of E4/F3 over the three new cases.
- The default ladder still serves a working API key when the OAuth row is merely absent (regression case), and the
  BYOK fall-through after a broken OAuth login (isBrokenOAuth) still serves the key (existing behaviour kept).
- If the mapping changes: the C10 row commit precedes the code commit (git log order).

## Addendum R (2026-10-15, validator-8): precedence ruling (database error refuses; decrypt failure falls through + warning)
Ruling: a database/store error on the OAuth-row read -> provider_readiness_error at once, even with a valid key. A decrypt
failure or a corrupt row -> falls through to a valid API key (ready, credentialKind apikey) AND a non-blocking warnings
entry {code: provider_credential_unusable, credentialFailure {errorClass, code?}} in the readiness document and the record;
with no key -> provider_credential_unusable. The warnings field is a contract row, committed first.
My checks at the freeze [L], in addition to Addendum Q:
- Two more tests by name, red first: wrong secret + valid key -> ready, apikey, exactly one warning; database error + valid
  key -> provider_readiness_error (no warning path, no provider request).
- Case table (all six at readiness and at call time): oauth-mode + no row -> not_configured; apikey-mode + no key ->
  not_configured; wrong secret, no key -> credential_unusable; wrong secret + key -> ready + 1 warning; database error, with
  or without key -> readiness_error.
- Warnings: present only in the fall-through case; absent when ready with no fault (no empty warnings noise is required
  either way, but the shape is fixed by the contract row); the warning is copied into the record exactly; the call-time
  check serves the key and does not drop the warning from the record.
- No message: the marker string placed in the decrypt error and the database error is absent from warnings, the readiness
  document, the record, /api/ready and the logs.
- Mutants: the warning dropped on fall-through -> red; the database error allowed to fall through to the key -> red; the
  decrypt failure refused despite a valid key -> red; the message copied into the warning -> red.
- Order: the warnings contract row commit precedes its code commit (git log).

## Addendum S (2026-10-15, validator-8): P-F3 commits 2f12ec3a7 (row) -> 1eba51862 (code), read before the freeze
Checked (read only): identity noreply on both; the row commit precedes the code; 1eba51862 touches credentials.ts,
factory-broker.ts and their two tests; exactly one existing test was replaced in credentials.test.ts ("getApiKey falls back
to env var when getSetting throws"), which matches the ruling (a database error is not "no key").
Freeze checks added [L], in my own snapshot:
- The owner's red log red/pf3-red.log re-run by me on 6b43ce6e5 (5 behaviour fails by assertion), green 95 at the head;
  the 42 ladder-using test files each in their own process (logs/pf3-callers/summary.txt re-run by me, not only read).
- Product-wide effect (not only the factory): getApiKey is used by chat and other callers; a database error now refuses
  instead of using an env key. Cases: database down + OPENAI_API_KEY in env -> refused by name in a chat-path test; the
  web e2e that matches "No credentials available" (web/e2e/orphaned-run-recovery.spec.ts) still passes.
- The local-model lookup (provider:customModels) no longer swallows: a database error there -> provider_readiness_error.
- The Google project-discovery commit (next): a failed discovery = broken login (credential_unusable; falls through to a
  key with the warning); test by name; row first if the mapping changes.
Two possible gaps (read at 1eba51862, getApiKey), to confirm by test:
- S-1 masking: a stored API key that cannot be decrypted, with an env key present -> the env key is used and no warning is
  recorded; the broken stored key stays invisible (the OAuth path now warns in the same case).
- S-2 class: a stored API key that cannot be decrypted, with no env key -> a plain Error "Stored API key ... cannot be read"
  -> provider_readiness_error. The ruling maps an undecryptable OAuth row to provider_credential_unusable; the same fault on
  the key row maps differently.

## Addendum T (2026-10-15, validator-8): S-1/S-2 ruling (folded into the Google-discovery commit)
Ruling: the stored API-key row is treated like the OAuth row: undecryptable key + no env key -> provider_credential_unusable;
undecryptable key + env key -> the env key is used with the same warnings entry; one C10 row line first; red first.
Freeze checks [L], in my own snapshot:
- Tests by name, red on 1eba51862 by assertion: undecryptable key, no env key -> credential_unusable (readiness, record,
  call time; no provider request); undecryptable key + env key -> ready, apikey, exactly one warning
  {code provider_credential_unusable, credentialFailure {errorClass, code?}}; Google project discovery failed -> broken
  login (credential_unusable; with a key: ready + the warning).
- Mutants: the key-row warning dropped -> red; the key-row decrypt failure mapped to readiness_error again -> red; the
  discovery failure mapped to readiness_error -> red.
- No message: the marker string in the key-row decrypt error and in the discovery error is absent from warnings, the
  document, the record, /api/ready and the logs.
- Order: the C10 line commit precedes the code commit.
- Freeze legs added: the chat-path test (database down + env key -> refused by name) and
  web/e2e/orphaned-run-recovery.spec.ts ("No credentials available") [H] (browser e2e).

## Addendum U (2026-10-15, validator-8): Google discovery + S-1/S-2 commits ffc0a5162 (row) -> c10ac7d1a (code)
Checked (read only): identity noreply; the row commit precedes the code; c10ac7d1a touches credentials.ts,
factory-broker.ts and their two tests; the only removed test line is in credentials.test.ts and it is tightened
(toBeInstanceOf(Error) -> toBeInstanceOf(ApiKeyUnusableError)), not weakened.
Freeze checks added [L]: re-run red/pf3-s-red.log (5) and red/pf3-s-credentials-red.log (1) on 1eba51862 by assertion; green
100 at c10ac7d1a; logs/pf3-s-callers (42 files, each in its own process) re-run by me; the two-broken-rows case gives two
warnings (one per row, each with its own errorClass); Addendum T's cases and mutants apply to c10ac7d1a.
State: freeze waits for the real run (real-7 up to 08:12:41Z, no import yet) and the typecheck at c10ac7d1a (gated, swap
floor red). I start nothing heavy before the freeze.

## Addendum V (2026-10-15T14:17Z, validator-8): real-8 state and the owner-run import
Read only at 14:16Z: proof/real-run.pending = "<PID> real-8"; pid <PID> = bash proof/real.sh real-8, started 14:13:38Z
(alive); proof/real-8.lock-held exists. The marker format and pid match H1. Typecheck at c10ac7d1a reported green in-lock.
Import deviation (to be judged under E9): the owner, not the user, ran the import at 14:07Z "at the user's request". So the
owner's session started the product tool, which read ~/.codex/auth.json. E9 and the 21:25Z rule allowed only the user's
own `!` command. The w4h-28 evidence holds no record of this import (no journey line, no log file after 13:55Z other than
real-8's). Needed for the verdict: the user's words that asked for it; the exact command line the owner ran (paths only);
its full output (expected: provider, masked account, expiry only). My judgment rule: if the user asked for it explicitly,
the read was done only by the product tool, and the output holds no value, I record a disclosed, user-authorized exception
(not a REJECT); otherwise E9 fails. I do not read the file or the owner's transcript.

## Addendum W (2026-10-15, validator-8): E9 import exception recorded (correction to Addendum V)
Correction: the coordinator (team-lead), not the owner, ran the import. The user's words at ~14:05Z: "can you do these for
us and monitor them", where "these" were the coordinator's listed actions, the first being the two import commands. The
commands ran the wrapper (6c816f47d14f65b2) with paths only: a --dry-run at 14:06Z, then the import at 14:07Z. Both outputs
held only the provider, the masked account (…6f41), the expiry (2026-10-22T23:37:41Z), plus dryRun/secretCheck for the
dry run. The coordinator log line 5137 holds the entry; it contains no JWT-like string (count 0).
Judgment under E9: a disclosed, user-authorized exception. The product tool alone read ~/.codex/auth.json; no value was
printed. It is not a REJECT. At the freeze I still check: the w4h-28 journey line (asked for) matches these facts; the
E9 sweeps over all evidence find no token, and the account appears only in the masked form.

## Addendum X (2026-10-15, validator-8): real-8 failure (reuse path) and the runner error shape
Facts (team-lead): real-8 failed 14:41Z before any model call (E7 count stays 0 model calls across real-1..8); readiness
ready on oauth; activation of the two bundled extensions on the REUSED deployment failed in 0.3 s with operation_failed /
"RunnerError: Runner request was invalid"; then 409 stale_release, 404 factory_package_release_unavailable x5; ended on the
1500 s preparation-receipt timeout; cleanup clean (marker removed, lock released, product DB and login kept).
Read: packages/@ezcorp/extension-runner/src/service.ts:301 (owner head): fetch: handle(request).catch(error =>
respond(400, ... error instanceof RunnerError ? error : new RunnerError("invalid_request", "Runner request was invalid")))
-> every non-RunnerError becomes a 400 invalid_request (masking class).
Freeze checks [L] unless stated:
- X1 error shape: a non-RunnerError thrown inside handle() -> runner_internal_error {code, errorClass, errorCode?} through
  the shared error shape; the client receives NO message (a marker string in the thrown message is absent from the
  response body and from the product's records and logs; it may appear only in the runner's own log); a genuine
  RunnerError("invalid_request", ...) keeps its code and text (existing tests unchanged, by name).
- X1 status: the answer for runner_internal_error is not 400 (a caller error); I check the status the owner chose against
  the client's retry handling (a 4xx is not retried; the code path that maps it is read and tested).
- X1 mutant: an unknown error mapped to invalid_request again -> a named test red. Second mutant: the message copied into
  the response -> red.
- X2 reuse path: a red-first two-boot activation test: boot 1 activates the two bundled extensions on a fresh deployment;
  boot 2 on the SAME database and stores activates them again (no operation_failed, no 409 stale_release, no 404
  release_unavailable). Red on c10ac7d1a by assertion with the real cause named (not by the masked text). [H] if it needs
  the runner in a Podman guest; [L] if it runs with the in-process runner.
- X2 root cause: the owner's named cause matches the first error in the runner log of real-8 (I read the runner log of
  real-8 for the first non-RunnerError class and code; no message copied into my files).
- X3 harness (suggestion, team-lead rules): after a terminal activation failure the harness waited the full 1500 s
  preparation-receipt timeout; a pass could end by name at the first terminal refusal.
- real-9 evidence joins E7 (one run only, usage equal across four places, P0-P4 visible).

## Addendum Y (2026-10-15, validator-8): rulings on Addendum X (status 500; X3 accepted)
Rulings: runner_internal_error = HTTP 500; a genuine RunnerError keeps 400 and its text; the owner tests RunnerClient retry
safety for 500 on non-idempotent operations; the harness ends at the first terminal activation refusal by name, red first;
both in the unmasking commit.
Freeze checks [L]:
- Status by test: a non-RunnerError -> 500 runner_internal_error; RunnerError("invalid_request") -> 400 with its text.
  Mutant: the 500 back to 400 -> red.
- Retry safety: for each non-idempotent RunnerClient operation (activation, start, any write), a 500 answer is NOT retried
  (the counting test server sees exactly one request); an idempotent read may retry within its stated bound. Mutant: a
  retry on 500 for activation -> red (two requests seen).
- X3 harness: a terminal activation refusal ends the pass at once with the refusal's code in the record and the exit;
  cleanup still runs (marker removed by owner pid, lock released); red first against the harness that waited 1500 s
  (a fake runner answering the refusal; the pass must end in seconds, not at the timeout). Mutant: the early end removed ->
  red by a time bound in the test.

## Addendum Z (2026-10-15T14:58Z, validator-8): real-8 root cause, 445c41a09, harness f08fe2195e995356, real-9, second import
Facts (team-lead): the reused deployment kept the product DB but not the runner store; reference-code's only release was
built by real-5's runner into real-5's store and deleted by real-5's cleanup; real-8's runner hit a plain file error.
Leftover (product): rehydrate a missing runner artifact from the product's blob copy.
Read: 445c41a09 (noreply; service.ts + its test) ONLY logs a non-RunnerError (errorClass, code, message cut to 500 chars) to
the runner's stderr through onUnclassifiedError; the client STILL gets 400 invalid_request "Runner request was invalid".
So Addendum Y (runner_internal_error, 500, retry safety) is NOT in yet; team-lead has asked the owner to confirm it.
Live, read only at 14:58Z: proof/real-run.pending = "<PID> real-9"; pid <PID> = proof/real.sh real-9 (since 14:49:35Z);
~/.w4h28-runner-store-w4h28-real-deployment-2 is 0700; both /run/user/1001/w4h28-real-deployment and -deployment-2 are 0700.
Freeze checks added [L]:
- Z1 runner log: the bounded message goes to the runner's own stderr only; the proof captures that stderr into
  proof/*.process-extension-runner.log, so those logs join the E9 sweep (no token, no secret, no account id).
- Z2 harness f08fe2195e995356: a kept deployment keeps its runner store under ~/.w4h28-runner-store-<deployment> (0700);
  the store holds artifacts only (no credential file; checked by file names and types); cleanup removes the store by its
  name together with the deployment. "Setup picks the newest staged release": I check that the chosen release's digest
  equals the pinned/expected digest; newest-by-time alone is a finding (a stale or foreign release could be picked).
- Z3 E9 second import (14:50Z dry run, 14:51Z import, by the coordinator on the user's standing instruction): same rule as
  Addendum W; output holds only provider, masked account (…6f41), expiry. Recorded as a disclosed, user-authorized exception.
- Z4 two holders: the login now sits in TWO product DBs (old deployment …92ad97 and deployment-2). A refresh in one rotates
  the refresh token and signs the other out. At cleanup: both deployments' DBs dropped, both /run/user dirs and the runner
  store(s) removed by name, after the password rotation; I check by listing (names only).
- real-9 joins E7 (one run only; usage equal across four places; P0-P4 visible). E7 count so far: 0 model calls, real-1..8.

## Addendum AA (2026-10-15, validator-8): rulings on Addendum Z
- The 500 / runner_internal_error / retry-safety part is the owner's next product commit, red first, with a named
  artifact_missing. Checks: Addendum Y in full, plus: a missing runner artifact (the real-8 cause: the file deleted from the
  store) -> artifact_missing by name (not runner_internal_error, not invalid_request), no message to the client; red on
  445c41a09 by assertion; mutant: artifact_missing folded into runner_internal_error -> red.
- Z2 ruled: the harness selects a staged release by the EXPECTED digest (newest among equal digests); a mismatching digest
  is never picked; no match -> a named failure. Checks (fake staged releases on copies): two releases with the expected
  digest -> the newer; a newer release with another digest -> not picked; none matching -> the named failure and the pass
  ends at once. Red first against f08fe2195e995356 (newest by time). Mutant: selection by time again -> red.
- Z4 ruled: after the rotation, both product DBs, both /run/user deployment dirs and every runner store are removed by name
  and listed in the owner's report. I compare that list with a read-only listing (database names, directory names) after.

## Addendum AB (2026-10-15, validator-8): 2a0c65e74 (runner unmasking) read before the freeze
Read: noreply; 10 files (extension-contract error-shape.ts moved from src/providers, which now re-exports it; runner client,
core, podman, service; service.test.ts; new tests/store-reuse.test.ts; coverage-thresholds). artifact_missing is raised
only where collectArtifacts reads the store and only for ENOENT (other codes rethrown -> runner_internal_error), so it is
narrow. The client answer for an internal error is {code runner_internal_error, stage, message "Runner failed with an
internal error", retryable false, errorClass, errorCode}: a fixed message, not the cause's.
Freeze checks [L]: Addendum Y and AA in full against 2a0c65e74; red 2 + 1 re-run on 445c41a09 by assertion; runner 119,
contract 27 and the app suites that import the client or the shape; DRY: one error-shape implementation (git grep for a
second errorShape body).
Judgments for team-lead:
- AB-1 contract row: the runner's wire error codes (invalid_request, runner_internal_error, artifact_missing; status
  400/500; retryable) are an interface between the product and the runner, but they are typed in the runner package
  (RunnerError codes) and not in the contracts document. My view: acceptable for this package with a LEFTOVER row to add
  (not blocking), because the type in the package is the single source and the tests pin it.
- AB-2 status: artifact_missing is a RunnerError, so it answers 400 (caller error) although the cause is the runner's own
  store. Within the ruling ("RunnerError keeps 400"); noted for the leftover row.
- AB-3 harness fail-fast (X3) has NO test; red evidence = real-8 itself. X3 was ruled "red first". A real run cannot be
  re-run as a red, and a mutant cannot be judged without a test. My view: a deviation; a small harness test with a fake
  runner refusing activation and a time bound is needed (or team-lead accepts the deviation explicitly).
- AB-4 Z2 (selection by the expected digest) is not mentioned in this report: still open.

## Addendum AC (2026-10-15T15:2xZ, validator-8): first E7 reads of real-9 (read only; proof/real-9.json ae7a2fba9035010a)
Tools: validator-8/e7-check/summarize.ts, usage.ts, costs.ts (print key names, usage and states only).
- Token sweep of real-9.json (JWT-like, Bearer, sk-, gh*_, refresh_token, "access"): 0. No accountId/account_id/
  chatgpt_account_id key present.
- One run: run1.runId <MSG-ID>; final succeeded; 6 attempts terminal (snapshot-repository,
  generate-private-candidate, freeze-complete-git-tree, protected-checks, 2 validator nodes); 10 validator results PASS;
  release factory-release:85ccff3e... succeeded, s3 tenant-01, ordinary/releases/w4h28/real-9/run1, outcome confirmed;
  productRefusals []; 5 export receipts.
- Usage, field by field (journal operation = task reservation actual):
  generate: in 1318 + out 92 = 1410 tokens = actual 1410; cost 178 = 178; compute 2122 = 2122.
  validator review (node 35c5e31c...): in 334 + out 57 = 391 = actual 391; cost 62 = 62; compute 2173 = 2173.
  envelope root spent: compute 4295 = 2122 + 2173; cost 240 = 178 + 62; tokens 1801 = 1410 + 391. inspection
  spentMicros 240. All equal.
- Bounds: generate reservation 250,000 cost micros / 50,000 tokens (actual 178 / 1410); sum of the six reservations'
  cost = 900,000 <= run cap 1,000,000.
Open for the freeze:
- AC-1: the provider receipt and usage.json are not in real-9.json; the four-way equality (V4/E7) needs them from the
  owner's report.
- AC-2: the review model call ran in a VALIDATOR node with a reservation of 400,000 cost micros and 20,000 tokens.
  Addendum D said "every other task node 50,000"; I check where the validator node's bound is declared (definition vs
  profile) and that it was ruled.
- AC-3: inspection costs.knownCostMicros = 0 while spentMicros = 240: I read what "known cost" means in the code before I
  call it a finding (it may count only priced external effects).
- P0-P4 visibility (E1) from steps(37) and the stores; objects-written refresh; candidate/manifest digests; effectDigest =
  manifest digest; cleanup (Z4) and the password rotation; all at the freeze.
E7 count: 2 model operations, both in real-9 run1; 0 in real-1..8 (as reported; I re-check the earlier records at the freeze).

## Addendum AD (2026-10-15, validator-8): AB rulings, Z2 commit 04502f428, real-9 facts, the receipt file list
Rulings: AB-1 accepted (leftover row in the contracts document, AB-2 noted in it). AB-3 NOT accepted: the owner adds the
fake-runner fail-fast test (time bound, mutant), red first, before the freeze. Check at the freeze: the test fails against
the harness without the early end (the pass waits to its timeout; the test's bound catches it), passes at the head; my
mutant (early end removed) red; cleanup still runs in the test (marker removed by owner pid, lock file released).
Z2 read (04502f428, noreply; scripts/factory-graph-proof/release-selection.ts + test, 3 tests; service.test.ts +16 for
the Y counting test; harness full.ts fb3a8166bc325048 uses it): selectStagedRelease filters by the bundled runner SOURCE
digest (digestObject of referenceCodeRunnerPackageFiles), sorts the matches by createdAt (ISO string compare), takes the
newest; no match -> ReleaseSelectionError code release_digest_mismatch naming the expected and staged digests.
Checks at the freeze:
- Red first was "module absent" (a load error, which does not count by my rule); I judge it by mutants instead: sort by
  createdAt without the digest filter -> the "newer release of other bytes" test red; the no-match throw replaced by "pick
  newest" -> red; the expected digest computed from another file set -> the first test red.
- AD-1 note: a release with the expected SOURCE digest can still lack its artifact in this runner's store (the real-8 case:
  built into a store that was later deleted). Selection does not check the store; activation then fails by name
  (artifact_missing, 2a0c65e74). Not masked any more; I record it as a limit, and the rehydrate leftover covers it.
- Y counting test: a 500 on start reaches the runner exactly once (counting server); mutant: client retry on 500 -> red.
real-9 facts (owner, via team-lead) match my reads (Addendum AC): lock 15:01:36-15:02:56Z; six attempts; two model
operations with the same usage; envelope 1,801 tokens / 240 micro-dollars; 10/10 PASS; acceptance on candidate
sha256:cc918f7f...; release confirmed; effect sha256:96b8b369...; one file candidate.json (6,231 B).
- AD-2 open (binding for E7): the receipt lists candidate.json only, while full-9 and full-10 also listed manifest.json.
  Addendum D requires "the manifest digest = the receipt's effectDigest" and both digests recomputed from the objects. At
  the freeze: the owner's root cause; a list/head of ordinary/releases/w4h28/real-9/run1 (names and sizes, read only); if
  manifest.json is absent from the store, the release is incomplete -> finding; if present but not in the receipt, the
  receipt is incomplete -> finding; in both cases effectDigest is recomputed and compared.

## Addendum AE (2026-10-15T15:06Z, validator-8): proof PostgreSQL password rotation checked (one command)
Owner: role factory_test rotated 15:05:27Z; postgres.env rewritten 0600; the old file kept as
postgres.env.old-20261015T150527Z (0600) for this check; script w4h-28/cleanup/rotate-pg-password.ts; SQL by stdin.
My check at 15:06:37Z (values held in subshell variables and in my login tool's process only; never printed, never in argv):
- both values present (length >= 8); old != new: yes;
- count-only search of the OLD value under w4h-28/, w00/, validator-8/ (postgres.env and postgres.env.old-* excluded): 0 files;
- login through the published port with the NEW value: ok (select 1); with the OLD value: refused
  (ERR_POSTGRES_SERVER_ERROR). Tool: validator-8/rotation-check/login.ts (reads the env file itself).
Disclosure recorded: the first rotation attempt (~15:04:5xZ) verified only on the container's trusted 127.0.0.1 path and
stopped with the new value only in memory; host logins through postgres.env failed for 30-60 s until the repaired script
rotated again; pg_stat_activity showed no other session connected.
Next: the owner deletes postgres.env.old-20261015T150527Z by name; I confirm its absence by listing (name only).
Limit: other sessions' transcripts are outside my reach (Addendum M).

## Addendum AF (2026-10-15, validator-8): sync-base-leg.py v3 for every W-SYNC base leg from now on
v1 (bef5b8e9007b1247) cut paths outside a fixed root list (docs/...) and could pass a changed file as main's own. v3
w4h-27-tools/sync-base-leg.py d44bbd55bb717c2c (test sync-base-leg.test.sh cce5670c77bcd1f9, 14/0; v1 9/5; two mutants
killed). W4H-31 re-judged: 41 files, 0 not main's own; ACCEPT stands (verdict-w4h-31.txt 8ed9d677f804b3f0). E8 and every
later sync base leg use v3, through the w00 copy once integrator-5 re-copies it.

## Addendum AG (2026-10-15T21:0xZ, validator-8): FINDING at f21e7619a — two P-F3b tests read as vacuous by gate-integrity
Record: w4h-28/legs/final-f21e7619a/gi-main.log, gi-default.log (and the base leg): the same 2 findings, "vacuous test (no
assertion)" in src/providers/factory-broker.test.ts near line 400 ("P-F3b: a database error on the OAuth-row read alone is a
readiness error, ...") and near line 422 ("a database error on the OAuth-row read with a valid key refuses at once; ...").
Reading: both tests put every expect inside the callback passed to withOAuthRowReadFailing (factory-broker.test.ts:370-377).
The helper awaits the callback and lets its errors through (try { return await run(); } finally { spy.mockRestore(); }), so
in behaviour the expects run. But scripts/gate-integrity.ts credits an assertion to a test only along the test's own call
paths (testAssertionPaths; unassertedAddedBlocks ~line 780-835), so a helper's callback does not count. That rule is sound:
a helper can fail to call its callback, and then the test passes with no assertion.
Finding: gate-integrity main is not 0 at f21e7619a (STOP rule), and the red-first claim for P-F3b (red/pf3-red.log) rests on
these two tests in their current form. Required of the next owner (team-lead's ruling): make the assertions explicit in the
test body (for example, return readiness, record, rejection and the sent count from the callback and assert outside it),
re-prove red first on 6b43ce6e5 by assertion, and show gate-integrity main = 0 with an empty expected file.
My checks: the two tests by name red on 6b43ce6e5 and green at the head; gate-integrity main 0 on all three legs; a mutant
(the helper does not call its callback) turns both tests red (with the assertions outside the callback, the returned values
are missing).

## Addendum AH (2026-10-15T21:3xZ, validator-8): shared hold tooling after the W4H-31 rulings (checked on copies)
Hashes: w00/leg-judge.sh 929d0a6fc43d2150 (test 5c36c7485a45da74: 10/0 on my copy); w00/heavy-lib.sh 000cb68ac789d36e
(test heavy-lib-leg.test.sh 31931ce92ac2f2b4: 8/0 on my copy; the backup .bak-20261015T2105Z-legjudge fails it: "unbound
variable HOLD_NOT_RUNNABLE"); w00/w4f-merge/hold-w4f.sh 9173e9ee9a2b6146; tracer bash-trace-env.sh 5bd68174bcace71c
(test w00/bash-trace-env.test.sh ae6c4e6af7fa81d6); W4H-31 not-runnable.txt 386c769458507dad (4 paths, each with a reason);
w00/bash-line-cover.py = my 08d2107533834b01 (re-copied). Evidence validator-8/legjudge-check/run.log.
leg_judge read: exit 0 passes; INFORMATIONAL keeps the raw exit and never sets the status; exit 97 is list-bound only when
an ARGUMENT of the leg equals a listed path exactly (no substring); any other exit of a listed file stays red; no list or an
unlisted file stays red.
Minor finding AH-1: the match succeeds when ANY argument is listed. A leg with a listed file AND an unlisted file that exits
97 (zero tests in total) would hide that the unlisted file also ran zero tests. Remedy: list-bound only when EVERY test-file
argument of the leg is listed (or the leg names exactly one file). W4H-31's four legs each name one file (to check in the
judgment).
For my W4H-28 holds: heavy legs through heavy-lib.sh use leg_judge; INFORMATIONAL only where a ruling names the leg.

## Addendum AI (2026-10-15T22:4xZ, validator-8): Addendum AG finding fixed by w4h-28b (3f3ae1ca4), read before the freeze
Checked (read only): 3f3ae1ca4 noreply; changes only src/providers/factory-broker.test.ts (+13 -12). The two P-F3b database-
error tests now take values returned by withOAuthRowReadFailing and assert in the test body (lines ~405-408 and ~425-427).
- Red: w4h-28/red/vacuous-fix-red.log, on 6b43ce6e5 with the P-F3b code reverted: both target tests fail by assertion at
  factory-broker.test.ts:407 and :427 (toMatchObject), not by a load error; 10 failures in total, all assertion errors.
- My mutant (helper never calls its callback): w4h-28/mutants/vacuous-helper-skips-callback.log: exactly the two target
  tests fail, 36 pass / 2 fail.
- gate-integrity at 3f3ae1ca4: base, default and main all "PASSED", no finding line (w4h-28/legs/gi-3f3ae1ca4/).
Status: AG closed on the owner's evidence. At the freeze I re-run the red, the mutant and gate-integrity myself in my own
snapshot (Addendum AG's checks), at the frozen head.

## Addendum AJ (2026-10-15T22:5xZ, validator-8): AB-3 fail-fast test checked; one test defect (orphaned flock holder)
Hashes: proof/pass-kit.ts a1a6bd4511f1e6a0; full.ts b389056f1571089d; pass-kit.test.ts 39de83eabc88c5fa. The test uses only
mkdtemp paths for the lock and the marker (never the real heavy lock or proof/real-run.pending); pass-kit.ts imports only
node modules (self-contained).
- Owner logs: red (kit without the early end) 3/1 "the bound was exceeded"; green 4/0; mutant 3/1.
- My run on copies (validator-8/ab3-check/run.log): head 4/0; my mutant (the early-end line made `if (false)`) 3/1 with
  "the bound was exceeded" -> killed.
- FINDING AB3-1 (test hygiene): when the AB-3 case fails, the test's flock holder (`flock <T>/lock bash -c 'until [ -f
  <T>/ab3.done ]; do sleep 0.2; done'`) is never stopped: <T> is removed, ab3.done never appears, and the holder loops for
  ever as an orphan (ppid 1). It also keeps the test runner's stdout open, so a caller that reads the output waits for ever
  (my command hung until I stopped my orphan). Seen on the host at 22:48Z: pid <PID> (started 22:34:42Z) and pid <PID>
  (22:36:04Z), from w4h-28b's red and mutant runs (not mine, not touched); pid <PID> (22:37:15Z) from my mutant run,
  stopped by me (kill by pid, my own process). Remedy: the test stops the holder in a finally/afterEach (holder.kill()), and
  the holder loop also ends when <T> is gone. Red first: a failing AB-3 case leaves no holder process.
- Limits (owner-disclosed, accepted for the plan): the fake product sits at the control API, not at the runner socket;
  full.ts was transpile-checked only (no stack run). At the freeze: full.ts runs in the next real or test-provider pass,
  or its diff is checked to be a pure move into pass-kit.ts.

## Addendum AK (2026-10-15T23:0xZ, validator-8): w4h-28b items 3-4 (AC-1/2/3, AD-2), read before the freeze
Head ef3b44213 (docs leftovers) on 045b5c078 on dde345730; all noreply. New files: proof/receipt-scan.ts 1e7dedfd8a66b81d,
real-9-receipt-scan.json 237ab67a0743409e, release-listing.ts 76e37c08cd472ad8, real-9-release-listing.json
e2cedb16c0e30e22; token sweep of the four: 0.
- AC-1 (closed on evidence): the product has no usage.json; the usage record is the journal column usage_json
  (src/factory/executions.ts:363). The provider receipt objects (read back read-only from the ordinary store after the
  product DB was dropped) carry usage equal to the journal: generate 1318/92/178/2122, review 334/57/62/2173; with the
  reservation actuals (Addendum AC) this is journal = provider receipt = settlement. At the freeze I read the two receipt
  objects myself (read only) and recompute providerReceiptDigest if its definition is stated in code.
- AC-2: the validator node's 400,000 cost / 20,000 tokens is harness operator startup material (full.ts:122; read at
  validator-composition.ts:112-114; cpu cap :117-118). The owner wrote "ruled" in a gate-file line; rulings are team-lead's.
  Needs team-lead's ratification (or another value); then I check the gate-file line and the leftover entry.
- AC-3 (product defect, fixed): run-inspection.ts known cost counted only usage settlement rows; a completion-settled
  reservation writes none, so known cost read 0. Row first dde345730 (C09 amendment AC-3), code 045b5c078: known += actual
  of every settled reservation with NO usage settlement row (NOT EXISTS, so no double count). Test in
  src/__tests__/helpers/factory-console-suite.ts (PGlite and PostgreSQL). Freeze checks: red re-run by me (expected 428,
  got 250 on dde345730); mutant "NOT EXISTS dropped" must make a test red -> needs a case with BOTH a stop-settled and a
  completion-settled reservation (I ask if absent); real-9's inspection would then read 240.
- AD-2 (no defect, accepted on evidence): the receipt lists member files and names the manifest by manifestKey, version
  and effectDigest; listing of ordinary/releases/w4h28/real-9/run1: candidate.json 6,231 B
  (sha256:2565dfa6...) and manifest.json 540 B (sha256:96b8b369... = effectDigest); no delete markers. At the freeze I
  read both objects read-only, recompute both digests, and check how candidate.json's digest relates to the acceptance's
  candidate digest sha256:cc918f7f... (a different object; the link must be named).
Open: AB3-1 (orphaned holder) and its two orphan pids; AC-2 ratification; rebase after the W4H-31 publish; final legs; freeze.

## Addendum AL (2026-10-15, validator-8): AC-2 ratified by team-lead (22:44Z)
Ruling: the review validator node's startup bound (400,000 cost micros / 20,000 tokens / 300,000 ms) is the proof's
operator value, operator startup material of the installation (proof/full.ts:122; validator-composition.ts:112-118 with the
cpu cap), not a definition node bound. Freeze checks [L]: the gate-file line names team-lead's ruling (not the owner's); the
real-9 reservation for the validator node equals 400,000 / 20,000 / 300,000 and actual 62 / 391 / 2173 stays within it;
the definition's per-node bounds (Addendum D) are unchanged. AC-3 both-kinds test and AB3-1 are ordered; checked at the freeze.

## Addendum AM (2026-10-15T23:2xZ, validator-8): AB3-1 fixed and checked on copies
proof/pass-kit.test.ts e6c4227549fa162a (kit unchanged a1a6bd4511f1e6a0). Cause per owner: `flock <file> bash -c ...` forks a
bash, so the test's kill reached flock only; now the holder is one process holding the lock on fd 9, its loop also ends when
its directory is gone, and afterEach awaits each kill; two new tests (no process names the directory after stop; removing
the directory ends the holder). Owner logs: red with the old holder 4/2 by assertion; green 6/0; mutant 5/1.
My run on copies, output to files (validator-8/ab3-check/v2.out, v2mut.out): head 6/0 (rc 0); my no-early-end mutant 5/1
(rc 1, killed). After 25 s: no process on the host names the test's temp prefix (a ps listing that excludes my own shell;
a first pgrep count of 2 was my own command line). The owner reports the four orphans (<PID>, <PID>, <PID>,
<PID>) stopped by pid. AB3-1 closed. Open: the AC-3 both-kinds test.

## Addendum AN (2026-10-15T23:3xZ, validator-8): AC-3 both-kinds case (a1290b31a) checked on evidence
a1290b31a noreply; test only (src/__tests__/helpers/factory-console-suite.ts +5 -2); product unchanged. Owner finding: the
first both-kinds fixture gave the stop-settled reservation no actual cost, so my NOT EXISTS mutant survived (27/0,
mutants/ac3-not-exists-dropped-before.log). Now the stop-settled reservation carries actual 250 beside its settlement rows
and the test asserts known cost exactly 428 = 250 + 178; against the mutant: 26/1, got 678 (double count)
(red/ac3-both-kinds-red.log). Green PGlite 27/0 and PostgreSQL 27/0 (owner). Disclosure recorded: the owner's safety
check refused one rm -rf of an old coverage folder; nothing ran; legs/cov-ac3 stays.
At the freeze: I run the mutant myself in my own snapshot (PGlite and PostgreSQL legs). All owner items before the rebase
are done; the rebase, final legs and freeze wait for the W4H-31 publish.

## Addendum (2026-10-15, validator-8): identity-check.sh becomes pattern-based (user decision, relayed by team-lead 2026-10-15): integrator-5/identity-deny.txt is dropped (deleted by name by integrator-5); content and files modes refuse ANY email-like string that is not the <USER> noreply address, by pattern, with no stored personal address anywhere; commits mode stays "author and committer = noreply"; red first; installed before the W4H-31 publish. My redaction rule ("<a non-noreply address>") stays.
Checks on copies when the hashes arrive [L]: (1) red first: a fixture line with a made-up non-noreply address is refused by the new check and passed by the old one; (2) the <USER> noreply address passes; (3) false positives, each named in the test with its decision: RFC 2606/6761 fixture addresses (for example the proof fixture user at example.invalid, example.com, .test), package scopes such as @ezcorp/x (no local part), user@host in URLs or ssh remotes, other GitHub noreply addresses; (4) no file anywhere stores a personal address (a search of the tool, its test and its fixtures for email-like strings finds only noreply and reserved-domain fixtures); (5) identity-deny.txt is absent (listing by name); (6) the refusal output names the file and line but prints the address as "<a non-noreply address>".

## Addendum AO (2026-10-16, validator-8): pre-check of the rebase onto 390c49a90 (head df1ff3373; not frozen)
- Identity: identity-check v5 commits 390c49a90..df1ff3373: 33 commits, clean.
- Change set equals the pre-rebase one: per-file numstat of 486e6a558..a1290b31a vs 390c49a90..df1ff3373 identical (118
  files); the whole-diff patch ids differ (a2e3bbcf9b744237 vs 858c61c8d7235da6) only through context lines; the added and
  removed lines, file by file, are identical (6,677 lines, 0 differ; validator-8/w28-pre.lines, w28-post.lines). The two
  hand-resolved files (extension-contract index.ts, extension-runner tests/service.test.ts) are judged at the freeze for
  "both sides kept" (resolution-lines.py on the rebased commits that touch them).
- E8 processSpawn: W4H-28's added non-test lines contain no new runner start call (no .start( / startExecution / startGuest
  in the + side); the runner start sites at the head (attempt-runtime.ts, host-launch-supervisor.ts:142
  FACTORY_GUEST_PROCESS_SPAWN, supervisor.ts) are #339's, so E8 holds by construction; at the freeze I run the #339 spawn-guard
  suites and the Podman lane suites in the lock to prove the lane still starts under the deny-by-default policy.
- Final legs: queued as w4h28-final-df1ff3373 (owner).

## Addendum AP (2026-10-16, validator-8): rebase items team-lead asked for, checked read only
- Identity range and the 118-file equality: see Addendum AO (33 commits clean; +/- lines identical file by file).
- Conflict 1, packages/@ezcorp/extension-contract/src/index.ts: the base exports ./process-spawn, W4H-28 adds ./error-shape;
  df1ff3373 exports both (and every other base export).
- Conflict 2, packages/@ezcorp/extension-runner/tests/service.test.ts: test titles base 390c49a90 = 6, W4H-28 a1290b31a = 9,
  df1ff3373 = 10; every base title and every W4H-28 title is present at df1ff3373 and no other title exists; the one title
  the base has and the pre-rebase base 486e6a558 lacks is #339's "capabilities: a runner advertises process-spawn
  enforcement..." (kept). At the freeze I run the file and store-reuse in my snapshot (both sides' tests must pass, 12/0 per
  the owner).
- Leg scripts (against *.bak-20261016T-rebase): final.sh changes only BASE_REF 486e6a558 -> 390c49a90 for gate-integrity base;
  focused.sh changes BASE_REF and adds src/factory/console.integration.test.ts and tests/postgres/factory-console.test.ts;
  red.sh changes only a comment, and its base is the worktree .worktrees/w4h-28-base, which is at 390c49a90 (git worktree
  list). Nothing else changed.

## Addendum AQ (2026-10-16, validator-8): W4H-28 NOT frozen: the focused leg masked reds since 61deb0323
Mechanism (read): legs/focused.sh prints each step's rc ("merge rc", "patch rc", "new-file rc", "crap rc") and ends with
`echo "total fails: $total_fail"`, so the script always exits 0; final.sh records that 0 as "focused rc=0" in summary.txt.
Masked reds at df1ff3373, f21e7619a and 61deb0323: (1) src/factory/s3-release-adapter/package.podman.integration.test.ts "the
pinned image builds the locked source into the artifact the SDK names" 0/1 (red since f21e7619a); (2) patch coverage: no lcov
data for packages/@ezcorp/factory-transport/src/index.ts, src/factory/host-preparation-client.ts,
web/src/lib/server/factory-boot.ts; uncovered changed lines supervisor-services.ts 60, 306 and task-admission.ts 77; (3) CRAP
task-admission.ts:72 at 92.4 (6 percent coverage). Ruling: every leg script exits non-zero on any red, proven red first with a
planted failure per script; each red root-caused; re-run through gated-flock; then freeze.
Checks added:
- AQ-i exit propagation: for EACH leg script (legs/static.sh, legs/focused.sh, legs/guard.sh, red/red.sh, legs/final.sh and any
  script they call that ends in echo), on copies with a planted failure (a test file that fails, a step command replaced by
  `false`): the script exits non-zero and the summary line shows it; the unmodified script exits 0 on the green head. Red first:
  the old focused.sh (backup) exits 0 with the planted failure. A step that is informational by ruling (CRAP if so ruled) must
  be named in the script as informational, not silently dropped.
- AQ-ii I read focused.out myself at the freeze (every suite's pass/fail line, merge/patch/new-file/crap results), not the rc;
  the same for static, guard, red and gate-integrity outputs.
- AQ-iii the Podman test: the owner's root cause reproduced E2E (the failing build of the pinned image; what changed at
  f21e7619a); red on the head before the fix by assertion, green after, run by me in the lock [H]; if the fix touches the
  pinned image or the locked source, the S3 adapter pin (Addendum D / P4) is recomputed by me.
- AQ-iv patch coverage: 100 percent of the changed lines by my own read of the merged lcov (my changed-lines tool), incl. the
  three files with no lcov data (their suites must be in the focused set and produce SF records) and the lines
  supervisor-services.ts 60/306 and task-admission.ts 77; CRAP task-admission.ts:72 below the threshold (covered or split; a
  split must not move the complexity into another uncovered function).
- AQ-v what else the earlier "green" claims rested on: I list every W4H-28 claim that cited summary.txt or a leg rc
  (handoff entries: "final legs at 61deb0323 all rc 0", "static legs green", owner reports citing focused results, my
  addenda that cite owner evidence: AI, AK, AM, AN and earlier); for each, I re-check from the raw outputs at the frozen
  head (not from an rc). Claims that rested only on focused rc are void until re-shown. My own runs (copies, mutants) did not
  use focused.sh and stand.
Unaffected: Addenda AO and AP (identity, the change-set equality, the two conflict files).

## Addendum AR (2026-10-16, validator-8): the Podman red's root cause (artifact digest drift) and ruling A+B (B first)
Root cause (owner, via team-lead): the S3 release adapter's locked artifactDigest a2d61ff1... cannot stay stable. Cause 1: every
build embeds the provided SDK bundle (extension-runner provision.ts:82-97 bundles packages/@ezcorp/sdk + extension-contract,
src and dist), so 2a0c65e74's error-shape.ts and #339's spawn policy each moved the digest (red since f21e7619a). Cause 2:
Bun.build inlines the BUILDER's NODE_ENV into the SDK bundle (31f2b28e... outside bun test, 39308a39... under NODE_ENV=test).
The product never rebuilds the adapter at runtime (startup-config.ts:619 checks the digest's form only), so real-9 was not
affected; lock.json's comment "no factory-sdk change moves either digest" is false.
Ruling: (B) provision.ts bundles with a fixed NODE_ENV and no builder env inlined; red first (two envs -> two digests on the
old code, one on the new) + a determinism test (two builds under different NODE_ENV -> equal digests); (A) re-lock lock.json and
the factory-sdk literal with the post-B digest; lock.json records the provided-SDK bundle digest with a FAST unit test that
recomputes it (an SDK or contract change goes red in its own hook); a re-lock script; the comment corrected; every other pinned
artifact or SDK digest that B moves is re-locked in the same commit by name.
Checks added:
- AR-1 (B) red first: on the head before B, two builds under NODE_ENV=test and NODE_ENV unset give two different digests
  (reproduced by me); after B, one digest; the determinism test passes; mutant: the fixed NODE_ENV removed -> the
  determinism test red.
- AR-2 no builder env reaches the bundle: grep of provision.ts's Bun.build call (define / env options) and of the built bundle
  (string search for process.env.NODE_ENV values and for any other env value of the builder, using marker env vars set at
  build time: a build with a marker variable set must not contain the marker).
- AR-3 (A) re-lock: lock.json's artifactDigest and the factory-sdk literal equal the digest I recompute from the committed
  source after B (I build it myself in my snapshot, twice, under two NODE_ENV values); the provided-SDK bundle digest in
  lock.json equals my recompute; the fast unit test is red when one byte of the SDK or contract source changes (mutant: a
  comment added to packages/@ezcorp/sdk) and green otherwise; the re-lock script reproduces the committed values (run on a
  copy); the corrected comment states the dependency truthfully.
- AR-4 every other pinned digest B moves: the report lists them by name; I search for every sha256 literal of an artifact or
  SDK in the repo before and after (git grep) and check each changed one is listed and re-locked in the same commit.
- AR-5 AQ-iii closes with the Podman test green at the frozen head [H], and the S3 adapter pin (Addendum D / P4) recomputed by
  me equals the lock.
- AR-6 runtime: startup-config.ts:619 checks only the digest's form; the report states whether that stays (no runtime rebuild)
  and the real-9 record's adapter digest is noted as the pre-A value (history, not a defect of the run).
- AR-7 W4H-32: its digest fixtures (if they embed the adapter or SDK digest) are re-checked after A lands; recorded in
  plan-w4h-32 when the owner reports.
AQ-i pre-read (2026-10-16, validator-8): legs/focused.sh 327da6039427e4af now ends with [ total_fail = 0 ] && [ patch_rc = 0 ] && [ newfile_rc = 0 ] && [ crap_rc = 0 ], so its exit status is the leg's result (backup focused.sh.bak-20261016T-exit; the recorded df1ff3373 run is the red evidence). Note: the merge-lcov rc is not in the condition; a failed merge would most likely surface as a red patch gate, but I check it with a planted merge failure in AQ-i. The patch reds were suites missing from the list (supervisor-services.test.ts, host-preparation-client.integration.test.ts, factory-stop-epoch.test.ts, web factory-boot.server.test.ts under vitest); AQ-iv reads the merged lcov for those lines at the freeze.

## Addendum AS (2026-10-16, validator-8): B (978293379) and A (b6c3f846d) read before the freeze
- Identity: both commits noreply. B: provision.ts (+9 -1) + tests/provision-determinism.test.ts; A: 10 files (references.ts,
  lock.json, relock.ts/relock.test.ts, scripts/relock-s3-release-adapter.ts + test, package.ts, package.test.ts, the Podman
  test, coverage-thresholds.json). The old digest a2d61ff1... appears nowhere at b6c3f846d (git grep).
- B's form differs from the ruling's words: the ruling said "a fixed NODE_ENV"; B defines process.env.NODE_ENV and
  process.env.BUN_ENV as THEMSELVES (RUNTIME_ENV_READS), so the bundle keeps the runtime read and no builder value is
  inlined; reason given: sdk src/test/filesystem.ts:88 reads NODE_ENV ?? "test" at runtime. This meets "no builder env
  inlined" but not "fixed"; team-lead to confirm the form. My AR-1 mutant becomes: the define removed -> the builder value is
  inlined -> the determinism test red; AR-2: a build with a marker NODE_ENV and a marker BUN_ENV must not contain either
  marker, and any OTHER builder env var Bun inlines by default must be checked (I list Bun.build's default inlining).
- A: lock.json now holds sourceDigest d9823102..., sdkDigest f3c4fba2..., toolchainDigest 6095bbe3..., artifactDigest
  54dcd1fd... and the image digest; references.ts:134 names 54dcd1fd.... The Podman test (8 added, 21 removed lines) now
  asserts `await buildS3ReleaseAdapterLock()` toEqual the lock, using the SAME function the re-lock script uses, and its old
  `expect(build.state).toBe("succeeded")` is gone. Checks: (1) buildS3ReleaseAdapterLock throws (or the test fails) on a failed
  build (a test with a failing build); (2) my AR-3 recompute uses an INDEPENDENT path, not relock.ts: I run the product's own
  build of the adapter package (the publisher path in package.ts, in the pinned image, in the lock [H]) and sha256 the
  artifact bytes myself, twice under two NODE_ENV values; the result must equal 54dcd1fd...; the SDK bundle digest computed by
  my own hashing of the provision output must equal f3c4fba2...; (3) "the comment corrected": I find where the false sentence
  was (not lock.json, which is JSON) and read the new text.

## Addendum AT (2026-10-16, validator-8): B's form confirmed; the helper ruling; my two holds
Team-lead: B's form CONFIRMED (the runtime read kept; nothing from the builder inlined). Ruled to w4h-28b: (1)
buildS3ReleaseAdapterLock() must fail on a failed build, red first (a build made to fail -> the helper fails, the Podman test
fails; the "build succeeded" assertion returns in that form) -- my read of relock.ts at b6c3f846d already shows `if
(build.state !== "succeeded") throw`, so the red-first test is what is added; (2) AQ-iii closes ONLY on my independent path.
My holds at b6c3f846d (each its own gated-flock job, yield file w4h-28/proof/real-run.pending):
- validator-8/hold-w4h-28-ar.sh (out w4h-28-ar): AR-1 determinism green + the define removed -> red; AR-3 fast test green + one SDK
  byte -> red + one contract byte -> red; the re-lock script under NODE_ENV unset and production (5 "(unchanged)" each, tree
  clean); the Podman adapter test under bun test (NODE_ENV=test).
- validator-8/hold-w4h-28-indep.sh 7545b99df941b2da (out w4h-28-indep): the INDEPENDENT recompute: my driver
  v8-indep-build.ts 1b230ae72173708c builds the adapter with the product's PodmanRunner directly (no relock.ts, no
  filesDigest) and writes the raw source, SDK, toolchain and artifact file maps; my hasher v8-indep-hash.py 1f9155b70e42ff2a
  (own canonical JSON: sorted keys, compact separators) computes each sha256 and compares with lock.json; under NODE_ENV
  unset and NODE_ENV=production; the two envs' artifact and SDK file maps must be byte-equal. The sourceDigest comparison also
  proves my hasher matches the product's canonical form (the lock's sourceDigest came from the product's filesDigest).
Lock order (team-lead, binding): my two queued wrappers (validator-8-w4h28-ar, -indep) were stopped by pid, parent first,
at 2026-10-16T04:0xZ; neither held the lock (no child under their flock), neither ran a step (no hold.log, no snapshot). One
merged hold replaces them: validator-8/hold-w4h-28-aqiii.sh acb6c87fd5f2a4f7 (HEAD_REF given at launch; out
w4h-28-aqiii-<head>; the AR/AS steps + the independent recompute), launched once push11/push.exit exists AND w4h-28b's next
head (the helper-fails-on-failed-build commit) is known. At that head I add the helper's red-first test to the run.
AQ-i material (owner): legs/lib.sh 58b88edd997803b7 (leg records "<name> rc=N", keeps the worst); static.sh 23a198e3d3e42518,
guard.sh 0a216fea377ab749, focused.sh 5c8c086fea3c0301, final.sh 4ab26aeee2034891, red/red.sh 58159e158bda420c; legs.test.sh
e14290da8689897c (30/0 planted checks; the OLD final.sh pinned as masking on a fake tree); red.sh lists all 37 branch test files
(3 green on base with reasons). At the freeze I run legs.test.sh on copies myself and read final-<head>/summary.txt's "worst rc".
Head for the merged hold (2026-10-16): 8d9234f24 (noreply; relock.ts + the Podman test: result.state asserted on its own; a second Podman case plants a failing feature test in the real image -> refused by name; owner red red/as-forced-failure.log). hold-w4h-28-aqiii.sh is now 4c9a1e882f35f8fc: it adds mutant as-helper-state-check (relock.ts 'if (build.state !== "succeeded") throw' -> 'if (false) throw'; the Podman failed-build case must go red). A lock-free poller of mine launches it at 8d9234f24 when push11/push.exit exists (out w4h-28-aqiii-8d9234f24). merge_rc: focused.sh 5c8c086fea3c0301 makes merge its own leg feeding the exit (my 327da6039427e4af pre-read was an interim version). Owner disclosure recorded: one root 'bun x tsc' started lock-free by mistake (ended within seconds).

## Addendum AU (2026-10-16, validator-8): merged hold at 8d9234f24 (exit 1) — results; two of my own defects; follow-up
Out: validator-8/w4h-28-aqiii-8d9234f24 (results.jsonl, logs/). Snapshot built and removed; config baseline at start and end.
PASS: ar1-determinism 2/0; ar1-define-removed RED (2 tests); ar3-fast 11/0; relock-env-unset and relock-env-production: 5
"(unchanged)" lines each, tree clean; podman-adapter-test-env 2/0 (incl. the failed-build case); as-helper-state-check RED (the
state check disabled -> the failed-build Podman case red); lock-values read.
NOT A PRODUCT FINDING (my mutants): ar3-sdk-byte and ar3-contract-byte SURVIVED (4/0) because both added a COMMENT:
provision.ts copies only .d.ts files as text (readTree(..., declarationsOnly=true), line 30-35) and the .ts sources reach the
bundle only through Bun.build, which drops comments; a comment moves neither the bundle nor the artifact, so the test is right
to stay green (equivalent mutants). Replaced by code mutants (an exported constant in packages/@ezcorp/sdk/src/v4/index.ts and in
extension-contract/src/error-shape.ts) in the follow-up hold.
MY DEFECT: indep-build-unset/-production exited 1: my driver passed sourceDigest "0"x64 and the runner refused
(source_digest_mismatch); indep-hash/-envs-equal therefore had no input. Fixed: v8-indep-build.ts 630d8fb15faf7a25 passes
filesDigest(files) as the build INPUT only (every output digest is still mine).
Follow-up: validator-8/hold-w4h-28-aqiii2.sh 68a00786d2ec5f67 (out w4h-28-aqiii2-8d9234f24) via gated-flock: ar3-fast + the two
code mutants + the independent recompute (two envs). AQ-iii and AR-3 close on its result.

## Addendum AV (2026-10-16T04:57Z, validator-8): AR-3 and AQ-iii CLOSED at 8d9234f24 (follow-up hold exit 0)
Out validator-8/w4h-28-aqiii2-8d9234f24 (hold.exit 0; snapshot removed; config baseline at start and end).
- AR-3: package.test.ts 4/0; code mutant ar3-sdk-code (an exported constant in packages/@ezcorp/sdk/src/v4/index.ts) RED;
  ar3-contract-code (an exported constant in extension-contract/src/error-shape.ts) RED. Together with the first run
  (ar1-define-removed RED; the re-lock 5 "(unchanged)" under two envs; the Podman tests 2/0; as-helper-state-check RED).
- AQ-iii (independent path, team-lead ruling): the product's PodmanRunner driven by my driver (v8-indep-build.ts
  630d8fb15faf7a25; no relock.ts), the build "succeeded" under NODE_ENV unset and NODE_ENV=production; my own canonical-JSON
  hasher (v8-indep-hash.py 1f9155b70e42ff2a) gives, under BOTH envs, sourceDigest d9823102..., sdkDigest f3c4fba2...,
  toolchainDigest 6095bbe3..., artifactDigest 54dcd1fd33774934dc1a5a2ec4d4adb19daa059b355856f168d6ee1468d8f0bc, each EQUAL
  to lock.json; the two envs' artifact and SDK file maps are byte-equal (cmp). The sourceDigest equality also shows my hasher
  matches the product's canonical form.
Remaining for the W4H-28 freeze: AQ-i (legs.test.sh on copies), AQ-ii (raw outputs), AQ-iv (patch coverage by my lcov read),
AQ-v, and the other freeze checks of the earlier addenda.

## Addendum AW (2026-10-16, validator-8): the patch-gate red at 8d9234f24 root-caused; fix 6c0b99d37
Cause (owner, via team-lead): packages/@ezcorp/factory-transport/src/index.ts is V8-canonical (scripts/coverage-config.ts
V8_CANONICAL_SOURCES; merge-lcov refuses Bun records for it), and its canonical producer scripts/factory-orchestrator-coverage.sh
was RED 100/101: gateway-activities.test.ts:192 still expected 16 MiB + 1 to be refused after the gateway-ceiling ruling
(GATEWAY_MAX_RESPONSE_LIMIT_BYTES 16 -> 64 MiB); the owner's legs never ran that Node suite. Fix 6c0b99d37 (test only): refuses
64 MiB + 1 and accepts a 64 MiB limit; red first on the pre-ruling transport (red/gateway-ceiling-red.log); Node suite 101/101;
V8 lcov line 36 (1 hit), 187 (26 hits). focused.sh da31df85dbb9ff09 runs the producer as its own leg
"test:factory-orchestrator-v8"; legs.test.sh ff2be680f2588aed plants it (31/0). Final legs w4h28-final-6c0b99d37 queued.
Read now:
- AQ-v (V8-canonical sources): the only V8-canonical source W4H-28 changes (390c49a90..6c0b99d37, against the 98-entry list) is
  packages/@ezcorp/factory-transport/src/index.ts; its lcov must come from the Node producer (not Bun).
- The value: index.ts:36 GATEWAY_MAX_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024 ("the ceiling for the one reply that carries a
  built package's artifacts (64 MiB, the host preparation bound)"); :187 refuses a limit outside 1..ceiling with "factory
  gateway byte limit is invalid". The contract row at line 167 (W4H-26 + W4H-28) bounds the host-preparation reply at 64 MiB and
  keeps every other host-service reply at 4 MiB: consistent (a ceiling; each caller names its own limit). Note: no row names
  the transport ceiling itself (a leftover for the W4H-36 rows if the team wants it).
Checks at the freeze:
- I run scripts/factory-orchestrator-coverage.sh myself at the frozen head (Node, in my snapshot): 101/101 and its V8 lcov
  shows line 36 and 187 hit; the red log read; mutant: the ceiling back to 16 MiB -> the Node test red.
- legs.test.sh ff2be680f2588aed: the new plant (the producer red -> focused leg red) included in my AQ-i run on copies.
- Lesson recorded below: a V8-canonical source's coverage only counts from its Node producer; a Bun probe of its lines is not
  evidence.
- Erratum to AW (re-read at 6c0b99d37): V8_CANONICAL_SOURCES has 90 entries, not 98. The intersection with the changed files
  is unchanged: only packages/@ezcorp/factory-transport/src/index.ts. The contract row is in
  docs/plans/2026-09-12-composable-factory-platform-contracts.md line 167.

## Addendum AX (2026-10-16, validator-8): final verdict at 6c0b99d37 = NOT ACCEPTED (F1, F2); everything else holds
Verdict file verdict-w4h-28.txt acd6ca627f3d303b (correction 1 on top; first text 876c46e3811ef694 kept below and in
verdict-w4h-28-before-correction1.txt). F1 git-spawn-context-guard RED (scripts/relock-s3-release-adapter.ts:14 spawns git with no
env); F2 guest-sdk-closure RED (src/factory/s3-release-adapter/relock.ts:13 names the SDK source path outside the closure helper);
both from b6c3f846d; the owner's guard set (guard-suites.sh, 41 files) holds neither, my invariant legs do.
AQ-i, AQ-ii, AQ-iv, AQ-v, AW: hold (detail in the verdict). Integration plan: sound (hook list recomputed equal; unit holds hook +
51 invariants; pg 9; all owner proof legs present). Gap accepted-with-closure (team-lead): fleet-cli modelProvider untested in
W4H-28; W4H-34 adds the red-first test at its rebased head; checked there.
At the fix head: the two invariant tests green; the fix under the normal hook; identity; a delta read (only the fixed files);
everything else carries over.
- Integration note closed (2026-10-16): extra-legs.sh ccb74651619564b5 runs both Podman suites through heavy-lib's file_leg (a
  missing listed file fails by name); no `[ -f ] &&` guard left (diff vs extra-legs.sh.bak-fileleg: that one line). The console PG
  suite gets EZCORP_FACTORY_STORAGE_SECRETS_DIR from heavy-lib.sh line 12 (c020becdf406ff86).

## Addendum AY (2026-10-16, validator-8): F1/F2 fix commits read (6a01d36a5, then 028f71efa = branch tip)
- F1 (6a01d36a5): scripts/relock-s3-release-adapter.ts:15 spawns `git status --porcelain` with env currentRepositoryGitContext(
  process.env) (import from @ezcorp/sdk/git). Class check: ROOT = join(import.meta.dir, "..") (line 12), the repository the script
  lives in; the script has no explicit-target argument; so a current-repository spawn (the owner's statement holds).
- F2: 6a01d36a5 first NAMED relock.ts in guest-sdk-closure.test.ts (team-lead accepted that form); 028f71efa then replaced it with
  the closure-helper form: guest-package-build.ts exports factorySdkSourceDirectory(root) and uses it for the closure; relock.ts
  derives S3_RELEASE_ADAPTER_SDK_PATH = join(factorySdkSourceDirectory(""), "references.ts") (the same string as before); the test's
  named entry is removed again (the list is back as it was). The owner's red: red/f2-closure-red.log. The named-list checks of
  team-lead's message are moot at 028f71efa; my checks there: both invariants green, the path value unchanged (a test reads it),
  relock.ts stages SDK bytes only through the product's runner build (relock.ts:45), and the red re-run.
- Hold for the new head: hold-w4h-28-final.sh e1dbb150c4ea3f23 (HEAD_REF parameter; red_parent for the nine whose hunks no longer
  reverse; PGRUN_KEEP_STORAGE=1 with the shared storage folder for the console suite; pkg-common.sh a443869cfe632faa).
- Re-prep at 028f71efa (integrator-5) judged (2026-10-16, read only): all relayed hashes equal; my `git merge-tree --write-tree
  b7dbd9210 028f71efa` = a22da292327f... (= config.sh TREE), 126 files 6061+/904-; my recomputed hook list (staged_test_targets at
  028f71efa, orchestrator tests -> the package line) = hook-mapped-028f71efa.txt, 59 = 59; unit.txt 207 holds every hook test and all
  51 invariant tests incl. git-spawn-context-guard and guest-sdk-closure; pg 9; extra-legs.sh ccb74651619564b5 (file_leg). Sound.

## Addendum AZ (2026-10-16, validator-8): FINAL VERDICT ACCEPT at 028f71efa
verdict-w4h-28.txt eafe605023275d0d (new section on top; earlier text in verdict-w4h-28-before-accept-028f71efa.txt). Hold
w4h-28-final-028f71efa (hold-w4h-28-final.sh 1aa3ef2e673eabe5). F1 and F2 fixed with mutants red; 51 invariants green; red_parent
reds by assertion for the P-F3 ladder and both runner commits; six load-error reds void by my rule (the commit adds the imported
symbol); console PG 27/0. The integrator launches on this ACCEPT.
- Red-first for the 11 void legs (team-lead's question, 2026-10-16): the 67 test names the 11 commits add (derived from each commit's
  own test diff) are in w4h28-void-cases.txt; 64 are in warn-cases.txt as they stand; "a file that is not a Codex login..." was renamed
  later (the head's codex suite holds its successor); 3 are in the list but CUT at an escaped quote (see the integration finding).
- INTEGRATION FINDING I-1 (integrator-5's prep, not the package): warn-cases.txt 876cc8dd1f9b8b7b and warn-cases.derived.txt lines 130,
  143, 144 end in a literal backslash where the test name has an escaped quote (\"not configured\", \"no key\"): "...never \",
  "getApiKey refuses when getSetting throws: a database error is not \", "a stored key that cannot be decrypted and no env key is never
  \". case-check.sh 79eb4acad3c2b062 matches by substring (`c in name`); the junit name has a plain quote and no backslash, so these 3
  cases print "CASE MISSING or not passed" and turn the leg red although the tests exist and pass (factory-broker.test.ts:334,
  credentials.test.ts). Fix: derive names with the escape removed (the full name, e.g. ...never "not configured" (W4H-28, C10)), or cut
  before the backslash; re-derive and re-hash.

## Addendum BA (2026-10-16, validator-8): verdict correction 2; the six checks on integrator-5's W4H-28 hold (package form)
Correction 2 (verdict-w4h-28.txt 388932d704503c97): case-check.sh runs at the MERGE only (cases must PASS by name; changed test lines
covered); it shows nothing red on base. Red on base exists only as the owner's file-level red.sh (load errors count). Ruling asked:
accept the file-level red on base for the 11 new-module commits, or require a stub-based assertion red.
Six checks on the hold's record (read only; tooling hashes recorded at its start: heavy-lib.sh c020becdf406ff86, extra-legs.sh
ccb74651619564b5, case-check.sh 79eb4acad3c2b062, hold-w4f.sh, config.sh b0969eb78fe616e8, warn-cases.txt AFTER the I-1 fix):
1. heavy.exit = 0 and "HEAVY DONE status=0"; the commit under test = the merge of 028f71efa onto b7dbd9210 with tree a22da2923 (git
   rev-parse <merge>^{tree}); its first parent b7dbd9210, its second 028f71efa.
2. Every leg exit 0. Package form: patch, new-file and CRAP BIND (no informational coverage); the only non-zero allowed is a leg a
   ruling names (none known); no NOT-RUNNABLE leg (none of the four files is listed).
3. Case-check: all 148 lines of warn-cases.txt print "CASE PASS" (the 3 I-1 names fixed); changed test lines all covered; the
   bash-line-cover receipt clean; container/Podman cases ran with EZCORP_RUN_PODMAN_TESTS=1 (both file_legs present, not MISSING).
4. Owner proof legs present and green: orchestrator-v8-node24141 (Node 24.14.1; my check: its log shows "ℹ fail 0" and 101 pass) and
   gateway-activities-case (the "✔ shares a bounded credential-reloading..." line); extension-runner package; both Podman file_legs;
   owner legs.test.sh 32/0 (fd08b1f0c3a2b4f2), pass-kit, run-marker.
5. Merge gates: the main leg = the default invocation against the EMPTY expected set (a package merge); the base leg against b7dbd9210;
   gate-integrity default PASSED; identity on the merge commit (<USER> noreply author and committer) and identity-check commits clean.
6. No leg hidden: the count of END lines in heavy-batch.log equals the count of leg/tc_leg/file_leg calls the hold runs (hold-w4f.sh +
   extra-legs.sh), each name once; unit 207 files, pg 9 files, 51 invariant tests (in unit) each seen in the record.
- RULING (a) (team-lead, 2026-10-16): for a commit that adds the module or export its tests import, the load failure on the parent
  tree IS the red; the file-level red on base (owner's red.sh; my red_parent load errors) plus every named case PASSING at the merge
  in the case-check is the red-first proof. The W4H-28 ACCEPT stands (verdict 388932d704503c97). My OK for the hold launch (after
  I-1) checks: both case files re-hashed; no line ends in a backslash or holds an escape; each of the 67 names of
  w4h28-void-cases.txt d57ae94d8ab40f9b is a substring of some line (or the line a substring of the name) of warn-cases.txt, except
  the renamed codex case, which needs its successor at the head; each line matches a test name at 028f71efa (git grep -F); the
  integrator's red-first on a copy (an old line fails, the new one passes) read.

## Addendum BB (2026-10-16, validator-8): rule 11 as corrected (mutant per new-module commit) — the list is COMPLETE
Rule (team-lead's correction): red-first for a new-module commit = the load failure on the parent tree (file level) + every named case
PASSING at the merge + >= 1 planted mutant per commit RED by assertion. Run: hold-followup.sh + followup-w4h-28-mutants.legs
649b02328ba5b471 at 028f71efa (lock-free, out w4h-28-mutants-028f71efa, exit 0; snapshot removed). Each mutant RED by assertion, by name:
- d8b1a6c05: m-d8b1a6c05-unusable-dropped (the unusable return disabled) 75/5 "a stored login that cannot be used is named as unusable..."
- 11114bea1: m-11114bea1-readiness-error-as-not-configured 76/4 "an error reading the credential is a readiness error with its deepest class and code, never "not configured""
- 0cd2c83e1: m-0cd2c83e1-account-id-unmasked 21/3 "the account id is masked to its last four characters"
- ad2f309ae: m-ad2f309ae-dry-run-writes 20/4 "--dry-run prints the summary with dryRun:true..." and both dry-run cases
- 140567e30: m-140567e30-port-unchecked 6/1 "a missing option, a bad port, a folder outside /run/user, or an unreadable file is refused by name"
- 8910cfd8f: m-8910cfd8f-prep-bound-4mib 27/2 "a package whose artifacts exceed 4 MiB prepares..." (+ AW ceiling mutant at the head)
- 7929ab652: m-7929ab652-host-tokens-small 6/1 "generate's model spend leaves freeze and the protected checks admissible"
- e14886409: m-e14886409-oldest-release 2/1 "the newest release WITH the expected source digest is picked..."
- 3d706b9e2: m-3d706b9e2-api-host-unmapped 4/1 "the wildcard is listened on, the proof calls loopback..."
- 07f431527: m-07f431527-model-pin-dropped 54/1 "the deployer writes the fleet's model pin into the startup document..."
- b6c3f846d: AR-1 ar1-define-removed RED, AR-3 ar3-sdk-code RED and ar3-contract-code RED (Addendum AV, at 8d9234f24; relock tests) and
  f2-literal-back RED at 028f71efa (relock.ts).
Plus the case-list condition (all 67 void names listed after I-1): open on one name (the fleet case), with integrator-5.
- I-1 OK (2026-10-16, validator-8): warn-cases.txt 8990c50d85384866 (148) and warn-cases.derived.txt 34d71b1acc335878 (145):
  tools/case-list-check.py fb08553d182efdff at 028f71efa: no escape; all 148 lines match a test title; every void name covered except
  the renamed codex case (0cd2c83e1's title, replaced in ad2f309ae; all 24 codex titles at the head listed). My earlier "fleet case
  missing" was MY error: w4h28-void-cases.txt cut names at 140 characters, and the check tested only "list line in void name"; the
  full title is line 37 (integrator-5). Checker fixed to test both directions. OK for the hold launch.
- Void file regenerated without truncation (w4h28-void-cases.txt 69c6a46d9563e561; the cut copy kept as
  w4h28-void-cases.truncated-d57ae94d8ab40f9b.txt): the checker on warn-cases.txt 8990c50d85384866 at 028f71efa: 1 miss, the renamed
  codex case only (successors listed). Merge commit landed: 74f91675c, tree a22da292327f... (= my recomputation), parents b7dbd9210 +
  028f71efa, author and committer the <USER> noreply address.

## Addendum BC (2026-10-16, validator-8): integration hold 1 (merge 74f91675c) HEAVY DONE status=1 — read raw; rulings; re-run checks
Read (w00/w4h-merge/w4h-28-reference-run, before the move to hold-run1/): "HEAVY DONE status=1 dirty=0 07:52:59Z"; two non-zero legs:
(1) unit-packages--ezcorp-factory-orchestrator-test-gateway-activities-test-ts exit=1 "2 pass 10 fail": `bun test` on a node:test file
    ("TypeError: request.socket.getPeerCertificate is not a function", 4 named cases), while orchestrator-v8-node24141,
    orchestrator-package-test and orchestrator-node are exit 0 with 101/101 and gateway-activities-case exit 0. RULED (team-lead): a
    list/leg-form defect of the integrator (unit.txt held a Node-canonical test).
(2) w4h28-red-first-cases exit=1: 148 x "CASE PASS"; the binding changed-test-lines sub-check: "src/__tests__/credential-store-
    bundled.test.ts: file 17/19 lines hit; added lines 27, instrumented 19, uncovered 2 -> [21, 22]" (the fixture store's read and
    list methods: never called in the case run). RULED (team-lead): a W4H-28 finding; root fix by the owner (no coverage-ignore); re-freeze.
Checks at the re-run (in addition to Addendum BA's six): no unit.txt entry is a Node-canonical test (factory_orchestrator_test_files /
the package's test/ dir), and every such file is in a Node leg's junit or log ("ℹ pass" lines name it); the owner's fix makes lines 21-22
(or their successors) execute in the case leg's lcov (DA > 0), by a real call path, not a test that calls the fixture by hand only to
cover it unless that call asserts behaviour; the delta at the new head re-verdicted by me (identity, the changed files only, the
invariant legs, the case-check sub-check on a copy).
- Fix for hold-1 red (2) read (2026-10-16): 5deb91a25 (test only; author/committer the noreply address): the fake store in
  credential-store-bundled.test.ts keeps only read() (records the requested id, returns the stored credential); list() and modify() removed
  (getAuth with a token valid 1 h against a 60 s minimum never refreshes, so neither ran); a new assertion requested == ["openai-codex"];
  the derived key == the stored access token is unchanged. Checks at the re-frozen head: identity; only this file changed; the test 1/0;
  the case leg's lcov for the file with no instrumented line at 0 (DA > 0 for every read() line); my mutant: read() returns undefined ->
  the test RED by assertion; the 3193e78b3 red_parent stays RED (the head's test on the parent tree).

## Addendum BD (2026-10-16, validator-8): delta ACCEPT at 5deb91a25
verdict-w4h-28.txt 5e6aa49165a1e8ff (delta section on top; earlier text in verdict-w4h-28-before-delta-5deb91a25.txt). Follow-up
w4h-28-delta-5deb91a25 (followup-w4h-28-delta.legs 1a78eb48f3747662): only the test file changed; 1/0; its own lines all hit (21
instrumented, 0 zero-hit; read() 23-25 hit); m-read-returns-nothing RED; 51 invariant legs green; identity 40 commits clean. Owner's final
legs at 5deb91a25 (summary 4ad2ccd51bf84785) worst rc=0. Next: the re-prep at 5deb91a25, the new merge commit, my six hold checks.
- Re-freeze at 5deb91a25 (owner): report.txt 5323ae2e6f4fcf38; pending-lesson d420c86888578b24; summary 4ad2ccd51bf84785 (= my read).
  Mirror /home/<USER>/work/EZCorp/factory-evidence-mirror/w4h-28/ (outside /tmp): manifest w4h-28.sha256sums ce7496ecee88e501; my check
  08:3xZ: sha256sum -c clean (rc 0) and diff -rq against evidence/w4h-28 identical.
- Six-check tool for the hold: tools/hold-six-checks.py 5840ce6a7a9c5ad3 (read-only on the record). Red first on hold 1 (hold-run1,
  74f91675c): 1-4 NOT OK (heavy.exit 1; the gateway-activities unit leg and the case leg exit 1; "NOT all covered"), 5 OK, 6 NOT OK (207
  unit legs vs today's 206 list: hold 1 ran the old list holding the Node-canonical file). Merge 7e5365696 (tree 36fe098c6, parents
  b7dbd9210 + 5deb91a25, noreply) verified read-only; I run the tool on the hold's record when its heavy.exit (newer than 09:28:48Z, the
  last heavy section naming 7e5365696) exists.
- Check 7 added (team-lead): image legs. hold-w4f.sh line 51 runs six image legs through w00/image-leg.sh only when the merge touches
  `(^|/)Dockerfile[^/]*$|^deploy/factory/Dockerfile`; a skip writes no image leg. My git diff --name-only b7dbd9210 7e5365696: 0 matching
  files. Tool hold-six-checks.py 87f80c09318ad0a5 now also checks: no image-* leg in the record when no Dockerfile changed (six image legs,
  all exit 0, when one did). image-leg.sh (deleted) is required, with my per-file OK, before any hold of a Dockerfile-touching merge.
- OOM kill at 09:50:03Z (team-lead's read) MAPPED and judged EXPECTED (2026-10-16, validator-8): the running hold's section (=== heavy
  09:33:24Z, HEAD 7e5365696, index-tree 36fe098c6) shows unit-packages--ezcorp-extension-runner-tests-podman-integration-test-ts START
  09:47:43Z END 09:50:03Z exit=0 "19 pass 0 fail". Its last test, "kernel PID, temporary storage, memory and descendant cancellation limits
  hold" (podman.integration.test.ts:422 at 7e5365696), starts a guest with memoryBytes 128 MiB whose "oom" action allocates until killed and
  ASSERTS the request rejects and runner.inspect's diagnostics hold code "memory_limit". The kernel record matches (memcg constraint in a
  libpod scope; bun, anon-rss 127040 kB under the 128 MiB limit; UID 231069 = a container subordinate id). Hold 1 shows the same kill at
  07:30:29Z for the same leg (END 07:30:30Z, 19/0). Not a masked failure.

## Addendum BE (2026-10-16, validator-8): integration hold verdict OK (section 59b270a1395e941a)
Seven checks OK on the hold run (heavy-batch.log lines 755-1505; heavy.exit 0); image skip confirmed; two memory kills (09:50:03Z podman
integration unit leg; 10:02:48Z extension-runner package test) mapped to the by-design "oom" case of podman.integration.test.ts:422, both
legs green. verdict-w4h-28.txt has the hold section on top. OK to publish 7e5365696.
- Receipts pre-judgment (2026-10-16): staged list db5af64e474c74fa (now receipts-sources.prepublish.txt; the publish wrote receipts-sources.txt
  d2b49eb49eb3a790, 271 lines): 268 unique names, all sources exist; batch-hold1.log 513a5cb1f6b1e123 = lines 1-754 and batch-hold2.log
  59b270a1395e941a = lines 755-1505, concatenated = heavy-batch.log efffb814e8bd4aa5; covers my hold verdict's records except heavy.exit,
  unit.txt, pg.txt (recommended additions). tasks-record-w4h-28.staged.md 6b822662b5abd97f = docs-draft-v10.md bca742b5542518d6 lines 132-153;
  placeholders <W4H-28-MERGE>, <W4H-28-RECEIPTS>, <W4H-28-VERDICT> (my verdict now 7cfd6fe2571297c9).
- RECEIPTS CHECK (2026-10-16, validator-8): cc6bfe54b (receipts) and 99b9c9630 (tasks) OK. cc6bfe54b: 271 added receipts under
  docs/validation/factory/wave4/, each byte-equal to its source in receipts-sources.txt d2b49eb49eb3a790 (0 differ); the one modified file
  SHA256SUMS gains 271 lines and loses 0 (append-only), each line equal to its committed receipt's hash. 99b9c9630: only tasks/todo.md, +22
  -0, equal to tasks-record-w4h-28.staged.md except the placeholder lines: <W4H-28-MERGE> = 7e5365696, <W4H-28-RECEIPTS> = cc6bfe54b,
  <W4H-28-VERDICT> = "ACCEPT at 5deb91a25 and OK to publish on the hold record (verdict 7cfd6fe2571297c9; hold 246/246 legs status=0,
  2026-10-16 09:33-10:12Z)" (longer than the hash; every fact true); note: the draft's "Addenda A to AN" is stale (my plan runs to BE).
  lessons.md unchanged. Identity: <USER> noreply on both. gate-integrity at 99b9c9630: default, vs 7e5365696 and vs b7dbd9210 PASSED
  (follow-up w4h-28-publish-99b9c9630). The addendum receipts commit (heavy.exit, unit.txt, pg.txt) is judged when its sha arrives.
- Receipts addendum c8ae394ca OK (unit.txt acc424932034e7ad and pg.txt f5353846a9b28973 equal to their sources; SUMS +2 -0; heavy.exit already
  in cc6bfe54b as w4h-28-merge-heavy.exit.txt; noreply). All three receipt commits OK: push may go.

## Addendum BF (2026-10-16 ~14:20Z): post-publish hosted red (ci 38887660827 at c8ae394ca) and the follow-up form (pre-judged)
Fact (my read): src/__tests__/credential-store-bundled.test.ts at c8ae394ca writes the bundle with Bun.build into mkdtemp(tmpdir())
(:12, :16) and imports it (:18); hosted per-file coverage counted that /tmp path as a source (75.91% < 90) and reported "MISSING REPORT:
crap". My hold OK (7cfd6fe2571297c9) did not see it: the local per-file gate's file set differs from the hosted one.
Form (owner follow-up from the integ head, red first) is measurement correctness, not a lowered gate, if ALL hold:
- F1 the rule is "no path outside the repository root enters the merged lcov" (configuration or merge step), never a name pattern
  for this test; a test: the merged lcov of a run that imports an outside-root file holds no outside-root path (RED on c8ae394ca);
- F2 a mutant that widens the rule to drop an in-repo file (e.g. src/**) turns a test RED: no repository file is excluded;
- F3 the "MISSING REPORT: crap" cause is named from the hosted log and fixed at its root (not a skipped report), with its own red;
- F4 parity (integrator): the local per-file gate uses the hosted script and file set; proof = the local gate RED at c8ae394ca with
  the same 75.91 class of finding, GREEN at the follow-up head.

## Addendum BG (2026-10-16 ~16:45Z): the follow-up merge prep 38ec686d8 on fef0d7d2a judged
Folder w4h-28-hcf-38ec686d8-on-fef0d7d2a: config.sh 3af1910a4c698d7f (BASE fef0d7d2a, TREE 540b8f098 = my rerere-off merge-tree); the merge
diff byte-equal to diff(c8ae394ca, 38ec686d8); hook list e975db7b19767e74 (5); unit.txt 3cdd678c88de0c20 = the 51 invariants + the 5 hook
tests; guard 2e49e0ffddf84113 (41); expected-main and expected-base both 99c49be48fbf9679 (scripts/merge-lcov.ts only); shared w00 file
e3b0c44298fc1c14 untouched; commit-msg 296666f2d2640aab. Staged: launch.sh.new 698cfe9d4b7ccc10, commit-locked.sh.new 8136b0a1a9cccf6b,
hold-own-pg.sh.new 5c0951e25d09c88a = W4H-33's installed files with only path, labels and comment words changed: OK.
extra-legs.sh.new 47b0b84a45bf1ed0: NOT YET — add the case leg (case-check v9 "$M" "$D") with warn-cases.txt = the 9 new test names of
coverage-outside-repo.test.ts and quality-report-producers.test.ts and whole-files.txt = coverage-gate, gate-scripts, merge-lcov-shard-vote:
the named cases must PASS at the merge and every changed test line must be covered (the patch gate covers source lines only). Red first is
already shown (owner logs by assertion; my mutants), so no red-on-base list is needed.
- Addendum BG closed (2026-10-16 ~17:10Z): extra-legs.sh.new e8c7a9c0220d4a7f OK (static legs + `NOTEST=1 leg w4h28hcf-cases ... case-check.sh
  "$M" "$D"`; no folder path); warn-cases.txt ca2c4d4458407ae3 (9): the 5 coverage-outside-repo names = the source; the 4 quality-report-
  producers names each match exactly ONE junit name in my run at 38ec686d8 (junit names carry the job prefix "Per-file coverage gate: ");
  whole-files.txt 7f7491563bf90aa2 is informational (case-check v9 does not read it; it runs every hook-mapped test file, the 3 changed ones
  included, and checks their changed lines). The prep and trio OK stand: the commit may go.
- Follow-up commit try 2 OK (2026-10-16 ~15:30Z): merge ec092aa7598687702e3367c7a7b42b055876d903; commit.exit 0 (15:25:10Z); tree
  540b8f098 = TREE; parents fef0d7d2a, 38ec686d8; <USER> noreply; identity fef0d7d2a..ec092aa75 5 clean; message byte-equal to commit-msg.txt
  296666f2d2640aab; diff(fef0d7d2a, merge) byte-equal to diff(c8ae394ca, 38ec686d8); hook full-run EZ_PRECOMMIT_TEST_MAX=5,
  hook-mapped-staged = the list, 5 files 18/5/254/18/4 tests each "0 fail"; FAST DONE status=0 (web-check green); commit.sh
  22db59d4e7eb94e0 (rerere off), stage.log "Automatic merge went well", 0 previous-resolution lines; integ/w00 fef0d7d2a, HEAD ec092aa75,
  0 changed files. Try 1 kept as .try1 (memory refusal). This OK is the hold trigger.
- Follow-up publish, receipts and tasks OK (2026-10-16 ~16:10Z; verdict-w4h-28.txt is held at 6c56008a5c4cc877 until the push, so the body's
  named hash = the receipt): integ/w00 = b0b7bedf1 (fef0d7d2a -> ec092aa75 at 15:39:10Z, then 8d38db465, b0b7bedf1); identity
  fef0d7d2a..b0b7bedf1 7 clean. Receipts 8d38db465 (tree 059a7c356df5822c): receipts-sources.txt 81a5ab0cf67b2402, all 115 receipts
  byte-equal to their sources, the commit holds exactly those + SHA256SUMS (+115, append-only, each line = its receipt, now
  4fb5e09b901f7b46); w4h-28-hcf-validation.txt = 6c56008a5c4cc877; owner report c4a3cd0a74771505; foreign-sources 87785d2b469d808a; cases
  fae0672320317f0f; identity 115 clean; gitleaks 0; merge.json 6cf5cca39ac862b8. Tasks b0b7bedf1: lessons.md +14 -0 only; both tasks files
  byte-equal to MY dry run (r2-check/d1) at fef0d7d2a (= 8d38db465's tasks): block 3 once, directly before "#### Owners".
- followup5c 7997187f568d33c4 named for the follow-up push (2026-10-16 ~16:20Z): publish line = my reads (tasks commit b0b7bedf1, push carries
  b0b7bedf1); only <HOSTED-COMPARISON-3> open; identity clean; 0 '@'. Earlier drafts: ca6c258e (P1/P2), 427bb2cd, c8fb4f6a, c31d687e (stale head).
- SUPERSEDED: the named push body is followup5c 36a18afab8ff17c9 (= 7997187f + my tasks-line wording; byte-equal claim verified); push14 had
  not run, its scripts bind no body hash. Owner asked to freeze the file until the HOSTED-COMPARISON-3 fill.
- Follow-up push (push14) OK (2026-10-16 ~17:00Z): body CONFIRMED 36a18afab8ff17c9 at 15:47:43Z after w4h-36's FINAL line; the disk gate held
  the job 15:49-16:53Z; push.log e1b2b4f566f0f7d2 "fef0d7d2a..b0b7bedf1 feat/factory-platform-followup-3", exit 0 at 16:55:03Z (push.exit 0);
  reads: before 15:49:03Z followup-3 fef0d7d2a, main 934531e2e; after 16:58:14Z followup-3 b0b7bedf1, main 934531e2e; remote-heads-diff
  = only the followup-3 line; my bounded read 16:58:59Z agrees. identity-push.txt 63a11b230e037e0c (7 clean); config baseline.
  pr-body-applied-5c = pr-body-live-5c = 36a18afab8ff17c9; PR 341 OPEN at b0b7bedf1; d6a8a263 not applied. Hosted: ci 38935662589.
- Hosted ci 38935662589 at b0b7bedf1 (2026-10-16 16:55:08-17:26:42Z), read by me from push14/ (5 files, hashes = the integrator's): FAILURE,
  59 jobs: 54 success, 3 skipped, 2 failure. FIXED vs 38919935083: Per-file coverage gate (the follow-up works on hosted). NEW red: Gate
  integrity, exactly 1 finding "coverage gate tool changed (M): scripts/merge-lcov.ts" = the ruled set of both per-folder expected sets;
  it needs the gate-change-approved label (the user's decision). Class A precheck and its 3 class-B skips unchanged. deps-audit success.
- followup5c 5b628b8ac128f917 CONFIRMED for the PR 341 re-apply (17:34:14Z, on w4h-36's FINAL line): d6a8a263 + the "Hosted, this push" line =
  my read of ci 38935662589 and the 5 push14 receipt hashes; 0 tokens; identity clean.
- PR 341 body re-apply verified (17:38:19Z): pr-body-applied-5c-final = pr-body-live-5c-final = 5b628b8ac128f917; pr-view 956b5060fec05512 head
  b0b7bedf1 OPEN; no push, no ref move.
- Follow-up 2 extra mutant (team-lead's ask): the test's child check weakened (the orphan case's `expect(await settled(...)).toEqual([])`
  removed) passes 2/0 even with b0b7bedf1's gateway: the check is the load-bearing assertion (my EOF-ignored mutant is RED by it).
  No gateway of mine left after the runs (count 0).
