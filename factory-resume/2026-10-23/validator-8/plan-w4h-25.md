# validator-8: W4H-25 validation plan (prepare only; wait for the owner's R1, then team-lead's GO)

Package: ONE full factory run with the real model gpt-6-luna through the started application (W10 G27).
Base origin/main 1981febd2; owner branch wp/w4h-25-full-run; evidence evidence/w4h-25/.
Judge: W10's pass line (docs/plans/2026-09-13-composable-factory-platform-completion.md:285):
"the remote draft PR contains the accepted complete tree and exact base parent; all protected failures block release;
all candidate generations and actual usage remain auditable."

## Risks known before the run (read at 1981febd2)

- K1: REFERENCE_CODE_IMPLEMENTATIONS (src/factory/reference-code/pack.ts:58) still has no user outside its own module.
  This is the W10c G8b finding: the started application does not register the reference code runners. A journey through
  the console can stop there. If the run passes, I find the code that registers them. Code changes route through
  integrator-5, and I validate them as code (tests, mutants, gates).
- K2: the brief asks for "a real catalog entry". G8d is BLOCKED (catalog_driver_not_implemented; referenceCatalogV1 has
  no driver) and needs G8c and W11 G15. I expect the catalog part to stop by that name, unless the owner shows a driver.
- K3: W10c R8 opened a remote draft PR (github:1368432892:pull:8) with the GitHub CLI credential. The W07 flags
  selectedRepositoryAppVerified and brokerOnlyNamespaceVerified were false. A remote draft PR is therefore possible
  without the W07 App, on the narrower CLI scope. I record which credential kind the run used.

## Legs (all read-only; no real-model call by me; no lock needed unless a leg builds; podman only)

L0 Freeze: hash every evidence file at start (sha256 list). Hash again at the end. Any change = STOP and ask.
L1 Secrets: grep all evidence (text and decompressed) for sk-, Bearer, token values, ghp_/gho_/ghs_/github_pat_, eyJ (JWT),
   refresh_token, access_token, id_token, and Authorization. A "token" key name with *** or a count is fine; a value is a finding.
   I never read ~/.codex/auth.json or gh hosts.yml.
L2 Identity: run.json ids (installation, tenant, project, run, every attempt, every node) are unique and consistent across
   journey.md, logs, the graph proof and the publication record. The timestamps follow the journey order.
L3 Through the app: the run started through public HTTP of the started installation (console job, screenshots, the HTTP
   request in the logs), not a host-side script. A host-side driver = G27 not met.
L4 One real run: count the provider generations in the record. Exactly one bounded run (every attempt of it listed).
   The model id is gpt-6-luna only. The credential kind is oauth. Usage <= the token budget the owner stated in R1. Enforced by the contract.
L5 Usage: usage.json equals the product's own accounting (journal operation usage and the task budget settlement)
   field by field: input, output, total, cost. The sources are the records the owner exported, or a read-only query of
   the owner's installation database (READ ONLY transaction) if team-lead rules that is allowed.
L6 Graph proof: every node's candidateOutput digest and journal rows match run.json. The infer operation carries the
   provider receipt digest and the measured usage of L5.
L7 Child bytes: recompute sha256 of every recorded child file and compare with run.json. The same bytes are present in
   the accepted complete tree (git blob ids from a git-archive snapshot outside the evidence folder; removed after).
L8 Tree and parent: remote draft PR read through gh api (read-only): isDraft true; the head commit's tree = the accepted
   complete tree sha; its parents = exactly [the tested base sha]; the base branch and body name that base; the branch is the
   encoded operation id. For a local publication: every object digest in the manifest = the accepted tree's blob, and the
   manifest digest = the record.
L9 Guests: every guest container's image = a pinned digest that is in the repo at the run's sha (git grep the digest);
   the runtime is podman. `podman image inspect` is used read-only if the image is present.
L10 Checks: every claim verdict (dependency-advisory, secret-scan, allowed-paths, protected-assets-unchanged,
   frozen-install, build, typecheck, declared-tests, protected-fixtures, supervised review) PASS with no unsatisfied claim.
   The release came after the last claim.

## Verdict

- PASS: L0-L10 green and a remote draft PR meets L8.
- The pass line part "all protected failures block release" is not proved by one valid run. I cite the existing negative
  fixture tests for it and say so. I do not count it as proved by W4H-25.
- Local publication only: the run is reported as "local publication proven, W10 pass line OPEN (remote draft PR)". It is not PASS.
- Any defect on the way: FAIL with the owner's root cause. I check each root cause against the code read-only.

Questions to team-lead (proceeding with the defaults if no ruling):
- Q1: may I query the owner's installation database read-only (L5)? Default: no; the owner exports the rows.
- Q2: local publication only = "pass line OPEN", not PASS. Default as written.
