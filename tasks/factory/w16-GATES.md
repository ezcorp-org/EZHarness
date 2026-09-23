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
| `src/factory/pool/readiness.ts` | Not in the section 16 table; last changed by the coordinator's composition work (W09) | Record `factory.pool-readiness.v2` names `poolId` only; a foreign pool is `factory_pool_foreign` |
| `src/factory/service-readiness.ts` | Not in the section 16 table; coordinator (W09) | `installationId` optional; a shared service's record carries none |
| `src/factory/service-probes.ts` | Not in the section 16 table; coordinator (W09) | Pool and supervisor probes match on `poolId` and `hostId` only |
| `src/factory/runner/supervisor-process.ts` | Not in the section 16 table; Terra runtime (W01) | Readiness writer no longer passes the installation |
| `src/factory/pool/process.ts` | Terra deployment (W16) | Identity row keyed by `pool_id`, upgraded in place; W18a-2 is splitting its config parser, so the rest waits for that merge |

## Gates

- [ ] G1: The seven C12 steps run in order into four phases, each with owner, attempts, resources (references only), and failure record; `through` stops at the phase its steps establish; a rerun verifies and re-creates nothing.
  CHECK: `bash /tmp/factory-platform-evidence/w16/repro/pg-provisioning.sh` under the heavy lock
  EXPECT: exit 0
  EVIDENCE: pending

- [ ] G2: Every step fails before and after its effect, is recorded `failed` with its code, serves no traffic while partial, and the rerun resumes at that step; a crash inside role or database creation of either pair is recognised, never adopted blindly; a foreign same-named resource is refused and not dropped.
  CHECK: same producer as G1
  EXPECT: exit 0; 14 fault cases plus 4 crash cases (two product, two on the host's pool pair)
  EVIDENCE: pending

- [ ] G3: Step 4 generates distinct application secrets per installation, a raw 32-byte master key outside every grantable root, and a wrap the Node loader boots from; a printable or decoded application secret is refused as a master key; a copied secret is refused as shared.
  CHECK: `bun test --timeout 60000 ./src/factory/provisioning/secrets.test.ts` and the G1 producer
  EXPECT: exit 0
  EVIDENCE: pending

- [ ] G4: Scoped delivery: the orchestrator alone receives the wrapped key and master key; the shared supervisor's and pool's deliveries hold no tenant secret; every rendered document is accepted by its process's own parser.
  CHECK: `bun test --timeout 60000 ./src/factory/provisioning/deployment.test.ts` and the live proof
  EXPECT: exit 0; the live proof's delivery checks pass
  EVIDENCE: pending

- [ ] G5: First-admin invitation gates first-run setup; consent is a separate session-only act whose grants, record, and audit entry commit together or not at all.
  CHECK: `bun test ./src/__tests__/factory-installation-bootstrap.test.ts`, `tests/postgres/factory-installation-bootstrap.test.ts`, web `api-auth-setup-invitation`, `api-installation-bootstrap`
  EXPECT: exit 0
  EVIDENCE: pending

- [ ] G6: Trusted ingress identity: a request whose Host is not the installation's, or that lacks the ingress's installation header, is refused 421; the ingress refuses SNI and Host mismatch.
  CHECK: web `hooks-server-ingress-identity`, `ingress-identity.test.ts`, `ingress.test.ts`, and the live proof
  EXPECT: exit 0
  EVIDENCE: pending

- [ ] G7: Ten separate installations start through the Compose profile on rootless Podman with distinct identities and credentials, all admitted to ONE shared pool and ONE shared supervisor, are ready through their own hostnames, are isolated from each other at the database, store, Temporal, mesh, and session layers, and complete human bootstrap.
  CHECK: `bun /tmp/factory-platform-evidence/w16/repro/prove-selfhosted.ts <fleet.json> <out.json>` under the heavy lock
  EXPECT: `outcome: passed`
  EVIDENCE: pending

- [ ] G8: The fleet's one supervisor runs outside every container as a host systemd unit and holds no tenant secret; no installation runs its own pool or supervisor; no harness container has the runtime socket, a device, privilege, or a writable root.
  CHECK: the live proof's separation checks; `kubernetes-profile.test.ts` for the hosted profile
  EXPECT: pass
  EVIDENCE: pending

- [ ] G9: Credential rotation makes the superseded credential fail before it returns; teardown holds the route first, withdraws every login, revokes the namespace identity, leaves the shared host's trust, keeps the databases and the release archive; purge needs an approval an administrator issued in a session and closed work, keeps the archive key in escrow, and with host decommission leaves no role or database of the fleet on the cluster.
  CHECK: the G1 producer and the live lifecycle proof
  EXPECT: pass
  EVIDENCE: pending

- [ ] G10: Canary-first upgrade waves in C12 order; a migration failure in the canary stops the wave and walks it back in reverse; a good wave completes; rolling code back onto the newer additive schema boots.
  CHECK: the G1 producer (upgrade ledger) and the live wave proof with two candidate builds
  EXPECT: pass
  EVIDENCE: pending

- [ ] G11: The operator-only control plane publishes directory fields only, has no product route, refuses an unlisted operator certificate, and accepts long operations as 202.
  CHECK: `bun test --timeout 60000 ./src/factory/provisioning/control-plane.test.ts`
  EXPECT: exit 0
  EVIDENCE: pending

- [ ] G12: Kubernetes manifests are schema-valid and admitted by a real API server; the tenant namespace refuses a privileged and a hostPath pod; only the system namespace admits the supervisor. LABELLED: kind smoke, not a hosted pass.
  CHECK: kubeconform strict, then `repro/kind-smoke.sh` under the heavy lock
  EXPECT: 17 valid, 0 invalid; the two tenant probes refused, the system probe admitted
  EVIDENCE: `logs/kubeconform-synthetic.log` (17 valid, 0 invalid, strict, Kubernetes 1.31.0 schemas); kind smoke pending

- [ ] G13: GPU host profiles authorize devices only for their registered host; the production tier is refused without evidence for all eight criteria; the local profile is unmet on every row.
  CHECK: `bun test --timeout 60000 ./src/factory/pool/gpu-host-profiles.test.ts`
  EXPECT: exit 0
  EVIDENCE: pending

- [ ] G14: Sweep per common.md after `git merge --no-edit integ/w00`.
  CHECK: typecheck, lint, boundaries, gate integrity, focused suites with coverage, PostgreSQL producers, new-file and patch coverage
  EXPECT: all green
  EVIDENCE: pending

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
| `orchestrator-build-id-versioning` | The orchestrator does not implement Temporal worker build-ID versioning; builds are retained at the image and release level |
| Production GPU, eight rows | `FACTORY_PRODUCTION_GPU_CRITERIA`, all unmet with the verdicts in `docs/factory-local-gpu.md` |

## Wiring to land after W18a-2

`src/factory/pool/process.ts` is held by W18a-2. The GPU host profile registry
is in `src/factory/pool/gpu-host-profiles.ts`; the pool process needs one line
after its config parse, plus the config field that names the declaration file:

```ts
const gpuProfiles = await loadFactoryGpuHostProfiles(config.resources.gpuProfilesPath, config.resources.gpuHosts);
```

The shared-pool ruling also leaves one change for that merge: the pool config's
`installationId` field, which a shared pool fills with its fleet's host ID
(`host:<fleet>`) and no longer stores, should leave `parseFactoryPoolProcessConfig`.
