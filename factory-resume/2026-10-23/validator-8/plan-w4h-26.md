# validator-8: W4H-26 validation plan (prepare only; wait for the owner's R1 design and team-lead's ruling)

Package: the started application can run a reference-code task. (1a) The composition root registers the reference-code
runners at startup. (1c) A product path installs the built-in runner packages as installed releases.
Brief w00/briefs/w4h-26.md (sha b72ca3bf44fe4140). Base origin/main 1981febd2. Branch wp/w4h-26-runner-wiring.
Out of scope: the catalog driver (G8d stays BLOCKED by name).

## Facts read at 1981febd2 (for the design review)

- F1: scripts/verify-factory-reference-code-journey.ts registers nothing and starts no guest. It calls the product
  functions in-process on the host (snapshot, native generator, freeze, checks, review). The brief's "the same
  registration the host-side script does" has no source to copy. The new code is the first registration.
- F2: REFERENCE_CODE_IMPLEMENTATIONS (src/factory/reference-code/pack.ts:58) maps five exports to the product functions.
  REFERENCE_CODE_EXPORT_MANIFEST_NAMES maps each export to its v4 manifest. A guest that runs them needs a v4 package
  with these bytes in a pinned image. That package does not exist as a product artifact today.
- F3: POST /api/factories/projects/:projectId/packages (src/api-registry.ts:110) only binds an INSTALLED v4 release
  (interactive tenant-administrator session). The graph proof (scripts/factory-graph-proof/guest-package.ts:84-163)
  builds its guest package and writes the release and installation records itself ("harness-supplied", W02), then binds
  through the product's preparations.bind. That record write is the step with no product path.

## Legs (snapshots by git archive outside the evidence folder, removed after; podman only; own PostgreSQL for any DB leg)

V1 E2E reproduction on main (before any fix is read): start the composed application as the W09 startup tests do (or the
   Compose profile), submit a reference-code task through public HTTP, and capture the refusal and its file:line.
   It must equal the owner's R1 refusal and W4H-25's console refusal. Different = finding.
V2 Design and contract: the install path is a path the contracts already allow. I read the named contract section and
   check: (a) no new route in src/api-registry.ts, or a new route only with team-lead's ruling and its audit entry;
   (b) the install runs under the same authority as the existing bind (session scope, tenant administrator, receipts);
   (c) boot-time install, if chosen, is idempotent across restart and refuses changed bytes for the same release id;
   (d) it runs only behind the factory flag (factory off = no registration, documented 404 unchanged).
V3 W02 pinning and isolation of the guest image: the installed release's artifact digest equals the built package bytes
   (recomputed by me); the runner profile is rootless-podman-v4; the base image is a digest pin in the repo; the policy
   digest matches; no host mount beyond the contract; no network unless the contract allows it; podman only.
V4 Red-first, both proofs: on a main snapshot plus the new tests only, the startup composition test is red
   (some REFERENCE_CODE_IMPLEMENTATIONS entry not registered) and the API-path test is red with the V1 refusal.
   On the head both are green. A red for another reason (compile error, missing fixture) does not count.
V5 Startup test strength: it composes the real application (not a hand-built registry) and checks EVERY export of
   REFERENCE_CODE_IMPLEMENTATIONS by name, so a new export without registration goes red. Mutant: drop one entry.
V6 API-path proof: the composed application admits, dispatches and executes the task in a pinned guest container with the
   contract's test provider or a shipped fixture generator. No real-model call (I check that no provider credential is
   read and the provider id is the test one). The guest container id and image digest are in the record.
V7 Mutants (each must make a named test red; measure steps): remove the registration; register under a wrong manifest
   name; skip the install at boot; install with a different digest; accept changed bytes for the same release id;
   register with the factory flag off; widen the install authority (no session scope check).
