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

| Action                          | Meaning                                                | Action expected               |
| ------------------------------- | ------------------------------------------------------ | ----------------------------- |
| `ext:mcp:netns-created`         | Namespace successfully entered                         | None — happy path             |
| `ext:mcp:netns-fallback`        | Less-strict mode OR Stage 1 kill-switch active         | Investigate `metadata.reason` |
| `ext:mcp:host-blocked`          | Proxy denied a CONNECT (auth/host/rebind/quota)        | Investigate `metadata.reason` |
| `ext:mcp:seccomp-violation`     | Kernel logged a syscall via SCMP_ACT_LOG (Phase 55)    | Triage; see soak signal below |
| `ext:mcp:sandbox-required-refusal` | Spawn refused: `EZCORP_MCP_REQUIRE_SANDBOX=1` + degraded host | Fix `metadata.requiredCapability` / `metadata.reason` |

A spike in `ext:mcp:netns-fallback` across a fleet usually means a
config-management drift on the kernel knob or a base-image change.
A spike in `ext:mcp:host-blocked` with `reason: "host"` typically means
an MCP extension was updated and is trying to reach a host the install
grant didn't include — you'll want to either revoke or re-prompt.

## Stage 1 kill-switches

Phase 55 introduces three operator escape hatches, each disabling one
Stage 1 hardening feature independently. They are intended for emergency
fleet rollback ONLY — production deployments should leave them unset.

| Env var                              | Disables                                            | Audit-row reason discriminator       |
| ------------------------------------ | --------------------------------------------------- | ------------------------------------ |
| `EZCORP_MCP_STAGE1_DNS_RECHECK=0`    | DNS-rebind recheck at MCP proxy CONNECT (Plan 01)   | `kill-switch: dns-recheck disabled`  |
| `EZCORP_MCP_STAGE1_TMPFS=0`          | bubblewrap tmpfs wrap at MCP spawn (Plan 02)        | `kill-switch: tmpfs disabled`        |
| `EZCORP_MCP_STAGE1_SECCOMP=0`        | seccomp BPF load (Phase 55 / Plan 03 log-mode)      | `kill-switch: seccomp disabled`      |

**All three are boot-time-only.** The env vars are read once when the
host process starts. To change a kill-switch state, restart the
container; setting a variable via `docker exec` post-boot has no effect
on already-running MCPs.

**All three uniformly emit a one-time `MCP_NETNS_FALLBACK` boot row on
first activation.** The row reaches `/audit` so operators can confirm
which hardening features are disabled without needing shell access.
The flag persists for the lifetime of the host process — the row is
NOT re-emitted for every subsequent MCP spawn (otherwise it would
flood the audit log).

## MCP soak signal — bundled-corpus caveat

Phase 55 ships the seccomp profile in `SCMP_ACT_LOG` mode (no
enforcement; observability only). Phase 58 owns the readiness gate
that flips the profile to `SCMP_ACT_ERRNO`: **≥7 days with zero
`ext:mcp:seccomp-violation` rows** across the deployed MCP corpus.

**Important — bundled extension corpus has no MCPs today.** A grep
across the bundled extensions (`docs/extensions/examples/`,
`packages/@ezcorp/ai-kit/`, `extensions/`) returns zero `mcpServers`
entries. The soak signal must therefore come from the **deployed**
corpus — whatever MCPs the operator has installed in their production
deployment. Self-hosters running zero MCPs will trivially clear the
gate; they're not exercising the profile.

**Because Phase 55 uses `SCMP_ACT_LOG` (never `SCMP_ACT_KILL` or
`SCMP_ACT_TRAP`), SIGSYS exits are structurally impossible during the
soak window.** Roadmap Success Criterion #3's "no SIGSYS on bundled
corpus" clause is satisfied by construction; the soak's job is to
surface candidates for the Phase 58 enforce-mode flip.

Phase 58 also revisits whether to ship a synthetic test MCP in dev/test
images to exercise the profile in CI. DEFERRED in Phase 55 — recorded
as a follow-up todo. Until then, the soak signal is only meaningful on
hosts running ≥1 production MCP.

