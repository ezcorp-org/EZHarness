# Factory deployment and provisioning

This guide is for the operator of a factory fleet. It covers the two deployment
profiles, the seven provisioning steps, and the day-two work: rotation,
recovery, drain, upgrades, rollback, teardown, and purge.

The provisioner is `src/factory/provisioning/local.ts`. The operator entry is
`scripts/factory-fleet.ts`. Every command prints one JSON document. No command
prints a credential.

## What each profile proves on this host

| Profile | What it is | Proven here |
| --- | --- | --- |
| Self-hosted Compose | `deploy/factory/compose/installation.yml`, `host.yml`, and `platform.yml` on rootless Podman, and the shared supervisor as a host systemd unit | See the gate file's G7 evidence for the live ten-installation run |
| Hosted Kubernetes | `src/factory/provisioning/kubernetes-profile.ts` renders the objects, `kubernetes-target.ts` applies them; fleet settings `profile: "kubernetes"` with a `kubernetes` block | See `tasks/factory/w4h-35-GATES.md` for the local kind proof. A local proof is not a hosted pass |

The hosted profile runs the same seven steps through the same provisioner.
Only step 5's target, the fleet host's services, the addresses a pod uses, and
the ingress differ (`src/factory/provisioning/fleet-profile.ts`):

- Step 5 applies the installation's objects in one server-side apply. Each
  service's Secret is filled from its private delivery directory and sent to
  kubectl on standard input only.
- The fleet host runs the shared pool as a Deployment and the supervisor as a
  DaemonSet in the fleet's system namespace. Only the DaemonSet is privileged and
  holds the container runtime socket and the host identity. It holds no tenant
  secret.
- A tenant pod cannot mount the files the pool and supervisor write. The
  startup document says `hostReadiness: network`, and the harness reads both
  records from their own authenticated routes. Each pod reaches the supervisor
  of its own node through a node-local Service.
- The trusted ingress is the Compose platform's nginx, with the same rendered
  routes, in the system namespace. It sets the installation and proof headers.
  The harness checks host, installation header, and proof in both profiles.
  Only the ingress pods may reach a harness.
- The factory image runs as an unprivileged user with no home directory. The
  pool and the supervisor get `HOME` on their own bounded, writable `/tmp`, from
  one map (`FACTORY_HOST_SERVICE_BASE_ENVIRONMENT` in
  `src/factory/provisioning/deployment.ts`). The Compose host's pool reads the
  same map. Without it, the supervisor's podman-remote client cannot start.

A hosted fleet's settings carry `profile: "kubernetes"` and a `kubernetes`
block: `kubectl` and `kubeconfigPath` (absolute paths; the kubeconfig is never
read by the provisioner), `systemNamespace`, `runAsUser`, `runtimeSocketPath`,
`runnerRoot` (the supervisor's runner root, mounted at the same path on the
node, because the node's Podman resolves a guest's bind mounts by the node's
paths), `nodeCidrs` (the nodes' addresses: the supervisor runs on the host
network, so the tenant network policy admits them on the guest-broker route and
toward the supervisor port), `nodeSelector` (required to be non-empty under the `gpu` resource profile: the
supervisor runs only there), `ingress` (`listenPort`, `nodePort` 30000-32767),
`egressCidrs` and `egressPorts` for the tenant network policy, and `services`:
how a pod reaches the database, both object stores and Temporal. The fleet
host's pool uses the same addresses. A pod does not see the provisioner's own
addresses.
Every `nodeCidrs` and `egressCidrs` entry is one IPv4 CIDR. An IPv6 or dual-stack
hosted cluster is outside this profile. A malformed entry is refused by its
field, index, and entry (for example `kubernetes.nodeCidrs[0] "10.89.1.0"`).
`runAsUser` is the user and the group of every factory container, the
supervisor and every init container included, and the `fsGroup` of every pod.
Kubernetes owns a Secret volume's files by root. With `fsGroup`, the kubelet
shows them as root and that group, mode 0440, so only the pod's own containers
read them (C12 row "Scoped secret delivery (hosted)").

One named gap stays open: the supervisor DaemonSet and the Compose fleet host
both hold one fleet-wide host identity (`hosted-host-identity-shared`).

