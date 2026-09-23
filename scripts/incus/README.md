# Deterministic Incus setup artifacts

## Operator screen

After the Incus sandbox extension release is verified, reviewed, and active, an administrator opens **Extensions → Set up Incus**. The engine reads one host-owned SSH bootstrap target, inspects it, issues a scoped client certificate, and saves the exact server plan and digest. The administrator checks the plan and confirms it in the screen. The engine then applies only that saved plan over SSH, reinspects the server, and offers a read-only provider probe. An interrupted or uncertain apply stays visible for review; it does not start an untracked new plan.

Set these on the **EZHarness engine host**, in its service environment. They never come from a browser request:

```sh
EZCORP_INCUS_SETUP_SSH_TARGET=dev@sandbox-server.taile1c5b0.ts.net
EZCORP_INCUS_SETUP_SSH_IDENTITY_FILE=/home/dev/.ssh/id_ed25519_personal
EZCORP_INCUS_SETUP_SSH_KNOWN_HOSTS_FILE=/home/dev/.ssh/known_hosts
EZCORP_INCUS_SETUP_SSH_HOST_KEY_SHA256=SHA256:a3VHX02pT5agIluq6K12E9oCuTg09ErbQ5wK9Vvk8Co
EZCORP_INCUS_SETUP_ENDPOINT=https://sandbox-server:8443
EZCORP_INCUS_SETUP_RECIPE_FILE=/var/lib/ezharness/incus/reviewed-recipe.json
```

The host key pin, server certificate, recipe hostname, listener address, and port must agree with the inspected server. Use a dedicated `known_hosts` file with one approved key for this target; extra accepted host keys fail the pin check. The checked-in `recipe.json` pins the reviewed image and build inputs. `recipe.template.json` keeps the empty image pins for a future build. Copy the reviewed recipe to the host-owned recipe path and review it before starting Plan. The engine rejects a relative path, link, writable file, missing pins, or a recipe that supplies its own client identity. The saved plan binds the exact recipe used for Apply; a changed file or active release requires a new Plan and approval. Browser input cannot select arbitrary commands. This first recipe uses a 100 GiB loop-backed Btrfs pool and a 20 GiB guest root disk to match the advertised Incus preset. Incus recommends dedicated storage for production; this loop-backed recipe is for this development deployment.

The engine must have `ssh`, `ssh-keygen`, and `openssl`. Its SSH account needs the Incus rights required by the reviewed plan. Keep the SSH private key and `known_hosts` readable only to the engine service account. The generated Incus client private key is encrypted in the provider-connection store; the setup plan contains only its public certificate.
Keep the engine encryption root and salt stable across restarts (`EZCORP_ENCRYPTION_SECRET` and `EZCORP_ENCRYPTION_SALT`, or the existing persistent secret files). Otherwise, saved client keys cannot be decrypted after restart. Only one EZHarness control-plane process may run this v1 setup controller.

The screen can verify server configuration, but a passing server setup does **not** qualify guest Compose, isolation, helper behavior, or secret delivery. Run the separate live-provider qualification before admitting feature workloads.

The 1.2.0 reviewed recipe pins the published guest image, exact base fingerprint, Python 3 package version, Docker static archive SHA-256, Compose binary SHA-256, and helper SHA-256. The builder takes a reviewed recipe as its first argument and refuses inputs that differ from it. The base fingerprint must already resolve on the approved Incus server. The helper SHA-256 must match `src/infrastructure/incus-guest/helper.py`; the planner checks that source digest. The builder also verifies the three artifact files against their pinned digests before launching a guest. Setup requires every active release preset to pin the same image and helper, and requires the exact image and alias in fresh server inventory.

`build-guest-image.sh` is the reviewed server-side build command. Its arguments are `RECIPE_JSON BASE_FINGERPRINT PYTHON_PACKAGE_VERSION DOCKER_TAR DOCKER_SHA256 COMPOSE_BINARY COMPOSE_SHA256 HELPER_PY HELPER_SHA256 ALIAS`. Copy the script, reviewed recipe, and artifact files to the approved server through the operator's controlled path. It creates the `sandbox` user as UID/GID 1000, installs the helper at `/usr/local/libexec/ezharness-helper`, creates private state at `/var/lib/ezharness-helper`, and publishes an Incus image alias. Record the fingerprint it prints and add that fingerprint to the recipe only after review. The planner then requires the fingerprint and alias in the read-only Incus image inventory. The 2026-09-23 server image build and direct guest Compose test are recorded in the validation packet; the EZHarness operator connection and feature lifecycle are separate live gates.