## Stage 1 seccomp — manual verification fallback

The automated integration test in
`src/__tests__/mcp-netns-integration.test.ts` ("seccomp log →
MCP_SECCOMP_VIOLATION audit row") SKIPs cleanly when any of these
conditions hold:

- `process.platform !== 'linux'` (macOS / Windows dev)
- `/usr/bin/bwrap` absent
- `/app/src/extensions/mcp-seccomp.bpf` absent (image built without
  the compile stage; almost always means a dev-host source-tree)
- `/proc/sys/kernel/seccomp/actions_logged` absent OR doesn't contain
  `log` (hardened kernel)
- `gcc` not on PATH (purged from the runtime image — likely outcome)
- `journalctl` not on PATH

When the automated test SKIPs, operators verifying MCP-03 manually
must follow this checklist:

1. SSH into a running container: `docker exec -it ezcorp /bin/sh`.
2. Verify the BPF blob: `ls -la /app/src/extensions/mcp-seccomp.bpf`
   — should exist and be non-empty.
3. Verify `bwrap` is installed: `which bwrap && bwrap --version`.
4. Verify `actions_logged` is permissive:
   `cat /proc/sys/kernel/seccomp/actions_logged | grep log`.
5. Trigger a known-logged syscall by spawning an MCP that calls one
   (e.g. `ptrace`). On a probe-friendly container with gcc available
   inside, compile this and run it via the MCP launcher:
   ```c
   #include <sys/ptrace.h>
   int main(void) { ptrace(PTRACE_TRACEME, 0, 0, 0); return 0; }
   ```
6. Tail the kernel audit ring:
   `journalctl -k --since=-1m | grep "type=1326"`.
   Confirm at least one matching line with the probe's PID.
7. Open `/audit` in the UI, filter `action = MCP_SECCOMP_VIOLATION`,
   confirm the row appears with matching `metadata.pid` +
   `metadata.syscall`.
8. If any of the above fails, file a bug. Do NOT ship Phase 58
   enforce mode until the soak signal provably reaches `audit_log`.

## Stage 2 prerequisites

Phase 58 lands kernel-level network isolation for MCP extensions via
a per-MCP veth pair attached to `br-ezcorp-mcp` + nftables drop-all-
egress rules. The Stage 2 path adds three operator requirements on top
of the Stage 1 envelope:

- **`CAP_NET_ADMIN` required.** Run with `docker run --cap-add=NET_ADMIN
  ...` (or systemd unit with `AmbientCapabilities=CAP_NET_ADMIN`).
  Without it: `initStage2` bridge create fails at boot → host degrades
  to Stage 1 + emits `MCP_NETNS_FALLBACK` boot row with
  `reason='stage2 unavailable: CAP_NET_ADMIN missing'`. Every MCP runs
  through the Phase 55 launcher (bwrap + seccomp + tmpfs) but with no
  kernel-level network isolation.

- **Conntrack sysctl floor: `net.netfilter.nf_conntrack_max >= 262144`.**
  Container with `--cap-add=NET_ADMIN` writes this idempotently at boot
  via `ensureConntrackCeiling` (`src/extensions/mcp-bridge.ts`).
  Operators on Option A (host sysctl, no NET_ADMIN) must set it
  themselves: `sysctl -w net.netfilter.nf_conntrack_max=262144` +
  persist via `/etc/sysctl.d/`. Note: Debian bookworm with ≥4GB RAM
  already defaults to 262144 — the bump is a floor-guarantee, not a
  4× increase on most production hosts.

- **Image growth.** Phase 58 adds `nftables` (~3 MB) on top of Phase
  55's `bubblewrap` + `libseccomp2` + BPF blob (~23 MB). Cumulative
  growth on top of Phase 53 `oven/bun:1-slim` baseline: ~26 MB.

- **Container resource sizing.** With 60 concurrent MCPs allowed (the
  `allocVethSlot` cap) and ~30 MB tmpfs per MCP, the host needs
  ~2 GB headroom for MCP workloads.

## Stage 2 readiness checklist (MCP-04 seccomp enforce flip)

The MCP-04 seccomp enforce flip (Plan 58-01 — `mcp-seccomp.json`
`defaultAction: SCMP_ACT_LOG → SCMP_ACT_ERRNO`) ships behind an
operator-judged readiness gate. Before approving the flip merge,
operators MUST verify ≥7 days of clean soak across deployed MCPs.

1. **Open the audit query.** On your production EZCorp instance,
   navigate to `/audit?action=MCP_SECCOMP_VIOLATION&since=7d`.

2. **Zero rows over 7 days → soak clean.** Approve the flip merge.
   Skip steps 3–4.

3. **Rows returned → triage each.** For benign syscalls (Bun JIT
   `pkey_alloc`, Python 3.12 glibc `clock_gettime64` time64 probe),
   add an explicit `SCMP_ACT_ALLOW` entry to `mcp-seccomp.json` and
   re-soak for 7 days. For genuinely malicious syscalls (the
   `ptrace`/`process_vm_readv`/`init_module`/`mount` family), the
   flip is the intended response — those syscalls *should* be
   blocked.

4. **Why operator-judged?** The bundled MCP corpus has zero MCPs; the
   soak signal exists only in deployed audit DBs that the EZCorp main
   branch never sees. The flip merge is gated on YOUR
   `MCP_SECCOMP_VIOLATION` query returning zero rows over 7 days, not
   on a CI test. The CONTEXT.md §Soak gate enforcement covers the
   rationale in full.

## Stage 2 kill-switches

Phase 58 extends the Stage 1 kill-switch table with two additional
env vars. Same boot-time-only semantics as the Stage 1 switches.

| Env var                                  | Disables / Controls                                           | Audit-row reason discriminator              |
| ---------------------------------------- | ------------------------------------------------------------- | ------------------------------------------- |
| `EZCORP_MCP_STAGE2_VETH=0`               | Skip the veth wrap; fall back to Stage 1 (Plan 58-02)         | `kill-switch: stage2 veth disabled`         |
| `EZCORP_MCP_STAGE2_BRIDGE_SUBNET=<cidr>` | Override 10.42.0.0/24 default. Validated as /8..30 CIDR.      | (invalid → `stage2 invalid bridge subnet`)  |

- `EZCORP_MCP_STAGE2_VETH=0` emits one-time `MCP_NETNS_FALLBACK` boot
  row with `reason='kill-switch: stage2 veth disabled'`. The host
  process degrades every Stage 2 spawn to Stage 1 (bwrap + seccomp
  envelope; no kernel-level network isolation).

- `EZCORP_MCP_STAGE2_BRIDGE_SUBNET=<cidr>` is CIDR-validated at boot
  (`isValidCidr` in `mcp-netns.ts`). Invalid values (e.g.
  `EZCORP_MCP_STAGE2_BRIDGE_SUBNET=garbage`) fall back to the default
  10.42.0.0/24 and emit `MCP_NETNS_FALLBACK` with
  `reason='stage2 invalid bridge subnet'`. The Stage 2 stack still
  comes up on the default.

Existing Plan 55 kill-switches (`EZCORP_MCP_STAGE1_DNS_RECHECK`,
`EZCORP_MCP_STAGE1_TMPFS`, `EZCORP_MCP_STAGE1_SECCOMP`) are unchanged.

## Fail-closed sandbox enforcement (`EZCORP_MCP_REQUIRE_SANDBOX`)

By default, every isolation fallback above **fails open**: when the
host can't deliver an isolation layer, the MCP spawn proceeds at a
weaker stage and the only signal is a fire-and-forget
`ext:mcp:netns-fallback` audit row. On many real Docker hosts the
netns/veth stack cannot be set up even with `--privileged`, which
means untrusted MCP extensions silently run **without kernel network
isolation** — outbound traffic is gated only by the `HTTPS_PROXY`
env-var convention, which raw-socket binaries can bypass.

### Host kernel requirements for full isolation

A spawn runs at *full isolation* only when ALL of these hold:

- **Stage 1 userns wrap** — unprivileged user+mount namespaces enabled
  (`unshare` on PATH, `kernel.unprivileged_userns_clone` permits it,
  `max_user_namespaces > 0`; see "MCP isolation — kernel + capabilities"
  above).
- **bubblewrap tmpfs** — `bwrap` installed and a minimal probe
  invocation succeeds.
- **seccomp BPF profile** — the compiled blob
  (`/app/src/extensions/mcp-seccomp.bpf`) present in the image (built
  by the Docker compile stage; absent on plain source-tree dev hosts).
- **Stage 2 veth network isolation** — `ip` + `nft` on PATH,
  `CAP_NET_ADMIN` granted, the `br-ezcorp-mcp` bridge up
  (see "Stage 2 prerequisites" above), a free veth slot (60 concurrent
  MCP cap), and the per-spawn veth create/attach succeeding.
- **No Stage 1/2 kill-switch active** (`EZCORP_MCP_STAGE1_TMPFS=0`,
  `EZCORP_MCP_STAGE1_SECCOMP=0`, `EZCORP_MCP_STAGE2_VETH=0` each
  disable a layer and therefore count as degraded).

### What degradation means

When any requirement is missing and the flag is unset, the spawn
*degrades*: it still runs, but in a weaker envelope (in the worst case
prlimit + `HTTPS_PROXY` only — no namespace, no tmpfs, no seccomp, no
kernel-level network isolation). The degrade is recorded as
`ext:mcp:netns-fallback`, but nothing stops the spawn.

### The fail-closed switch

Set `EZCORP_MCP_REQUIRE_SANDBOX=1` to refuse any spawn that would
degrade below full isolation. The spawn fails with an error naming the
missing capability and this flag (surfaced through the same path as
any other MCP spawn failure, e.g. tool-call errors), and one
`ext:mcp:sandbox-required-refusal` audit row is written per refusal
with `metadata.requiredCapability` + `metadata.reason` identifying
exactly which leg to fix.

- Unset, or any value other than `"1"`: fail-open degrade, exactly as
  before the flag existed.
- The flag is read per spawn; like the kill-switches, treat it as a
  deploy-time setting and restart the container after changing it.
- Recommended for production fleets that treat MCP extensions as
  untrusted: pair it with the Stage 2 prerequisites above, and watch
  `ext:mcp:sandbox-required-refusal` instead of grepping
  `ext:mcp:netns-fallback` spikes.

## 24h conntrack soak — manual verification (RC#2 fallback)

ROADMAP Success Criterion #2 requires: "20 concurrent MCPs × 1000
requests, 24h, `nf_conntrack_count` stays below 50% of
`nf_conntrack_max`, no `nf_conntrack: table full` line in dmesg."

This is too large for the standard CI pipeline. The MCP-05 split:

- **CI proxy (5 min):** `src/__tests__/mcp-stage2-conntrack-soak.test.ts`
  runs a scaled 4-concurrent × 100-request synthetic load — same
  density as the operator scenario, 50× shorter. Gates regression but
  cannot prove the absolute 24h × 20 × 1000 criterion. Default-skipped
  to avoid CI bloat; opt-in via `EZCORP_RUN_CONNTRACK_SOAK=1`.

- **Operator fallback (24h):** `scripts/mcp-conntrack-soak-24h.sh` on
  a staging host. Default duration 24h (86400s); pass a shorter
  duration as `$1` for local smoke tests. Output: peak conntrack count,
  peak ratio, dmesg table-full count, PASS/FAIL verdict. Exit code 0
  = PASS (RC#2 satisfied).

  ```bash
  # Full 24h validation:
  bash scripts/mcp-conntrack-soak-24h.sh

  # 5-minute smoke test:
  bash scripts/mcp-conntrack-soak-24h.sh 300
  ```

Requirements: `CAP_NET_ADMIN` + ~2 GB free RAM + the synthetic-MCP
fixture (`tests/fixtures/synthetic-mcp/loop.ts`).

## MCP_SECCOMP_VIOLATION metadata.code shift (Phase 55 → Phase 58)

Phase 55's log-mode (`SCMP_ACT_LOG`) and Phase 58's enforce-mode
(`SCMP_ACT_ERRNO`) both emit `MCP_SECCOMP_VIOLATION` audit rows from
the same `runMcpSeccompSoakReader` code path. The action name stays
stable for SIEM dashboard continuity; the `metadata.code` field
distinguishes the two modes:

- `metadata.code === '0x7ffc0000'` — `SECCOMP_RET_LOG` (Phase 55,
  observed-only mode)
- `metadata.code === '0x00050001'` — `SECCOMP_RET_ERRNO` (Phase 58,
  killed-or-errno'd mode)

**SIEM operators filtering on `metadata.code` should expect the shift
and update their dashboards before the flip merges.** The
`audit-actions.ts` JSDoc for `MCP_SECCOMP_VIOLATION` carries both
values verbatim.

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
| dev (`docker-compose.yml`) | `network_mode: host` | publishes `127.0.0.1:8889` (loopback only) | `http://localhost:8889` |
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
falls back to DuckDuckGo (the deny is logged).

**Egress note:** SearXNG needs outbound internet access to its upstream
engines; the default bridge in both stacks provides it. If a hardened
deploy later air-gaps the app network, give `searxng` a second
egress-capable network.

## Image size

Phase 7 + Phase 55 add these debian packages to `oven/bun:1-slim`:

- `util-linux` (~10 MB) — `unshare`, `prlimit`, `capsh`
- `iproute2` (~2 MB) — `ip`
- `iptables` (~7 MB) — `iptables-restore`
- `libcap2-bin` (~0.2 MB) — `capsh` runtime
- `bubblewrap` (~0.13 MB) — `bwrap` (Phase 55 / MCP-02 + MCP-03)
- `libseccomp2` (~0.05 MB) — runtime shared lib bwrap dlopens for
  the `--seccomp <fd>` path (Phase 55 / MCP-03)

Total growth: ~23 MB (+3 MB over Phase 7). The image also contains
a precompiled cBPF blob at `/app/src/extensions/mcp-seccomp.bpf`
(~7 KB) generated at build time from the committed JSON profile via
`build/compile-seccomp.c`. The build-stage deps (`gcc`,
`libseccomp-dev`, `libc6-dev`) are apt-installed and purged in the
same RUN so they don't bloat the runtime layer.

## Resources

- `src/extensions/mcp-netns.ts` — probe + spawn-arg builder
- `src/extensions/mcp-proxy.ts` — forward-proxy implementation (Plan 01
  DNS-rebind recheck lives here)
- `src/extensions/mcp-launcher.sh` — the in-namespace setup script
  (Plan 02 bwrap tmpfs branch; Plan 03 `--seccomp <fd>` extension)
- `src/extensions/mcp-sandbox.ts` — spawn-spec builder; threads
  HTTPS_PROXY, bwrap-enable, and seccomp FD env vars + emits the
  Stage 1 kill-switch boot rows
- `src/extensions/runtime/dns.ts` — Bun.dns.lookup seam (Plan 01)
- `src/extensions/runtime/seccomp-loader.ts` — opens the precompiled
  BPF blob (Plan 03)
- `src/extensions/runtime/seccomp-soak-reader.ts` — parses
  `journalctl -k` for `audit: type=1326` lines, emits
  `MCP_SECCOMP_VIOLATION` rows (Plan 03)
- `src/extensions/mcp-seccomp.json` — source-of-truth profile (Plan 03)
- `build/compile-seccomp.c` — JSON→BPF transformer (build-time)
- `scripts/check-seccomp-bpf-fresh.sh` — CI guard for BPF artifact
  freshness vs the committed JSON
- `tasks/phase-7-mcp-isolation.md` — full spec (gitignored, not
  committed; in the development worktree only)
- `.planning/phases/55-mcp-stage-1-dns-rebind-tmpfs-seccomp-log-mode/`
  — Phase 55 plan + summaries