## Prerequisites

The installation checklist. The provisioner verifies every item it can observe.

| Item | Requirement | Verified by |
| --- | --- | --- |
| Container runtime | rootless Podman 5.x with cgroups v2 (memory, CPU, PID), `pasta`, the user systemd session | The supervisor's own runner probe, then its readiness record |
| Compose client | Docker Compose v2 CLI pointed at the Podman socket through `DOCKER_HOST` (`scripts/lib/container-engine.ts`) | `compose up` in the deployment step |
| PostgreSQL | One cluster; an admin URL with `CREATEROLE` and `CREATEDB` | Step 1 creates and logs in |
| Object stores | A product store and a separately credentialed archive store, each S3-compatible and versioned | Step 2 proves each credential's scope with read-only requests |
| Temporal | Started by `platform.yml` behind the mTLS and token gateway | Step 3 registers the namespace and describes it with the tenant's own credential |
| Operator key material | Created by `ensureFactoryPlatformMaterial` under the operator root | Every step reads it through the private reader |
| GPU (optional) | See "CPU-only availability" and `docs/factory-local-gpu.md` | Named readiness rows, all unmet on this host |
| Runner availability | Runner profiles declared in the fleet settings | The startup parser admits them before any install |
| Hosted cluster (hosted profile only) | Kubernetes with NetworkPolicy enforcement and Pod Security admission; kubectl; a private kubeconfig file named by path in the fleet settings | Step 5's apply and readiness wait |
| Local kind proof (this host only) | kind v0.32.0 and kubectl v1.37.1, each pinned by its published sha256 under `/tmp/factory-tools/` with a `PIN.txt` record; the node image `kindest/node:v1.36.1` present by digest; a kernel modules directory (see below) | The proof's preflight, outside the heavy lock; it fails by name |
| Podman API socket on every runner node (hosted profile only) | Podman 5.x with its API socket at `kubernetes.runtimeSocketPath`; the supervisor DaemonSet mounts it and drives guests through the image's pinned podman-remote client | The supervisor degrades by name (`container_runtime_socket_missing`) when the socket is absent |

kind mounts the host's `/lib/modules` into its node, always and read-only
(kind v0.32.0, `pkg/cluster/internal/providers/podman/provision.go`). A NixOS
host has no `/lib/modules`. The running kernel's modules are under
`/run/booted-system/kernel-modules/lib/modules`. Do not use
`/run/current-system`: after a rebuild without a reboot it names the next
kernel, not the running one. The local proof does not change the host. Its
`kind create cluster` call runs through a podman shim that rewrites exactly that
one mount to the running kernel's directory, still read-only, and passes every
other argument through. An operator who prefers a host path can add
`systemd.tmpfiles.rules = [ "L+ /lib/modules - - - - /run/booted-system/kernel-modules/lib/modules" ];`
to the NixOS configuration instead.

The proof's own PostgreSQL starts on the proof's bridge network. Rootless
Podman cannot attach a bridge network to a running container in its default
(`pasta`) network mode, so the network exists first and the container starts on
it.

Storage on this host: the installations use the two shared local stores
read-only (`docs/factory-local-storage.md`). The provisioner reads the stores'
own identity files and writes a private per-installation copy that holds only
that tenant's identity. It never starts, stops, or reconfigures a shared store.
The local pair is `same-host-not-independent`: it does not satisfy the
independent archive failure domain (W15, W19).

## Image and runtime locks