## Offline CLI

### Image prebuild bootstrap

The image builder needs the recipe pool and managed bridge before the guest image exists. This separate plan contains only those two create steps. It uses the same closed recipe and the inspected inventory. It does not remove the image or client certificate requirements from full setup. The bootstrap apply inspects the host again, checks the approved recipe, host, pin, route, resource baseline, and whether each target existed when the plan was approved. It reads each created resource back. A changed baseline, newly present target, or uncertain effect stops the run for review. Keep the approved plan file and digest as an audit record after an interrupted run.

Use the pinned Bun and a private connection file. Review the plan and its `planDigest` before the execute command. These commands do not run any remote write unless the final `--execute` command is run:

```sh
/home/dev/.bun/bin/bun scripts/incus/cli.ts inspect --connection private-connection.json --out private-inventory.json
/home/dev/.bun/bin/bun scripts/incus/cli.ts bootstrap-plan --recipe scripts/incus/recipe.json --inventory private-inventory.json --out private-bootstrap-plan.json
/home/dev/.bun/bin/bun scripts/incus/cli.ts bootstrap-apply --recipe scripts/incus/recipe.json --plan private-bootstrap-plan.json --connection private-connection.json
/home/dev/.bun/bin/bun scripts/incus/cli.ts bootstrap-apply --execute --approved-plan-digest <reviewed-planDigest> --recipe scripts/incus/recipe.json --plan private-bootstrap-plan.json --connection private-connection.json
/home/dev/.bun/bin/bun scripts/incus/cli.ts bootstrap-verify --recipe scripts/incus/recipe.json --plan private-bootstrap-plan.json --connection private-connection.json
```

If an effect has an unknown outcome, inspect and reconcile the exact pool and bridge. If either target appeared after approval, make a new inventory and obtain a new reviewed bootstrap plan before any further apply. A new image input or unrelated server change also needs a new inventory and reviewed plan. The image build and full setup remain separate approval steps.

After bridge creation, verification accepts its pinned gateway address and the subnet, gateway, and broadcast routes only when each route is bound to the reviewed bridge. Other address or route changes still fail the baseline check. This verification rule does not allow an absent target to appear during apply preflight; that ownership check remains separate.

`inspect` first checks that the connection fingerprint matches the actual `known_hosts` entry, then reads a fixed inventory over SSH with at most four concurrent sessions. `plan` is pure over the closed recipe and that inventory. `apply` refreshes the read-only preflight and prints a dry-run receipt unless `--execute` and the exact approved plan digest are both present. `verify` reinspects the server and fails until every approved postcondition matches.

Use the repository's pinned Bun:

```sh
/home/dev/.bun/bin/bun scripts/incus/cli.ts inspect --connection private-connection.json --out private-inventory.json
/home/dev/.bun/bin/bun scripts/incus/cli.ts plan --recipe scripts/incus/recipe.json --inventory private-inventory.json --out private-plan.json
/home/dev/.bun/bin/bun scripts/incus/cli.ts apply --recipe scripts/incus/recipe.json --plan private-plan.json --connection private-connection.json
/home/dev/.bun/bin/bun scripts/incus/cli.ts verify --recipe scripts/incus/recipe.json --plan private-plan.json --connection private-connection.json
```

The checked-in recipe intentionally has no provider TLS client certificate. Its offline plan is blocked until the engine creates one private key, records its public certificate and fingerprint, and receives review for the exact resulting plan digest. Never add a private key to the recipe.

Execution is a separate, explicit action:

```sh
/home/dev/.bun/bin/bun scripts/incus/cli.ts apply --execute --approved-plan-digest <digest> --recipe <recipe> --plan <plan> --connection <connection>
```

Do not run that command against a live server until the plan has approval. A timeout, disconnect, conflict, or “already exists” result goes to inspection and reconciliation. The command does not repeat an uncertain effect.

Focused validation uses the checked-in TypeScript project:

```sh
PATH=/home/dev/.bun/bin:$PATH bun test ./scripts/incus/setup.test.ts
PATH=/home/dev/.bun/bin:$PATH bun x tsc --project scripts/incus/tsconfig.json
```
