# Deployment

This page covers operator-facing requirements for production EZCorp
deployments. For end-user / dev-machine setup see `quick-start.md`.

## Container networking

The `docker-compose.yml` shipped in this repo uses `network_mode: host`
for the `app` service — that's a **dev-only** convenience so a browser
on the same machine can hit the SvelteKit dev server without port
mapping or hostname rewriting.

**Production deployments must use isolated container networking** —
either default Docker bridge mode, a custom Docker network, or a
Kubernetes NetworkPolicy. Extension and MCP workers run in the extension
runner with no network of their own; the app's outbound network goes
through whatever firewall / egress proxy your platform uses.

## Running under Podman

The dev stack runs on rootless Podman. Use the wrapper — it is the
supported entry point. Both of the things it sets go wrong when
forgotten: without `DOCKER_HOST` you drive Docker instead of Podman and
nothing says so, and without the compose override you get a failure that
[never names its cause](#if-you-forget-the-override).

```sh
bun run podman up -d
bun run podman logs -f app
bun run podman down
```

It `exec`s `docker compose "$@"`, so every flag passes straight through —
including the opt-in suggestion sidecar
([below](#suggestion-model-sidecar-ollama)):
`bun run podman --profile ollama up -d`.

It points `DOCKER_HOST` at the rootless Podman socket and layers
`compose.podman.yml` on top of `docker-compose.yml`. Start the socket
once per host:

```sh
systemctl --user enable --now podman.socket
```

### Preserving dev release artifacts after this update

The dev stack stores immutable extension release artifacts in the stable
`ezcorp-dev-extension-releases` named volume at
`/app/.ezcorp/extension-releases`. Set `EZCORP_EXTENSION_RELEASES_VOLUME` to
use an isolated volume. The database stores only each artifact digest.

Before applying this config and recreating `app`, copy the old container's
artifact directory to a host backup through the supported wrapper:

```sh
bun run podman cp app:/app/.ezcorp/extension-releases ./.ezcorp/extension-releases-backup
```

After updating the compose file, import that backup into the new volume. This
refuses a non-empty destination and verifies every digest-named blob before
copying it, so it cannot overwrite existing artifact bytes:

```sh
bun run podman run --rm --no-deps --user 0 \
  -v "$PWD/.ezcorp/extension-releases-backup:/from:ro" \
  --entrypoint sh app -ec '
    set -eu
    test -z "$(find /app/.ezcorp/extension-releases -mindepth 1 -print -quit)"
    test -z "$(find /from -mindepth 1 -maxdepth 1 ! -type f -print -quit)"
    sums=$(mktemp)
    trap "rm -f $sums" EXIT
    find /from -mindepth 1 -maxdepth 1 -type f -exec sha256sum {} + > "$sums"
    while IFS=" " read -r hash file; do
      name=${file##*/}
      test ${#name} -eq 64
      case "$name" in *[!0-9a-f]*) exit 1 ;; esac
      test "$hash" = "$name"
    done < "$sums"
    cp -a /from/. /app/.ezcorp/extension-releases/
  '
bun run podman up -d --no-deps --force-recreate app
```

The backup must contain only 64-character lowercase SHA-256 filenames. Do not
run `docker compose down -v` while the development database still references
these digests.

The wrapper also refuses two invocations that would quietly undo what it
just set up:

- **A `-f` / `--file` passed through it.** Compose's `-f` *replaces* the
  file list rather than adding to it, so `bun run podman -f
  docker-compose.yml up -d` would run without the override. Name every
  file when you layer your own: `bun run podman -f docker-compose.yml -f
  compose.podman.yml -f mine.yml up -d`. A `-f` *after* the subcommand
  belongs to that subcommand and passes through untouched — `bun run
  podman logs -f app` is `--follow`.
- **A `COMPOSE_FILE` exported in your shell that omits
  `compose.podman.yml`.** The wrapper exports its own value over yours,
  so yours would disappear without a word. A value that already names the
  override is kept as-is.

**Use the Docker Compose CLI against the Podman socket, not
`podman-compose`.** `ollama-init` waits on `depends_on: condition:
service_healthy`, which podman-compose has historically handled
unreliably. The Compose CLI talking to the Podman socket runs it
correctly — `docker version` against that socket reports `Podman Engine`
as the server.

### The one behavioural difference: `tmpfs:`

`docker-compose.yml` masks six directories out of the `.:/repo` bind:
`/repo/.ezcorp` (the prod stack's live PGlite DB and keys), `/repo/agent`
(harness session credentials), `/repo/.worktrees` (the canonical agent
checkout directory), `/repo/worktrees` and `/repo/.claude/worktrees`
(older checkout directories), and `/repo/web/.stryker-tmp` (mutation-test
sandboxes that can contain copied credentials). Docker mounts an empty tmpfs
over each. **Podman does not.** Its
tmpfs default is `tmpcopyup`, which seeds the tmpfs with the contents of
the directory underneath, publishing into the container exactly what the
mask exists to hide — and copying it into RAM, since tmpfs is
memory-backed.

`compose.podman.yml` re-declares every mask with `notmpcopyup`, which
restores Docker's semantics. It has to be a separate file because the
Docker daemon rejects the option outright (`invalid tmpfs option
[notmpcopyup]`) and the container then never starts.

#### If you forget the override

A mask is a blacklist, so forgetting the override fails closed either
way — nothing leaks. But the two mechanisms that catch it are not equally
legible, and the one you hit is chosen by the SIZE of the masked tree,
not by anything you did.

**Large tree — an opaque ENOSPC.** This is the usual case, because
the worktree directories can be tens of GB against a 64 MB
tmpfs. The copy-up runs while the OCI runtime builds the container's
mount namespace, so it fails before the container's own process starts:

```
Error response from daemon: crun: write: No space left on device: OCI runtime error
```

A bare `podman run` words the same failure the other way round:

```
Error: OCI runtime error: crun: write: No space left on device
```

The container stays in `Created` and never runs, `docker compose logs`
shows nothing, and neither message names the mask or the missing file.
**If you see this, you started the stack without `compose.podman.yml`.**
Start it with the wrapper instead:

```sh
bun run podman up -d
```

**Small tree — the boot guard, which says what is wrong.** A mask reaches
the app only if its copy-up FITS the tmpfs. Then the container starts,
and the guard in the app `command:` finds the masked path non-empty and
aborts:

```
FATAL: /repo/.ezcorp is not empty inside the container.
       Its tmpfs mask is not in effect ...
```

Same cause, same fix. Do not read a clean boot as proof that this guard
checked anything: it runs only when EVERY mask fits, so on a box with a
large `worktrees/` it never gets to speak.

> **Do not set `COMPOSE_FILE` in `.env` on a host that also runs
> Docker.** Compose reads `COMPOSE_FILE` from `.env` for every runtime,
> so a plain `docker compose up` would then also load the Podman
> override and die on `invalid tmpfs option`. On a Podman-only host it
> is safe, and replaces the wrapper:
> `COMPOSE_FILE=docker-compose.yml:compose.podman.yml`.

### `restart: unless-stopped` and reboots

Podman has no always-running daemon, so restart policies do not survive
a reboot on their own. Two things are needed:

```sh
loginctl enable-linger "$USER"              # user units run without a login session
systemctl --user enable podman-restart.service   # replays restart policies at boot
```

Lingering alone is not enough — `podman-restart.service` is what
actually restarts the containers. Neither policy in the compose files is
changed by this; they are host-side prerequisites.

### Resource caps need cgroup delegation

`searxng` and `ollama` carry deliberate `mem_limit` / `cpus` caps (see
the 2026-06-12 note in `compose.prod.yml`). Rootless Podman can only
enforce them if the controllers are delegated to your user slice:

```sh
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/cgroup.controllers
```

`cpu` must appear in that list. **If it does not, Podman ignores the cpu
cap silently** — the container runs uncapped and nothing is logged. Fix
the delegation rather than dropping the caps:

```sh
sudo mkdir -p /etc/systemd/system/user@.service.d
printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | \
  sudo tee /etc/systemd/system/user@.service.d/delegate.conf
sudo systemctl daemon-reload
# log out and back in, then re-check the file above
```

### Other rootless differences worth knowing

- **`network_mode: host` still means the real host network namespace.**
  The app reaches the sidecars on `localhost:8889` (SearXNG) and
  `localhost:11434` (Ollama) exactly as under Docker, because rootless
  Podman does not create a new netns for host-network containers.
- **File ownership is inverted.** Container uid 0 maps to the uid that
  invoked Podman, so files the container creates in the bind mounts land
  owned by *you*, not by root. Under Docker they land root-owned and
  need sudo. Nothing in the stack depends on which way this falls, so no
  `--userns=keep-id` is needed.
- **`safe.directory=/repo` is redundant but harmless.** Because the host
  tree appears as uid 0 inside the container, git's dubious-ownership
  check never fires under Podman. It is load-bearing under Docker, so
  the entry stays.
- **Image names are fully qualified** (`docker.io/...`) so they resolve
  without relying on `unqualified-search-registries` in the host's
  `containers/registries.conf`.

## Running the production stack under rootless Podman

The development stack above is Linux-only because its `app` service uses
`network_mode: host`. The production stack runs under rootless Podman on
Linux or macOS. Layer `compose.podman-prod.yml` on `compose.prod.yml`.
`compose.podman.yml` is only for the development stack's `tmpfs` masks.

First prepare the environment and all four host bind sources. Fill the four
required values in `.env.prod` as described in the README.

```sh
cp .env.prod.example .env.prod && chmod 600 .env.prod
mkdir -p .ezcorp/data .ezcorp/extensions .ezcorp/extension-data .ezcorp/projects
```

### Linux

Start the rootless API socket and point Docker Compose at it:

```sh
systemctl --user enable --now podman.socket
export DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"
docker compose -f compose.prod.yml -f compose.podman-prod.yml \
  --env-file .env.prod up -d --build
```

### macOS

Podman uses a Linux virtual machine on macOS. Install Podman and the Docker
Compose provider. Create the machine once with enough memory for the 4 GiB
Ollama limit, then start it:

```sh
brew install podman docker-compose
podman machine init --cpus 4 --memory 8192 --disk-size 60  # first use only
podman machine start
```

For an existing machine, skip `init` and inspect its allocation with
`podman machine inspect`. Then start the stack — the wrapper finds the
machine's socket itself, layers the Podman override and passes `.env.prod`,
so none of that has to be repeated per shell:

```sh
bun run podman --prod up -d --build
```

Open <http://localhost:4000>. Verify the Compose services and application
readiness instead of treating a successful `up` as proof:

```sh
bun run podman --prod ps
curl --fail --silent --show-error http://localhost:4000/api/ready
```

The wrapper accepts either Compose spelling — the `docker compose` plugin or
the standalone `docker-compose` binary — so a Mac with only
`brew install docker-compose` and no `docker` executable works unchanged.

### Why the production override is required

The production image runs as uid/gid 1000. In rootless Podman's default user
namespace, that identity maps to subordinate IDs, not to the account that
owns the host bind directories. The app therefore cannot write `/app/data`
or the other host binds.

`compose.podman-prod.yml` sets
`userns_mode: keep-id:uid=1000,gid=1000` on `app`. Podman's `keep-id` mode
maps the account that invoked Podman to uid/gid 1000 in the container. The
sidecars need no override because they do not write to host bind mounts.

The README's `sudo chown -R 1000:1000 .ezcorp/data` step is for a rootful
Docker daemon. Skip it under rootless Podman. It does not create the required
rootless UID mapping and, on a host where your account is not uid 1000, it
also transfers the directory away from your account.

### Check the subordinate ID range

The setuid `preview-spawn` helper uses per-conversation uid/gid values from
90000 through 99000. Rootless Podman must be able to map that range. Inspect
both files; the total ranges for the Podman user in each file must cover at
least 99,000 IDs. A single common 65,536-ID range is insufficient.

```sh
# Linux
grep "^$(id -un):" /etc/subuid /etc/subgid

# macOS Podman machine
podman machine ssh 'grep "^$(id -un):" /etc/subuid /etc/subgid'
```

The fields are `user:first-id:count`. Do not infer the count from the first
ID. Podman machine configurations can differ, so the output from the machine
you run is authoritative.

### Other macOS differences

- **Start the VM after a host reboot.** Run `podman machine start` before
  Compose. A stopped machine leaves the API socket unavailable.
- **`DOCKER_HOST` is per-shell.** Without it, Docker Compose can select a
  Docker daemon or no daemon. Export it in your shell profile, or prefix each
  invocation.
- **The VM bounds all resource limits.** The sidecar `mem_limit` and `cpus`
  values cannot exceed the resources assigned to the machine. `ollama` alone
  has a 4 GiB limit; the 8 GiB setup above leaves memory for the app and other
  services.
- **Do not apply the Linux host's cgroup-delegation procedure to macOS.**
  Check limits inside the Podman machine if a container reports a resource
  limit error.

Primary references: [Podman `keep-id`](https://docs.podman.io/en/latest/markdown/podman-run.1.html#userns-mode),
[Podman machine](https://docs.podman.io/en/latest/markdown/podman-machine.1.html),
and [the Docker-compatible socket](https://podman-desktop.io/docs/migrating-from-docker/using-the-docker_host-environment-variable).

## MCP isolation

MCP servers run inside the extension runner, not on the app host. Since
#246 the host no longer spawns stdio MCP servers, so the old host stack
(user namespaces, the `mcp-launcher.sh` wrapper, bwrap tmpfs, the host
seccomp BPF and the Stage 2 veth bridge) does not apply to MCP servers.
The `EZCORP_MCP_STAGE1_*`, `EZCORP_MCP_STAGE2_*` and
`EZCORP_MCP_REQUIRE_SANDBOX` variables have no effect on MCP servers.

- **stdio servers** run in the release worker of an approved v4 release.
  The default Podman runner starts that worker rootless with
  `--network=none`, a read-only root filesystem, `--cap-drop=ALL`,
  `no-new-privileges`, a deny-by-default seccomp profile, user
  `65534:65534`, and cgroup memory, CPU and PID limits with a sized
  `/tmp`. Outbound requests leave only through the invocation's native
  proxy, which the host checks against the approved network grant. If
  the host cannot give rootless Podman, seccomp and cgroup v2
  controls, the runner refuses to start (`isolation_unavailable`).
- **`http` and `sse` servers** are called by the host through the
  guarded fetch. Every request URL must match the approved origin, the
  network grant and the permission engine, for the lifetime of the call.
- **Trusted-local mode** omits these controls by design. An operator
  must type consent to choose it, and each release digest needs its own
  approval. See [runner setup](../deploy/extension-runner/README.md).

## Reaching a local or LAN MCP server (`EZCORP_MCP_TARGET_ALLOW`)

Everything above confines an MCP server's *own* outbound traffic. The
opposite direction — the platform dialing an `http`/`sse` MCP endpoint
an admin configured — is guarded separately, because a caller-supplied
URL is an SSRF surface: without a check, `http://169.254.169.254/…`
(cloud metadata) or `http://10.0.0.5:6379` would be fetched by the
server itself.

By default every loopback, RFC-1918, link-local, CGNAT and IPv6-internal
address is **denied** for the `http` and `sse` transports. (`stdio`
spawns a process rather than dialing an address and is unaffected.)

Self-hosted deployments legitimately run MCP servers on localhost or the
LAN, so name those targets explicitly:

```sh
# Comma- or whitespace-separated. Hosts and/or CIDRs.
EZCORP_MCP_TARGET_ALLOW=127.0.0.1,::1,192.168.1.50,10.0.0.0/8,mcp.lan
```

- An **IP or CIDR** entry is matched against every resolved address —
  the safe form; DNS cannot move the target out from under it.
- A **hostname** entry vouches for the name and skips address
  validation entirely, so whoever controls DNS for that name controls
  the target. Prefer the IP/CIDR form.
- Malformed entries are dropped, which can only deny more.
- The value is re-read from `process.env` on every request, but Bun loads
  `.env` once at process start — so **editing `.env` does require a
  restart**. Treat it as a deploy-time setting like the flags above.
- A **mistyped entry is dropped, and the API cannot tell you.** A denied
  target returns the same opaque 502 as an unreachable one, deliberately.
  The `mcp-target-guard` log warns once per distinct value, naming the
  entry it did not understand — check there first if a target you
  allowlisted is still refused. Common rejects:
  `192.168.1.50:8080` (drop the port), `http://192.168.1.50` (host or
  CIDR, not a URL), and `10.0.0.0 / 8` (no spaces around `/`).

### `localhost` is dual-stack — allow both spellings

Every resolved address must clear the guard, and `localhost` resolves to
**both** `127.0.0.1` and `::1` on a dual-stack host. Allowing only one
still denies the target, with the same opaque 502:

```
allow="127.0.0.1"       http://localhost:3000/mcp  → DENY (localhost → ::1)
allow="127.0.0.1,::1"   http://localhost:3000/mcp  → ALLOW
```

Either list both, or point the URL at `127.0.0.1` directly. (This is the
same trap the `SEARXNG_BASE_URL` comment in `docker-compose.yml` calls
out for the search sidecar.)

### Reaching an MCP server in another container

`compose.prod.yml` declares no `networks:`, so it uses Docker's default
bridge — which lives in **`172.16.0.0/12`, inside the deny set**. The
natural wiring for an MCP sidecar, `http://mcp:8080/mcp`, is therefore
denied by default (reproduced: `http://mcp-server:8080/mcp → 172.18.0.4
→ DENY`). Two options:

```sh
# Either allow the bridge subnet. Note Docker REASSIGNS this on
# `down`/`up`, so pin the subnet in compose if you rely on it.
EZCORP_MCP_TARGET_ALLOW=172.18.0.0/16

# Or vouch for the service name. Simpler and stable across re-creates,
# but it SKIPS address validation — whoever controls that name controls
# the target. Fine for a compose service you define; not for a name
# resolved by anything you don't own.
EZCORP_MCP_TARGET_ALLOW=mcp
```

Nothing shipped is affected: no bundled extension is `kind:"mcp"` (zero
`mcpServers` across `src/extensions/bundled.ts` and `extensions/**`), so
the default-deny posture breaks no first-party functionality.

Note the dev stack (`docker-compose.yml`) is `network_mode: host` and
passes the variable through explicitly; it is the localhost case above,
not this one.

When a target is refused, the API returns the same generic 502 as any
unreachable server — deliberately, so the response cannot be used to
map the internal network. The real reason (`blocked`, `reason`,
`target`) is written to the **error log**, which is where to look when
an install "just fails". Full rationale:
[MCP server integration](features/tools/mcp-servers.md#outbound-target-guard-ssrf).

## Web search sidecar (SearXNG)

Both compose stacks ship a `searxng` service so the bundled
`web-search` extension (and anything built on it, e.g. Daily Briefing
watchlists) works with **zero API keys** on a fresh install. SearXNG is
a self-hosted metasearch engine — it fans queries out to upstream
engines and returns aggregated JSON.

**Resource footprint:** capped at `mem_limit: 256m` / `cpus: 0.5`
(measured ~140 MB RAM idle, ~0% CPU). `restart: unless-stopped`. The
caps are deliberate: an on-demand spin-up was considered and rejected —
it would need docker.sock (or a socket-proxy sidecar) reachable from
the app, which is host-root-equivalent exposure to save ~140 MB.

**Networking differs per stack:**

| Stack | App networking | SearXNG reachability | `SEARXNG_BASE_URL` default |
|---|---|---|---|
| dev (`docker-compose.yml`) | `network_mode: host` | publishes `127.0.0.1:8889` (loopback only) | `http://127.0.0.1:8889` |
| prod (`compose.prod.yml`) | compose bridge | service DNS, **no published port** | `http://searxng:8080` |

**Soft dependency:** the app never hard-depends on the sidecar. If
SearXNG is down or unreachable (connection refused / timeout / DNS /
network-permission denial), `search-web` retries once through keyless
DuckDuckGo and results are cached under the `duckduckgo` namespace.
HTTP errors from a *reachable* SearXNG surface as-is (misconfig is not
masked by the fallback).

**Config:** the committed `deploy/searxng/settings.yml` is mounted
read-only at `/etc/searxng`. It enables `search.formats: [html, json]`
(the JSON API is OFF in upstream defaults — without it the extension's
`format=json` requests get 403) and disables the bot limiter
(internal-only service). The instance secret comes from the
`SEARXNG_SECRET` env var, never from the committed file.

**Custom-host network grant:** the web-search extension's manifest
declares the internal hosts `searxng`, `localhost`, and `127.0.0.1`
(internal/RFC-1918 hosts route through the `ezcorp/network.internal`
PDP and must be declared explicitly). Pointing `SEARXNG_BASE_URL` at
any other hostname requires widening the extension's network grant in
`docs/extensions/examples/web-search/ezcorp.config.ts` AND the bundled
ceiling in `src/extensions/bundled-ceiling.ts`, then regenerating
`manifest.lock.json` — otherwise the PDP denies the host and search
falls back to DuckDuckGo (the deny lands in the audit log as an
`ext:perm:denied` row — check there, not stderr).

**Egress note:** SearXNG needs outbound internet access to its upstream
engines; the default bridge in both stacks provides it. If a hardened
deploy later air-gaps the app network, give `searxng` a second
egress-capable network.

## Suggestion-model sidecar (Ollama)

Both compose stacks ship an `ollama` service powering the composer's
prompt-enhancement suggestions (the tool-suggestion chips are in-process
embeddings and do not involve this sidecar). Same soft-dependency
contract as SearXNG: **no `depends_on`**, and when the service is down
or removed the app degrades gracefully — tool chips keep working, the
✨ enhancement row hides. Full feature doc:
[docs/features/composer/suggestions.md](features/composer/suggestions.md).

| Stack | App networking | Ollama reachability | Starts by default? | `EZCORP_SUGGEST_OLLAMA_URL` default |
|---|---|---|---|---|
| dev (`docker-compose.yml`) | `network_mode: host` | publishes `127.0.0.1:11434` (loopback only) | **No** — `--profile ollama` | `http://localhost:11434` |
| prod (`compose.prod.yml`) | compose bridge | service DNS, **no published port** | Yes | `http://ollama:11434` |

**Dev: the sidecar is opt-in.** 11434 is the well-known Ollama port, so
a dev box already running Ollama natively (Homebrew service, NixOS
`services.ollama`, a bare `ollama serve`) is holding it — and a lost
bind is not a degraded sidecar, it aborts the whole `up`:

```
Error response from daemon: failed to set up container networking:
failed to bind host port 127.0.0.1:11434/tcp: address already in use
```

postgres, app and searxng go down with it, over a service all three are
independent of. It also strands a half-created `ollama` container with
no network attached, so the *next* `up` fails somewhere unrelated —
`ollama-init` exits 1 on `lookup ollama on 127.0.0.11:53: no such
host`, which reads as a DNS bug rather than a port conflict.

So `docker compose up -d` leaves it alone. Start it when nothing else
holds the port:

```sh
docker compose --profile ollama up -d
```

Opting out costs nothing: the app is `network_mode: host` and points at
`http://localhost:11434`, which is answered by a host-native daemon or
by the opted-in container indifferently. A box with its own Ollama
already has working suggestions — just make sure it has the tag
`EZCORP_SUGGEST_MODEL` names (`ollama pull qwen3:1.7b`), since
`ollama-init` only provisions the container's volume. A box with
neither degrades gracefully, exactly as when the service is down.

Prod is **not** gated: it runs on the compose bridge and publishes no
host port for ollama, so it has no address to collide with and stays
zero-setup. `src/__tests__/compose-ollama-profile.test.ts` holds both
stacks to that rule — publish a host port for ollama in either file and
it demands a profile.

**Model provisioning:** the one-shot `ollama-init` service pulls
`EZCORP_SUGGEST_MODEL` (default `qwen3:1.7b`, ~1 GB, Apache-2.0) once
the server is healthy, then exits; weights persist in the
`ollama-models` named volume so the download happens once. GPU hosts
can set `EZCORP_SUGGEST_MODEL=qwen3:4b` (or any Ollama tag — including
a self-fine-tuned `ezcorp-suggest`, see the feature doc's runbook);
`ollama-init` pulls whatever is configured.

**Resource footprint:** capped at `mem_limit: 4g` / `cpus: 4` — a
1B-class Q4 model needs ~1.5 GB resident while generating and idles
near zero (Ollama unloads idle models after ~5 min). Expect 2–6 s per
enhancement on CPU; the UI treats it as ambient (never blocks typing).

**Opting out / BYO:** in dev, simply don't pass `--profile ollama`. In
prod, delete the `ollama` + `ollama-init` services and the
`ollama-models` volume to run without local suggestions — or point
`EZCORP_SUGGEST_OLLAMA_URL` at any existing Ollama / llama.cpp /
OpenAI-compatible endpoint (host-side reads only; this URL is never
handed to extensions). Admins can also kill the whole feature at
Settings → Personalization → Composer suggestions.

## Upgrade notes — bundled extensions disabled after a release

After upgrading EZCorp, a bundled extension whose manifest permissions
**legitimately widened** in the new release (e.g. `web-search` gaining
the keyless DuckDuckGo/SearXNG hosts) appears **disabled** in the
extensions list. That's the S6/S9 boot drift gate working as designed:
a non-critical bundled extension whose on-disk permissions or tool list
changed under a new version is disabled "pending re-approval"
(`ext:update-blocked` rows in the audit log show exactly what changed).

An admin re-approves the drift via the dedicated endpoint, which
re-grants from the **current on-disk manifest** (clamped to the
hardcoded bundled ceiling in `src/extensions/bundled-ceiling.ts` — the
ceiling stays the hard security bound), refreshes the stored manifest +
version, re-enables the row, and reloads the registry:

```bash
# As an admin (session cookie or an API key with the `extensions` scope):
curl -X POST \
  -H "Authorization: Bearer $EZCORP_API_KEY" \
  "$EZCORP_BASE_URL/api/extensions/<extension-id>/reapprove-drift"
```

The response carries the updated extension row plus a `diffs` summary
(`[{field, oldValue, newValue}]`) of what was granted. The call is
idempotent — with no drift it simply refreshes/re-enables and the
`diffs` array is empty. It can never widen beyond the bundled ceiling,
and the `manifest.lock.json` gate still applies: a manifest failing the
lockfile check is refused with 409 (the endpoint heals grant drift, not
tampering — regenerate the lockfile via
`bun run scripts/regenerate-manifest-lock.ts` if it's a legitimate
release artifact gap, see the manifest-lock notes).

A re-approve button in the extensions settings UI is a planned
follow-up; until then the curl above (or any HTTP client) is the
sanctioned path.

## Image size

Phase 7 + Phase 55 add these debian packages to `oven/bun:1-slim`:

- `util-linux` (~10 MB) — `unshare`, `prlimit`, `capsh`
- `iproute2` (~2 MB) — `ip`
- `iptables` (~7 MB) — `iptables-restore`
- `libcap2-bin` (~0.2 MB) — `capsh` runtime
- `bubblewrap` (~0.13 MB) — `bwrap` (Phase 55 / MCP-02 + MCP-03)
- `libseccomp2` (~0.05 MB) — runtime shared lib bwrap dlopens for
  the `--seccomp <fd>` path (Phase 55 / MCP-03)

Total growth: ~23 MB (+3 MB over Phase 7). These were installed for the
host MCP launcher, which is deleted (MCP servers run in the extension
runner since #246). `bubblewrap` still backs the agent-shell sandbox's
bwrap tier; the rest are candidates for removal. The image no longer
compiles a host MCP seccomp BPF.

## Resources

- `packages/@ezcorp/extension-runner/src/podman.ts` — the isolated worker
  (Podman flags, seccomp profile check, cgroup limits)
- `src/extensions/release-mcp-client.ts` — host-side MCP calls: release
  and grant checks for stdio, guarded fetch for `http`/`sse`
- `packages/@ezcorp/sdk/src/v4/mcp.ts` — the in-worker stdio MCP bridge

## Default extension runner

For personal GitHub connection configuration, see
[Personal GitHub](features/platform/personal-github.md#shared-app-setup).
The shared App uses device authorization; each self-hosted backend talks directly
to GitHub and stores its own encrypted tokens. The public Cloudflare Worker is
not a token relay. See [Worker deployment](../services/github-connect/README.md).

Dev and production Compose now connect to the isolated host runner by default.
Follow [runner setup](../deploy/extension-runner/README.md) before the first app
start. Existing installations must rebuild the app image, set the runner host
paths if they differ from the defaults, and recreate the app.

The app checks the authenticated connection before startup. If it reports
“Extension runner is not ready”, check the host service log, socket path, key
file permissions and configured application UID. A runner service error such as
`Executable not found in $PATH: "flock"` means its service PATH lacks util-linux;
on NixOS use the supplied service unit and install `pkgs.util-linux`.

The runner is a separate host service. Chat-only or non-Linux installations that
previously omitted it must choose a supported runner mode before using the
default Compose stack. The explicit trusted-local choice and its limits are in
the same setup guide.