| Lock | Where | Value |
| --- | --- | --- |
| Factory image | `deploy/factory/Dockerfile`, built per revision | Referenced only by digest (`image@sha256:...`); a tag is refused |
| Bun build and runtime bases | `deploy/factory/Dockerfile` | `oven/bun:1.4.2` and `oven/bun:1.4.2-slim`, both by digest |
| Node for the orchestrator | `deploy/factory/Dockerfile` | `node:24.14.1-bookworm-slim` by digest |
| Temporal, its database, gateway, JWKS, authorizer, ingress | `deploy/factory/compose/platform.yml` | Every image by digest |
| Host supervisor | The host checkout at the image's revision | The fleet settings name the release directory and the Bun binary |
| Hosted supervisor's podman-remote client | `deploy/factory/Dockerfile` (`ADD --checksum`) | The static client of Podman v5.8.7, the release artifact checked by sha256; match it to the nodes' Podman 5.x API |
| Every image in the Dockerfile, the Compose templates, and the Kubernetes templates, and every download in the Dockerfile | `scripts/check-factory-deployment-locks.ts`, run in CI | Refuses any image not pinned by digest and any download not pinned by sha256 |
| Kubernetes objects | `src/factory/provisioning/kubernetes-profile.ts` | The renderer refuses to return an object stream with an unpinned image |
| Hosted ingress | the `ingress` service of `deploy/factory/compose/platform.yml` | The same nginx digest in both profiles |
| Local kind proof cluster | `deploy/factory/kubernetes/kind-proof.yml` | `kindest/node:v1.36.1` by digest, the default of kind v0.32.0. The kind project publishes its node images only on Docker Hub (`docker.io`), so this is a Docker Hub dependency. Pull it once by digest; without a team mirror, do not pull it again |
| Local kind proof tools | `/tmp/factory-tools/kind-0.32.0/`, `/tmp/factory-tools/kubectl-1.37.1/` | Each binary pinned by the sha256 its project publishes, recorded in `PIN.txt`; the proof's preflight checks the hash before use and never looks on `PATH` |
| Toolchain | `.bun-version`, `.node-version` | Bun 1.4.2, Node 24.14.1 |

Build the image from a clean checkout and pin its digest in the fleet settings:

```sh
podman build -f deploy/factory/Dockerfile --build-arg REVISION=$(git rev-parse HEAD) -t localhost/ezcorp-factory:$(git rev-parse HEAD) .
podman image inspect localhost/ezcorp-factory:$(git rev-parse HEAD) --format '{{.Digest}}'
```

## Secret references

The fleet settings document (`factory.fleet.v1`) holds references only. Two
files beside it hold credentials, and the document names their paths: the
control database URL and the product cluster's admin URL. Everything else is
generated by the steps.

| Material | Owner | Delivered to |
| --- | --- | --- |
| Product database credential | Step 1 | The harness and the gateway |
| Shared pool database credential | The fleet host | The shared pool only |
| Product and archive store credentials | Step 2 | The harness |
| Namespace client certificate, key, and token | Step 3 | The orchestrator |
| JWT secret, encryption secret, encryption salt | Step 4 | The harness, as environment through `secret-env.ts` |
| Wrapped data key and operator master key | Step 4 | The orchestrator only |
| Mesh certificates and the orchestrator's token | Step 5 | Each process gets its own identity |
| Pool token (`pool:tenant`, `pool:grant`, `pool:restore` for its own tenant) | The fleet host, at admission | The harness |
| Host signing key | The fleet host | The shared supervisor only; each harness gets its public half |
| Invitation digest | Step 7 | The harness; the token goes to the operator outbox |

Each service has its own private delivery directory. It holds copies of only
the files that service reads. The shared supervisor's and pool's deliveries
hold no tenant secret: no database credential of a tenant, no application
secret, no store key, no attempt-token secret. They hold public trust material
for each admitted installation. The master key is 32 raw random bytes. It is never an application
secret, and the secrets step refuses a key that is printable text or that
decodes from one.

## Provisioning an installation

```sh
bun scripts/factory-fleet-init-local.ts --fleet w16 --root $HOME/.ezcorp-factory-w16 \
  --image localhost/ezcorp-factory@sha256:<digest> --revision <40-hex> --port-base 31000
bun scripts/factory-fleet.ts $HOME/.ezcorp-factory-w16/fleet.json platform
bun scripts/factory-fleet.ts $HOME/.ezcorp-factory-w16/fleet.json provision tenant-01 --admin-email person@example.com
```

Without `--admin-email`, the invitation names `admin@<hostname>`. Every
mutating command is recorded on the ledger with who asked for it:
`cli:<account>` from the command line, `operator:<certificate name>` from the
control plane. The control plane runs at most three tenant operations at once
and answers 429 beyond that.

A command whose tenant fails exits 1. It prints its result on stdout and, on
stderr, every failed tenant with the step that failed, the code, and the
reason. A failed provision never exits 0.