V8 Gates on the head: typecheck (tc rule; in-lock at >= 12 GiB), lint, boundaries, the hook-mapped suites, the guard set,
   CRAP, gate-integrity main leg = exactly 0 findings (any finding = STOP), 100 percent of changed lines exercised
   (lcov on changed lines; scripts/ lines shown by my own trace if outside the gate's scope).
V9 Records: report.txt shas, tasks/factory/w4h-26-GATES.md, tasks/todo.md lines, pending-lesson.md; no secret in evidence.

## Verdict
ACCEPT only if V1-V9 are green. Any red-first proof that fails for the wrong reason, any new unaudited route, or any
unpinned guest image = REJECT with the finding.

## Addendum A (2026-10-13): team-lead's four R1 rulings; scope D1-D7

V1 status: the owner's reproduction (evidence/w4h-26/r1/) is read and matches 1981febd2.
- pass1: "Factory startup configuration is incomplete. Invalid: runnerProfiles.profiles[0..3], runnerProfiles.profiles";
  startup-config.ts:500 (pinned profile keys) and :801 (unique resourceClass).
- pass2c: factory_native_package_untrusted (native-runner-policy.ts:141) and factory_package_release_unavailable
  (package-preparation.ts:219).
- pass1's 97 orchestrator failures are "connect ECONNREFUSED" after the harness did not start. They are a
  consequence, not the swc defect (W4H-27 D1). I still run V1 myself on a main snapshot.

Ruling 1, no host-side registry. V5 changes. Each REFERENCE_CODE_IMPLEMENTATIONS export ships as a tool of a v4 runner
package, with per-export guest entries in runner-packages.ts. Check: a test enumerates the exports and finds one guest entry
and one profile for each, by name (a new export without an entry goes red). No host-side map of runners exists at the head.
Mutant: drop one entry.

Ruling 2, D6, the new INTERNAL host-plane operation on the W01b mutual-TLS host-launch service. Closest read:
H1 Contract first: the contract row is in the contracts document, and its commit comes before every code commit of D6
   (git log order on the branch). The code matches the row field by field (inputs, outputs, errors, idempotence key).
H2 Not public: no new entry in src/api-registry.ts and no HTTP route. Reachable only on the mTLS host-launch listener.
   Identity: only the product's private service identity may call it. Another valid client identity (a runner, a
   tenant, the wrong installation) is refused by name. Mutant: skip the identity check, and a test goes red.
H3 Digests, both sides: the product sends the release source and the binding's expected source digest. The supervisor
   recomputes the source digest and refuses a mismatch before any build. The product writes the preparation receipt
   only when the returned artifact digest equals its expectation. I recompute the artifact digest from the store bytes.
   Mutants: drop the supervisor comparison, and a test goes red. Drop the product comparison, and a test goes red.
H4 Idempotence by (release, generation, source digest): the same key twice gives the same artifact digest with ONE build
   (count builds). The same release and generation with another source digest is refused. A crash after the build and before the
   receipt recovers without a second effect or a second receipt.
H5 W02 for the build: the build image is pinned by digest; the network is none except the pinned registry (podman
   inspect of the build container); time is bounded (a forced timeout gives a named failure and no receipt); the build
   runs in the supervisor's own leased store (released after); rootless podman; no host mount beyond the lease.
Ruling 3, D4 project scope: a global installation satisfies project scope only through extension_project_bindings
   naming this project, with the active release and generation, through the existing audited route. Tests (each red
   when the check is removed): no binding is refused; a binding to another project is refused; a stale release or
   generation is refused.
Ruling 4, scope D1-D7:
- The startup-config profile rules accept the shipped profiles (V1 pass1 goes green for the right reason).
- Boot install through the existing v4 lifecycle only behind EZCORP_FACTORY_ENABLED. Off: no install, no service, the
  documented 404.
- The package-preparation scope.
- The package-preparation runtime role has least privilege. I read its grants, and nothing beyond its tables is granted.
- D6 as above.
- Proof: snapshotRepository runs in the pinned guest on the shipped fixture repository. The guest container id and
  image digest are recorded. Its output digest equals the direct product function on the same fixture.
- Out of this package: the guest model adapter, the repository-read broker operation, the toolchain claims lane, and
  the catalog driver. Each is named as open in the gate file.
V7 mutants grow by: identity check skipped; supervisor digest check dropped; product digest check dropped; the
idempotence key without the source digest; the build network opened; the timeout removed; the project-binding check
dropped; the flag check dropped; one guest entry dropped.
