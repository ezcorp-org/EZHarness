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
| Hosted Kubernetes | `src/factory/provisioning/kubernetes-profile.ts` renders the manifests | Manifests validated, and admitted by a local kind cluster only. Not a hosted pass |

The hosted profile has four named gaps. The product reads the shared pool's
and supervisor's readiness from files, and a `restricted` tenant namespace
cannot mount a file the system namespace writes (`hosted-supervisor-readiness`).
The startup document names the shared services at `127.0.0.1`, and the hosted
pool and DaemonSet are at cluster and node addresses (`hosted-supervisor-address`).
Both need a change to the product's readiness and startup surfaces. The
ingress sets the installation and proof headers through the
`configuration-snippet` annotation, which ingress-nginx 1.9 and later disables
by default; with it disabled, every request is refused 421
(`hosted-ingress-snippet`). The supervisor DaemonSet and the Compose fleet
host both hold one fleet-wide host identity (`hosted-host-identity-shared`). The gate file `tasks/factory/w16-GATES.md`
tracks all four.

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
| Bun build and runtime bases | `deploy/factory/Dockerfile` | `oven/bun:1.3.14` and `oven/bun:1.3.14-slim`, both by digest |
| Node for the orchestrator | `deploy/factory/Dockerfile` | `node:24.14.1-bookworm-slim` by digest |
| Temporal, its database, gateway, JWKS, authorizer, ingress | `deploy/factory/compose/platform.yml` | Every image by digest |
| Host supervisor | The host checkout at the image's revision | The fleet settings name the release directory and the Bun binary |
| Every image in the Dockerfile and the Compose templates | `scripts/check-factory-deployment-locks.ts`, run in CI | Refuses any image not pinned by digest |
| Toolchain | `.bun-version`, `.node-version` | Bun 1.3.14, Node 24.14.1 |

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

This host has no production GPU. Every installation runs CPU journeys. The
fleet's shared pool offers `cpuCapacity` CPU slots (2 by default) to all its
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
| `portBase + 10*n` to `+2` | Tenant `n`: harness, private service, gateway, all on 127.0.0.1 |
| `portBase + 1001` | Temporal gateway (gRPC, mTLS and token) |
| `portBase + 1004` | Temporal gateway, read-only HTTP route for the checkpoint barrier |
| `portBase + 1002`, `+1003` | The fleet host's shared pool and supervisor |
| `portBase + 1005` | Ingress (HTTPS) |

Each service runs in its own `pasta` network namespace and can reach only the
host loopback ports it forwards. The shared pool and each gateway reach only
the database. Each harness reaches its database, its stores, its gateway, and
the shared pool and supervisor, and the Temporal gateway's read-only HTTP route. The orchestrator
reaches only Temporal and its own harness's private service.