Stop and start the whole fleet with `stop` and `up`. `stop` stops the
installations (newest tenant first), then the fleet host's pool and supervisor,
then the platform. It keeps every container and volume. `up` starts them in the
reverse order and waits until each part is ready. Both commands are safe to run
again.

```sh
bun scripts/factory-fleet.ts $HOME/.ezcorp-factory-w16/fleet.json stop
bun scripts/factory-fleet.ts $HOME/.ezcorp-factory-w16/fleet.json up
```

The fleet settings may declare `installations.release`: release profiles, and
optionally a GitHub destination (`repository`, and `tokenPath`, a private token
file on the host). When profiles exist, step 5 writes the startup document's
release block. It always contains the installation's own S3 destination
(`installation-s3`: its ordinary store, prefix `ordinary/releases`). It contains
a GitHub destination only when the fleet declares one. The token file is
delivered to the harness, and the document names it only by path. A local fleet
(`factory-fleet-init-local.ts`) declares an S3 profile for each S3 publication
adapter the reference definitions name. Today their digests are placeholders that
no published package has, so it declares none and prints the named reason
(`factory_release_adapter_unpublished`).

The orchestrator runs the workflow bundle that the image build made
(`packages/@ezcorp/factory-orchestrator/dist/factory-workflow.bundle.js`, with
its SHA-256 record beside it). It refuses a bundle whose bytes do not match the
record (`factory_workflow_bundle_digest_mismatch`). No compiler runs in the
read-only, noexec container. `scripts/check-factory-image-shipped-config.ts
<image>` runs that path under the isolation `installation.yml` ships. CI runs it
on every change.

A seeded object store names its buckets for the tenant alone. Step 2 therefore
claims each store bucket for its fleet, as a NOLOGIN role in the database
cluster, and refuses a bucket that another fleet holds. Purge releases the
claim, so no role of the fleet stays on the cluster; the store's objects stay,
because removing them needs the store's own admin authority.

### Database connections

Every installation's harness and gateway, and the fleet's shared pool, connect
to one PostgreSQL cluster. The product's default pool is 20 connections per
process, which would exhaust a 100-connection server at three installations.
Step 5 therefore sets `DB_POOL_MAX` to 4 for each harness and 2 for each
gateway (`databasePoolMax` in the deployment settings). Ten installations then
hold at most 60, the shared pool 8, and the provisioner about 16. Size the
cluster's `max_connections` above the fleet's total before adding installations.

### The fleet host

One pool and one host supervisor serve every installation of a fleet
(`host status` shows which are admitted). Step 5 admits the installation: the
host mints its pool token, adds its mesh authority and harness identity to the
pool's and supervisor's trust, and restarts both onto it, which takes the
shared services away for a few seconds. Teardown releases it the same way.
Each shared service's readiness record names its own identity, `pool.<fleet>`
and `host.<fleet>`, and every installation's harness reads both records
read-only. When the last installation is released the host stops.
`host decommission` then drops the shared pool database and role.

The seven steps run in order. Each one is idempotent by tenant and records its
owner, attempts, resources (references only), and failure on the ledger.

