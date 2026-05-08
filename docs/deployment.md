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
Kubernetes NetworkPolicy. Phase 7's MCP isolation stack works **with**
isolated networking, not against it. The container's outbound network
goes through whatever firewall / egress proxy your platform uses; the
per-MCP forward proxy operates entirely inside the container.

## MCP isolation — kernel + capabilities

Phase 7 isolates every stdio MCP server in its own user+net+mount
namespace. The kernel must allow unprivileged user namespace creation
for this to work. There are two ways to satisfy that:

### Option A — set `kernel.unprivileged_userns_clone=1` (preferred)

On the host kernel:

```sh
sudo sysctl -w kernel.unprivileged_userns_clone=1
echo 'kernel.unprivileged_userns_clone=1' | \
  sudo tee /etc/sysctl.d/40-ezcorp-userns.conf
```

This is the default on most modern distributions (Ubuntu 22.04+,
Debian 12+, Fedora 38+, Arch). Some hardened images (Alpine, RHEL with
strict SELinux) ship with `0`; you have to opt in.

### Option B — run with `--cap-add=NET_ADMIN`

If you cannot change the host sysctl, grant the container `NET_ADMIN`:

```sh
docker run --cap-add=NET_ADMIN ... ezcorp:latest
```

Or in `compose.prod.yml`:

```yaml
services:
  app:
    cap_add:
      - NET_ADMIN
```

This widens the container's privilege boundary slightly. Prefer Option A
when the host cooperates.

### Modern kernels (5.10+)

Kernels 5.10 and later **dropped** the `unprivileged_userns_clone`
sysctl knob; userns is enabled by default. EZCorp's `probeNetnsAvailability`
handles all three variants:

1. Knob present + `1` → ok
2. Knob present + `0` → falls back to HTTPS_PROXY-only mode
3. Knob absent → checks `/proc/sys/user/max_user_namespaces > 0` and
   does a live `unshare -U -n -m --map-root-user true` test. Both ok →
   netns mode.

If both checks fail the container still boots — but every MCP server
spawn writes a `ext:mcp:netns-fallback` audit row and the container
operates in HTTPS_PROXY-only mode. That mode is **bypassable** by any
MCP that uses raw libc sockets (a malicious binary could ignore
`HTTPS_PROXY` and connect directly). Stdlib HTTP clients (Python
`requests`, Go `net/http`, Node `http`, curl) all honor the env var.

## Audit signals — fleet monitoring

The `audit_log` table writes one row per significant decision. For
fleet-wide visibility into MCP isolation health, filter on these
actions:

| Action                       | Meaning                                  | Action expected           |
| ---------------------------- | ---------------------------------------- | ------------------------- |
| `ext:mcp:netns-created`      | Namespace successfully entered           | None — happy path         |
| `ext:mcp:netns-fallback`     | Less-strict mode (HTTPS_PROXY only)      | Investigate kernel config |
| `ext:mcp:host-blocked`       | Proxy denied a CONNECT (auth/host/quota) | Investigate `metadata.reason` |

A spike in `ext:mcp:netns-fallback` across a fleet usually means a
config-management drift on the kernel knob or a base-image change.
A spike in `ext:mcp:host-blocked` with `reason: "host"` typically means
an MCP extension was updated and is trying to reach a host the install
grant didn't include — you'll want to either revoke or re-prompt.

## Image size

Phase 7 adds these debian packages to `oven/bun:1-slim`:

- `util-linux` (~10 MB) — `unshare`, `prlimit`, `capsh`
- `iproute2` (~2 MB) — `ip`
- `iptables` (~7 MB) — `iptables-restore`
- `libcap2-bin` (~0.2 MB) — `capsh` runtime

Total growth: ~20 MB. We need them at runtime (each MCP spawn shells
out), so a multi-stage strip-down isn't possible without losing the
isolation feature.

## Resources

- `src/extensions/mcp-netns.ts` — probe + spawn-arg builder
- `src/extensions/mcp-proxy.ts` — forward-proxy implementation
- `src/extensions/mcp-launcher.sh` — the in-namespace setup script
- `tasks/phase-7-mcp-isolation.md` — full spec (gitignored, not
  committed; in the development worktree only)
