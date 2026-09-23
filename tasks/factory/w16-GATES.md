# W16 — Complete provisioner and deployment profiles

Owner: Terra deployment. Branch `wp/w16-provisioning` from `integ/w00` at
`260855e57` (W09b merged). Evidence directory: `/tmp/factory-platform-evidence/w16/`.
Operator guide: `docs/factory-deployment.md`.

## Assumptions and rulings

1. **Shared pool and supervisor (coordinator ruling 2026-09-22).** One fleet
   host runs the one pool and the one host supervisor every installation
   shares (`src/factory/provisioning/host.ts`, `deploy/factory/compose/host.yml`).
   Each shared service's readiness record names its own identity (`pool.<fleet>`,
   `host.<fleet>`); every installation's startup document names those same
   identities; tenant scoping stays in the pool's client-certificate map. The
   earlier interim (a pool and supervisor per installation) is retired.
2. **Stores are used read-only.** The installations use the shared local S3
   pair and the proof PostgreSQL. The provisioner reads the stores' own
   identity files and verifies each credential's scope with HEAD requests only.
   It never starts, stops, or reconfigures a shared store. The product's own
   readiness probe writes one key under its tenant's `ordinary/readiness/`
   prefix; that is the product's behaviour, not the provisioner's.
3. **Seeded store identities cannot be revoked here.** Revocation needs the
   store's admin authority, which the provisioner does not hold on a shared
   store. Teardown destroys the private copies and records the named residue
   `storage_revocation_unsupported`.
4. **The gateway is a real process.** `src/factory/gateway-process.ts`
   composes the execution gateway over the installation's database.
5. **Kubernetes is manifests plus a kind smoke, labelled as such.**
6. **W15's namespace settings.** `factoryTemporalNamespaceArguments` is W15's
   (not yet in `integ/w00`); `temporal-namespace.ts` carries a stand-in with
   its name, signature, and output, and translates the arguments into the
   RegisterNamespace request. At W15's merge the stand-in becomes a re-export.
   The deployed restore proof is W15's after this lands; the host-minted pool
   token already carries `pool:restore:<tenant>`.

## Files changed outside W16's freeze ownership

Coordinator ruling 2026-09-22: approved for W16; the owner's package inherits it.

| File | Freeze owner | Change |
| --- | --- | --- |
| `src/factory/pool/readiness.ts` | Not in the section 16 table; last changed by the coordinator's composition work (W09) | Record `factory.pool-readiness.v2` names `poolId` only; a foreign pool fails closed with the one `factory_pool_unavailable` error and is reported only to the operator-side log |
| `src/factory/service-readiness.ts` | Not in the section 16 table; coordinator (W09) | `installationId` optional; a shared service's record carries none |
| `src/factory/service-probes.ts` | Not in the section 16 table; coordinator (W09) | Pool and supervisor probes match on `poolId` and `hostId` only |
| `src/factory/runner/supervisor-process.ts` | Not in the section 16 table; Terra runtime (W01) | Readiness writer no longer passes the installation |
| `src/factory/installation-startup.ts` | Not in the section 16 table; coordinator (W09) | The gateway liveness probe counts an HTTP error status as an answer, as its comment states; the transport raised it and no provisioned installation could become ready |
| `src/factory/pool/process.ts` | Terra deployment (W16) | Identity row keyed by `pool_id`, upgraded in place; after W18a-2, the config drops `installationId` and loads `resources.gpuProfilesPath` |

## Gates