| Step | Owner | Establishes |
| --- | --- | --- |
| 1 database | `provisioner/postgres` | The product database with its own login role, a generated password, and the `vector` and `pg_trgm` extensions, created by the administrator |
| 2 storage | `provisioner/object-store` | Product and archive credentials, each proven scoped to its prefix |
| 3 temporal | `provisioner/temporal` | Namespace (30-day retention, history and visibility archival, W15's settings), its client certificate and token, and the gateway's read token for the namespace |
| 4 secrets | `provisioner/secrets` | Application secrets and the wrapped data key |
| 5 deployment | `provisioner/deployer` | Harness, orchestrator, and gateway, admitted to the fleet host's pool and supervisor, all ready |
| 6 ingress | `provisioner/ingress` | Hostname bound to the installation ID; route held |
| 7 invitation | `provisioner/invitation` | First-administrator invitation; route opened |

Four phases separate what the steps establish: `resources_prepared` (steps 1
to 4), `deployment_ready` (5 and 6), `invitation_issued` (7), and
`bootstrap_complete`. The last one is observed, never performed. An
installation before `invitation_issued` serves no traffic: its route answers
503.

### First administrator and bootstrap

1. Deliver the invitation in `<operator root>/<tenant>/first-admin-invitation.json` to the invited person. The harness reads its own copy from its delivery directory, so `rotate <tenant> invitation` takes effect without a restart.
2. The person completes first-run setup with that token (`POST /api/auth/setup` with `invitationToken`). Setup refuses any other email and any other token.
3. The person signs in, creates the bootstrap project, and sends the exact consent sentence to `POST /api/installation/bootstrap`. This one transaction writes the approve, trust, and release grants, the consent record, and the audit entry.
4. The operator records the observation: `bun scripts/factory-fleet.ts <fleet.json> observe tenant-01`.

If setup created the administrator but failed before it recorded the
redemption, setup refuses a second run. The consent in step 3 then records the
redemption itself, in the same transaction. It does this only for the
installation's sole user, an administrator with the invited email, while the
invitation is still valid.

### Trusted ingress

The ingress sets two headers on every request it forwards and overwrites what a
client sent: the installation ID and a per-installation ingress proof. The
harness answers only a request whose Host, installation ID, and proof all
match, and refuses anything else with 421. The proof is a secret that only the
ingress and that harness hold, so a local process that reaches the harness's
loopback port cannot pose as the ingress. The ingress certificate authority's
key is kept outside the directory the ingress container mounts. The Kubernetes profile does not use the proof: its
NetworkPolicy admits only the ingress controller to the harness, and an
annotation would publish the proof to anyone who can read the Ingress.

## Recovery

A failed step is recorded `failed` with its code and message. Fix the cause and
run `provision` again. It verifies every completed step against its live
service, then resumes at the failed step. It never adopts a resource that lacks
this installation's provenance marker. It refuses such a resource by name, and
the operator must remove it by hand after checking whose it is.

## Drain

Start with `teardown` (below). It holds the route first, so no new request
reaches the installation. Then it stops the processes and withdraws the
credentials. A run that was executing stays in the database as active or
uncertain work. Purge refuses until that work is closed.

## Rotation and revocation

```sh
bun scripts/factory-fleet.ts <fleet.json> rotate tenant-01 database     # or temporal, secrets, deployment, invitation
```

Two credentials expire and must be rotated before their deadline:

| Credential | Lifetime | Command | Where the deadline is |
| --- | --- | --- | --- |
| Service tokens and mesh leaf certificates | 30 days | `rotate <tenant> deployment` | `meshTokensExpireAtMs` on step 5 in `status <tenant>` |
| Temporal namespace token | 30 days | `rotate <tenant> temporal` | the token's `exp`; rotate with the mesh. The same step replaces the certificate and the read token and revokes the old ones |

### The operator master key

The master key wraps the installation's data key. It never encrypts data
itself, so a rotation changes no stored object.

```sh
bun scripts/factory-fleet.ts <fleet.json> rotate tenant-01 master-key
bun scripts/factory-fleet.ts <fleet.json> revoke-master-key tenant-01 1
```

| File | Where | Format |
| --- | --- | --- |
| `master.key` (version 1), `master-v<n>.key` (version n) | the installation's operator directory, mode 0700, outside every grantable root | exactly 32 random bytes, mode 0600, owned by the provisioning user |
| `wraps.json` | the installation's secret directory | `factory.key-wraps.v1`: installation ID, wrap version, master key ID, and the base64 wrapped data key, all under ONE master key |
| `retained-wraps-v<n>.json` | the operator directory, beside `master-v<n>.key` | the wraps under a superseded key, kept until that key is revoked |

The wrap file decides which key is current. `rotate <tenant> master-key`
writes the next key once, refuses it if it is printable text or an application
secret, keeps the current wraps beside the current key, wraps the same data key
under the next key, and replaces the wrap file in one atomic step. Then it
re-delivers the new key and wrap file to the orchestrator only and restarts it.
A rotation interrupted by a crash is completed by the next run. It never makes
a second new version.

`revoke-master-key <tenant> <version>` removes an older key and the wraps kept
under it. It refuses the current version (`master_key_revocation_current`).
After revocation, a wrap under the removed key does not open
(`factory_key_missing`). Run it again and nothing changes. Revoke a version
only after every backup that needs it has a newer wrap.

Only a complete step rotates. A rotation that fails is recorded as
`step.rotation_failed` and leaves the previous credential in force. A database
or Temporal rotation interrupted by a crash is finished by the next run.

Each rotation proves that the superseded credential no longer works before it
returns, then re-delivers the new one and restarts the services onto it. The
seeded local stores cannot rotate or revoke: the provisioner holds no admin
authority over them, and teardown records this as the named residue
`storage_revocation_unsupported` after it destroys the private copies.

## Upgrades and rollback

```sh
bun scripts/factory-fleet.ts <fleet.json> upgrade register <build> <image@sha256:...> <revision> <release directory>
bun scripts/factory-fleet.ts <fleet.json> upgrade wave <build> --canary tenant-01 tenant-01 tenant-02 ...
bun scripts/factory-fleet.ts <fleet.json> upgrade abandon <wave>
bun scripts/factory-fleet.ts <fleet.json> upgrade retire
```

One wave runs at a time. A wave that fails for any reason is recorded
`stopped`. `upgrade abandon` clears a wave left `running` by a process that
crashed. A wave takes each installation's provisioning lock and skips an
installation that does not serve traffic.

A wave upgrades its canary alone first. In each installation the order is
fixed: the host components (the fleet host's shared supervisor and pool, moved
once for the whole fleet at the canary, and found already moved for every
later installation), then the orchestrator, then the harness and gateway. The harness runs the migrations at boot, so a
migration failure surfaces last and the earlier components can walk back. A
migration or readiness failure stops the wave. That installation walks back in
reverse order to the build it ran before, and every installation after it is
left untouched. Schema changes are additive: the older build must start on the
newer schema, and the rollback's readiness check proves it.

A build is retired only when no installation runs it or holds it as its
rollback target, and no installation that ran it has open work. The
orchestrator does not implement Temporal worker build-ID versioning, so old
builds are retained at the image and release level only.

## Teardown and purge

```sh
bun scripts/factory-fleet.ts <fleet.json> teardown tenant-10 --reason "customer left"
bun scripts/factory-fleet.ts <fleet.json> purge tenant-10 --approval <approval ID> --reason "retention elapsed"
```

Before teardown, an administrator of the installation approves the purge in a
signed-in session: `POST /api/installation/purge-approval` with the exact
acknowledgement sentence and a reason. The installation stores the approval
with its audit entry and returns its ID, valid for seven days. The operator
passes that ID to `purge`. The provisioner reads the approval from the retained
database and accepts it only for this installation, before it expires, while
its approver is still an active administrator. The operator can name an
approval but cannot create one.

Teardown holds the route, walks the steps backwards, withdraws every login,
revokes the namespace identity and its read token at the Temporal gateway, and
destroys the delivered secrets. It keeps the databases and the release archive.

Teardown moves the key wrap into the operator's escrow before it deletes the
installation's copy. Purge requires a valid approval and no active or uncertain
work. It drops the databases and the runtime volumes. It keeps the master key
and the escrowed wrap, because an archived record may be encrypted under the
installation's data key. It fails if the escrow is missing. It records the
purge as the C06 audit-loss statement, `purge.audit_loss`. That record names
what purge does not remove on this host:

| Retained | Why |
| --- | --- |
| Release archive | C06 keeps it |
| Master key and escrowed wrap | The archive may need them |
| Temporal namespace history | Kept until the namespace's own retention ends |
| Ordinary store objects | The seeded store's objects need that store's admin authority |

## Restarts and reboots

The provisioner starts the fleet host's supervisor as a transient user unit. A transient
unit does not survive a reboot or a restart of the user manager. For a host
that must recover on its own, install
`deploy/factory/systemd/ezcorp-factory-supervisor@.service`, run
`loginctl enable-linger`, and enable `podman-restart.service` so that rootless
containers with `restart: unless-stopped` start again.


## CPU-only resource availability

The resource profile is a fleet setting, `resources`, because the pool is
shared by the fleet. Every installation of the fleet inherits it.

| Profile | Settings | What the pool offers |
| --- | --- | --- |
| `cpu-only` | `{ "profile": "cpu-only", "cpuCapacity": 2 }` | CPU slots only. A runner profile that asks for `gpu-host` is refused when the settings are read. No attempt receives a device. |
| `gpu` | `{ "profile": "gpu", "cpuCapacity": 2, "gpuProfilesPath": "/abs/gpu-host-profiles.json" }` | CPU slots, and the fleet host as its one GPU host. The private profile file must declare exactly that host (`host.<fleet>`); the host refuses any other file before the pool starts (`host_gpu_profiles_invalid`) and delivers it to the pool only. |

The W19a graph proof runs on the `cpu-only` profile (`GRAPH_PROOF_RESOURCES`
in `scripts/factory-graph-proof/stack-documents.ts`, CPU capacity 4). With the
test provider it runs the reference pack end to end: one model operation, by
the test provider, at cost 0, and no device.

`factory-fleet-init-local.ts --gpu-profiles <file>` writes a `gpu` fleet;
without it, the fleet is `cpu-only`. A fleet cannot move from `gpu` to
`cpu-only`: the pool's durable state refuses it. Make a new fleet instead.

This host has no production GPU. Every installation runs CPU journeys. The
fleet's shared pool offers `cpuCapacity` CPU slots to all its
installations, in one capacity ledger. The GPU host
profile registry (`src/factory/pool/gpu-host-profiles.ts`) refuses a production
profile without evidence for each of the eight C05 criteria. The local AMD
profile is `trusted-local` and is unmet on every production row. See
`docs/factory-local-gpu.md` for the measured verdicts.

## The Temporal read route

The checkpoint barrier in each harness reads its namespace's workflow
positions through the Temporal gateway's read-only HTTP route
(`portBase + 1004`). The harness presents its namespace client certificate
and no token. The gateway allows two reads only: describe the namespace, and
list its workflows by query. It refuses, with a 403 that names the reason, any
other method or path, a path that names another namespace, a caller's own
token, and a revoked certificate. For an allowed read it injects the
namespace's `read:<namespace>` token. The provisioner keeps one token file per
namespace (mode 0600) in the platform's `temporal/http-tokens` directory. The
harness never receives it.

## Ports on this host

| Port | Use |
| --- | --- |
| `portBase + 10*n` to `+3` | Tenant `n`: harness, private service, gateway, guest-broker route, all on 127.0.0.1 |
| `portBase + 1001` | Temporal gateway (gRPC, mTLS and token) |
| `portBase + 1004` | Temporal gateway, read-only HTTP route for the checkpoint barrier |
| `portBase + 1002`, `+1003` | The fleet host's shared pool and supervisor |
| `portBase + 1005` | Ingress (HTTPS) |

Each service runs in its own `pasta` network namespace and can reach only the
host loopback ports it forwards. The shared pool and each gateway reach only
the database. Each harness reaches its database, its stores, its gateway, and
the shared pool and supervisor, and the Temporal gateway's read-only HTTP route. The orchestrator
reaches only Temporal and its own harness's private service.

### Guest-broker route

Each harness binds W01g's guest-broker route (`guestBroker` in its startup
document) on `portBase + 10*n + 3`. A sandboxed guest has no network, so the
fleet host's supervisor carries the guest's staging frames to this route. The
route admits only a client certificate from the host authority (the
supervisor's `host-supervisor.crt`), a host token signed by the host token key
(`host-token.pub`, delivered to the harness), and an attempt token that
verifies with the installation's attempt-token secret. The token's audience
and scope are W01g's route contract (`runner/guest-broker-contract.ts`); a pool
token from the same key is refused as `token_audience_refused`. `/api/ready`
names the route's state under `detail.factory.guestBroker`.

The supervisor document names one route per admitted installation in
`services.guestBrokers`, keyed by tenant, each at that installation's port and
trusted through the host trust bundle. The supervisor presents
`host-supervisor-guest-broker.token` (subject `supervisor.<fleet>`), which only
its own delivery holds. A frame goes only to its own attempt's tenant; a
tenant with no entry is refused on the host as
`factory_host_broker_tenant_unconfigured`. Admitting or releasing an
installation re-renders the supervisor document and restarts it onto the new
set.