- [x] G1: The seven C12 steps run in order into four phases, each with owner, attempts, resources (references only), and failure record; `through` stops at the phase its steps establish; a rerun verifies and re-creates nothing.
  CHECK: `bash /tmp/factory-platform-evidence/w16/repro/pg-provisioning.sh` under the heavy lock
  EXPECT: exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w16/logs/pg-producers-14.log` (provisioning 63 pass, gateway 1, bootstrap 17, pool 8; 0 fail), head db8acda26

- [x] G2: Every step fails before and after its effect, is recorded `failed` with its code, serves no traffic while partial, and the rerun resumes at that step; a crash inside role or database creation of either pair is recognised, never adopted blindly; a foreign same-named resource is refused and not dropped.
  CHECK: same producer as G1
  EXPECT: exit 0; 14 fault cases plus 4 crash cases (two product, two on the host's pool pair)
  EVIDENCE: same producer: every step faulted before and after, four crash cases (two product, two on the host pool pair), foreign role refused

- [x] G3: Step 4 generates distinct application secrets per installation, a raw 32-byte master key outside every grantable root, and a wrap the Node loader boots from; a printable or decoded application secret is refused as a master key; a copied secret is refused as shared.
  CHECK: `bun test --timeout 60000 ./src/factory/provisioning/secrets.test.ts` and the G1 producer
  EXPECT: exit 0
  EVIDENCE: `secrets.test.ts` in `/tmp/factory-platform-evidence/w16/logs/sweep-14.log` unit leg; live: ten distinct jwt, encryption, salt, masterKey (`/tmp/factory-platform-evidence/w16/selfhosted-14.json`)

- [x] G4: Scoped delivery: the orchestrator alone receives the wrapped key and master key; the shared supervisor's and pool's deliveries hold no tenant secret; every rendered document is accepted by its process's own parser.
  CHECK: `bun test --timeout 60000 ./src/factory/provisioning/deployment.test.ts` and the live proof
  EXPECT: exit 0; the live proof's delivery checks pass
  EVIDENCE: `deployment.test.ts` (100%); live: shared deliveries hold no tenant secret, wrap and master key reach the orchestrator alone (`selfhosted-14.json`)

- [x] G5: First-admin invitation gates first-run setup; consent is a separate session-only act whose grants, record, and audit entry commit together or not at all.
  CHECK: `bun test ./src/__tests__/factory-installation-bootstrap.test.ts`, `tests/postgres/factory-installation-bootstrap.test.ts`, web `api-auth-setup-invitation`, `api-installation-bootstrap`
  EXPECT: exit 0
  EVIDENCE: bootstrap producer 17 pass (`pg-producers-14.log`); web suites in `sweep-14.log`; live: setup refused without invitation, all ten bootstrap_complete

- [x] G6: Trusted ingress identity: a request whose Host is not the installation's, or that lacks the ingress's installation header, is refused 421; the ingress refuses SNI and Host mismatch.
  CHECK: web `hooks-server-ingress-identity`, `ingress-identity.test.ts`, `ingress.test.ts`, and the live proof
  EXPECT: exit 0
  EVIDENCE: live: Host/SNI mismatch 421, ingress bypass 421, forged proof 421 (`selfhosted-14.json`)

- [x] G7: Ten separate installations start through the Compose profile on rootless Podman with distinct identities and credentials, all admitted to ONE shared pool and ONE shared supervisor, are ready through their own hostnames, are isolated from each other at the database, store, Temporal, mesh, and session layers, and complete human bootstrap.
  CHECK: `bun /tmp/factory-platform-evidence/w16/repro/prove-selfhosted.ts <fleet.json> <out.json>` under the heavy lock
  EXPECT: `outcome: passed`
  EVIDENCE: `selfhosted-14.json`: outcome passed, 36/36 checks; image `localhost/ezcorp-factory@sha256:8dd32d36…`, revision db8acda26; ten installations on one shared pool and one shared supervisor

- [x] G8: The fleet's one supervisor runs outside every container as a host systemd unit and holds no tenant secret; no installation runs its own pool or supervisor; no harness container has the runtime socket, a device, privilege, or a writable root.
  CHECK: the live proof's separation checks; `kubernetes-profile.test.ts` for the hosted profile
  EXPECT: pass
  EVIDENCE: `selfhosted-14.json`: one active host unit, no per-installation unit or pool, no socket/device/privilege/writable root; `kubernetes-profile.test.ts`

- [x] G9: Credential rotation makes the superseded credential fail before it returns; teardown holds the route first, withdraws every login, revokes the namespace identity, leaves the shared host's trust, keeps the databases and the release archive; purge needs an approval an administrator issued in a session and closed work, keeps the archive key in escrow, and with host decommission leaves no role or database of the fleet on the cluster.
  CHECK: the G1 producer and the live lifecycle proof
  EXPECT: pass
  EVIDENCE: `lifecycle-14.json` 23/23: rotations, teardown withdraws login/namespace/route, shared host keeps serving the other nine, purge under a session-issued approval; no-residue PG test in `pg-producers-14.log`

- [x] G10: Canary-first upgrade waves in C12 order; a migration failure in the canary stops the wave and walks it back in reverse; a good wave completes; rolling code back onto the newer additive schema boots.
  CHECK: the G1 producer (upgrade ledger) and the live wave proof with two candidate builds
  EXPECT: pass
  EVIDENCE: `lifecycle-14.json`: bad canary stopped and walked back, good wave completed, rollback onto the additive schema booted everywhere, failed build retired

- [x] G11: The operator-only control plane publishes directory fields only, has no product route, refuses an unlisted operator certificate, and accepts long operations as 202.
  CHECK: `bun test --timeout 60000 ./src/factory/provisioning/control-plane.test.ts`
  EXPECT: exit 0
  EVIDENCE: `control-plane.test.ts` in the sweep unit leg (100%)

- [x] G12: Kubernetes manifests are schema-valid and admitted by a real API server; the tenant namespace refuses a privileged and a hostPath pod; only the system namespace admits the supervisor. LABELLED: kind smoke, not a hosted pass.
  CHECK: kubeconform strict, then `repro/kind-smoke.sh` under the heavy lock
  EXPECT: 17 valid, 0 invalid; the two tenant probes refused, the system probe admitted
  EVIDENCE: `/tmp/factory-platform-evidence/w16/logs/kubernetes-legs-14.log`: kubeconform 19 valid, 0 invalid (strict, 1.31); kind: server dry run exit 0, apply exit 0, tenant namespace refused the privileged and hostPath pods, system namespace admitted the privileged one. LABELLED: kind smoke, not a hosted pass

- [x] G13: GPU host profiles authorize devices only for their registered host; the production tier is refused without evidence for all eight criteria; the local profile is unmet on every row.
  CHECK: `bun test --timeout 60000 ./src/factory/pool/gpu-host-profiles.test.ts`
  EXPECT: exit 0
  EVIDENCE: `gpu-host-profiles.test.ts` in the sweep unit leg

- [x] G14: Sweep per common.md after `git merge --no-edit integ/w00`.
  CHECK: typecheck, lint, boundaries, gate integrity, focused suites with coverage, PostgreSQL producers, new-file and patch coverage
  EXPECT: all green
  EVIDENCE: `/tmp/factory-platform-evidence/w16/logs/sweep-14.log` at db8acda26 (integ/w00 merged at 39d9b744f; no newer integ commit): SDK builds, unit and PG producers with lcov, merge, new-file and patch coverage, typecheck, lint, boundaries, deployment locks, gate integrity, all exit 0

## Named readiness rows that stay open on this host

| Row | Why it is open |
| --- | --- |
| `storage_revocation_unsupported` | The shared stores' identities are seeded by their own operator |
| `same-host-not-independent` | The archive store shares this host's failure domain |
| `seeded-store-claim-cluster-scope` | A store claim is visible only to fleets whose databases share one PostgreSQL cluster |
| `temporal-archival-local` | The local Temporal archives to a file store inside its own container, which does not survive the container |
| `hosted-supervisor-readiness` | The product reads the shared pool's and supervisor's readiness from files a restricted tenant namespace cannot mount |
| `hosted-supervisor-address` | The startup document names the host services at 127.0.0.1; the hosted pool and DaemonSet are at cluster and node addresses |
| `hosted-ingress-snippet` | ingress-nginx 1.9+ disables the `configuration-snippet` annotation that sets the installation header |
| `hosted-host-identity-shared` | The Kubernetes supervisor DaemonSet holds one fleet-wide host identity (as the Compose fleet host now does too) |
| `gpu-profile-lease-consumer` | The pool validates GPU host profiles at start, but no lease path calls `factoryHeldAllocationDevices` to authorize devices from them |
| `orchestrator-build-id-versioning` | The orchestrator does not implement Temporal worker build-ID versioning; builds are retained at the image and release level |
| Production GPU, eight rows | `FACTORY_PRODUCTION_GPU_CRITERIA`, all unmet with the verdicts in `docs/factory-local-gpu.md` |

## After W18a-2 (landed at 8949b300b)

- The pool config no longer carries `installationId`: a pool serves every
  installation of its fleet, and its identity row keys by `pool_id`.
- The pool loads `resources.gpuProfilesPath` with `loadFactoryGpuHostProfiles`
  before its listener binds; a missing, unknown-host, or unproven declaration
  keeps it degraded as `gpu_profiles_unavailable`. Named gap
  `gpu-profile-lease-consumer`: no lease path consumes the loaded registry,
  because `factoryHeldAllocationDevices` (runner/attempt-wire.ts, W02) has no
  production caller.

## Waiting on W15's merge

W15 (round 2, `ef958511b`, not yet in `integ/w00`) makes a startup document
need three things before effect claims and attempt launches open:

1. `storage.archive` credentials: already declared by every rendered startup document.
2. A pool serving the checkpoint-barrier slot routes: the fleet host's pool runs
   the image's pool code, so it serves them once W15's code is in the image.
3. `temporalHttp` (endpoint and optional TLS): the local platform exposes
   Temporal's gRPC API only, through the mTLS/JWT gateway. Declaring it needs a
   namespace-scoped route to Temporal's HTTP API through that gateway. The
   current startup parser refuses the field, so it lands with W15's merge.
