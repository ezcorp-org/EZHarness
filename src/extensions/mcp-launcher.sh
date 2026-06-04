#!/bin/sh
# Phase 7 — MCP namespace launcher.
#
# Spawned by `mcp-sandbox.ts` via:
#   unshare -U -m --map-root-user -- mcp-launcher.sh \
#     <orig-prlimit-cmd> <orig-prlimit-args...>
#
# When this script runs we are inside a fresh user + mount namespace.
# We deliberately DO NOT enter a fresh network namespace (`-n`):
# Phase 7 fix-pass C2 found that doing so makes the host's loopback
# proxy unreachable to the MCP, and the workarounds (veth pairs,
# `http+unix://...` HTTPS_PROXY) either add deployment complexity or
# break stdlib HTTP clients. Per-host network enforcement is done by
# the forward proxy on host loopback (`mcp-proxy.ts`); the user
# namespace gives us cap-bounding-set isolation; the mount namespace
# gives us filesystem-table isolation; that's the v1 envelope.
#
# Our job inside the namespace:
#   1. Drop CAP_SYS_ADMIN. unshare needed it to enter the namespace; the
#      MCP must not retain it.
#   2. exec the original prlimit-wrapped command. argv[1..] is the full
#      `prlimit --rss=... --as=... <mcp-command> <mcp-args...>` chain
#      mcp-sandbox.ts built; we exec it verbatim.
#
# Failure mode: any step that errors aborts the launch. The MCP never
# starts, registry.getMcpClient throws, the operator sees a clear error.
# Fail-closed.

set -e

# Phase 58 / MCP-05 — Stage 2 veth + nftables setup inside the netns.
#
# Gated on EZCORP_MCP_STAGE2_VETH_ENABLED=1. When unset/zero, the
# launcher falls straight through to the existing bwrap branch
# (Stage 1 / Phase 55 — zero behavior change).
#
# Sequence (NON-NEGOTIABLE — Open Question 1 + Pitfall 4):
#   1. Block on FD 0 for the 1-byte handshake from the host process.
#      The host writes the byte AFTER `ip link set <ns> netns <pid>`
#      completes; without the handshake, the launcher's `ip addr add`
#      races the host's netns-move and fails with "no such device".
#   2. Bring up loopback (lo) — needed for in-namespace IPC if any.
#   3. Rename the namespace-side veth from `mcp-<8hex>-ns` to `eth0`
#      (ergonomic + matches downstream nftables / ip-addr-add commands).
#   4. ip link set eth0 up; ip addr add <vethIpv4> dev eth0
#   5. Default route via the bridge gateway (10.42.0.1 in default subnet).
#   6. Surgical per-iface IPv6 disable (eth0 + lo). Plan 02 uses `|| true`
#      mask transitionally; Plan 03 Task 2 hardens to strict abort-on-fail
#      so RC#3 contract is enforced at the launcher level.
#   7. nftables drop-all-egress + single allow-exception rule heredoc
#      (RESEARCH §Code Examples Example 2 — verbatim shape).
#
# After Stage 2 completes, falls through to the existing bwrap branch.
if [ "${EZCORP_MCP_STAGE2_VETH_ENABLED:-0}" = "1" ]; then
  # Handshake: block on stdin until the host process writes 1 byte after
  # `ip link set <ns-side> netns <child.pid>` completes. Per RESEARCH
  # Open Question 1, this is non-negotiable — without the handshake,
  # the launcher's `ip addr add eth0 ...` below races the host's
  # netns-move step and fails with "no such device".
  read -n 1 _stage2_handshake </dev/stdin || {
    echo "stage2: handshake read failed; aborting" >&2
    exit 99
  }

  # Bring up loopback (needed for any in-namespace IPC).
  ip link set lo up >/dev/null 2>&1 || true

  # Rename the namespace-side veth from `mcp-<8hex>-ns` to `eth0`. The
  # host placed the peer in this namespace by PID; it currently carries
  # its original 15-char name. Downstream `ip addr add` + nftables rules
  # reference `eth0` for ergonomics.
  ip link set "${EZCORP_MCP_VETH_PEER_NAME}" name eth0 || {
    echo "stage2: rename ${EZCORP_MCP_VETH_PEER_NAME}->eth0 failed" >&2
    exit 98
  }
  ip link set eth0 up
  ip addr add "${EZCORP_MCP_VETH_IPV4}" dev eth0

  # Default route via the bridge gateway (10.42.0.1 in default subnet).
  # EZCORP_MCP_PROXY_HOST_GATEWAY is "10.42.0.1:NNNN" — strip port suffix
  # with shell parameter expansion `${var%:*}`.
  ip route add default via "${EZCORP_MCP_PROXY_HOST_GATEWAY%:*}"

  # IPv6 surgical disable per-iface (Pitfall 4 — namespace-scoped).
  # eth0 = renamed veth peer. lo = namespace loopback. Both required.
  #
  # Plan 03 Task 2 hardening: STRICT abort-on-fail. RC#3 requires the
  # IPv6 stack to be STRUCTURALLY absent inside the netns. Running with
  # IPv6 enabled and relying on nft filtering alone is a documented
  # bug — the netstack would still resolve AAAA records and reach
  # whatever isn't covered by the egress rule.
  #
  # Plan 02 used `|| true` transitionally; this is the contract-enforce
  # rewrite. The exit codes (96/97) discriminate which sysctl failed
  # so operators reading container logs see the precise failure.
  sysctl -w "net.ipv6.conf.eth0.disable_ipv6=1" >/dev/null || {
    echo "stage2: IPv6 disable on eth0 failed; aborting (RC#3 contract)" >&2
    exit 97
  }
  sysctl -w "net.ipv6.conf.lo.disable_ipv6=1" >/dev/null || {
    echo "stage2: IPv6 disable on lo failed; aborting (RC#3 contract)" >&2
    exit 96
  }

  # nftables: drop ALL egress except tcp to the proxy gateway:port.
  # ip daddr match prevents bypass via a different bridge-IP guess.
  # RESEARCH §Code Examples Example 2 — heredoc shape verbatim.
  nft -f - <<EOF
table inet mcp-egress {
  chain output {
    type filter hook output priority 0; policy drop;
    ip daddr ${EZCORP_MCP_PROXY_HOST_GATEWAY%:*} tcp dport ${EZCORP_MCP_PROXY_HOST_GATEWAY##*:} accept
  }
}
EOF
  # End of Stage 2 setup; fall through to existing bwrap branch.
fi

# Secure User-Site Preview / Port Exposure (Phase 1) — minimal-bind jail.
#
# For UNTRUSTED preview processes (dynamic dev servers — arbitrary code)
# the `--bind / /` envelope used by the MCP branch below is NOT safe: it
# exposes `<projectRoot>/.ezcorp/data` (PGlite DB + encrypted JWT secret)
# to the child. When `EZCORP_PREVIEW_JAIL=1`, the HOST
# (`src/extensions/preview-jail.ts:buildPreviewJailBwrapArgs`) has already
# constructed the COMPLETE bwrap argv with an explicit minimal bind set
# (work dir rw + ro /usr,/bin,/lib + tmpfs /tmp; NO root bind; nothing
# under .ezcorp/data) and passed it as "$@". We exec it verbatim — the
# launcher does NOT re-derive the bind set (DRY: the builder is the single
# source of truth + the unit-tested invariant). This branch is wired but
# the live dynamic-server spawn that drives it lands in Phase 3.
if [ "${EZCORP_PREVIEW_JAIL:-0}" = "1" ]; then
  exec bwrap "$@"
fi

# Plan 55-02 (MCP-02): optional bubblewrap wrap with a private 64 MB
# tmpfs at /tmp. Closes the host-/tmp side-channel leak: without this
# wrap one MCP can read another's scratch files and an MCP can read
# /tmp dotfiles from the host. Activated by `mcp-sandbox.ts` only when
# the host has `bwrap` available AND the kill-switch
# (EZCORP_MCP_STAGE1_TMPFS=0) is not set.
#
# Plan 55-03 (MCP-03) extension: when `EZCORP_MCP_BWRAP_SECCOMP_FD` is
# set in the environment, the conditional appends `--seccomp <fd>` to
# the bwrap argv. The FD points at the precompiled BPF blob at
# /app/src/extensions/mcp-seccomp.bpf (opened by mcp-sandbox.ts and
# passed through Bun.spawn's stdio array at the named FD index).
#
# argv invariants this branch MUST hold (mirrors plans 55-02 + 55-03
# must_haves):
#   - `--size 67108864` precedes `--tmpfs /tmp` (Pitfall 1 — sequential
#     state machine; reversal silently rejects the size cap).
#   - NO `--unshare-pid` — Phase 55's MCP-03 journalctl audit reader
#     needs the host PID namespace visible so `pid=` matches mcpChild.pid
#     (Pitfall 3). Phase 58 may revisit.
#   - NO `--unshare-user` and NO `--userns=keep-current` — the outer
#     `unshare -U -m --map-root-user` already created the user
#     namespace. On bubblewrap 0.8 (Debian bookworm — the production
#     target) the `--userns=keep-current` flag does not exist; bwrap
#     versions that ship without setuid (which is the case in Docker)
#     skip the `--unshare-user` step automatically when it's not
#     requested, inheriting the parent userns. This is Pattern B from
#     RESEARCH.md Open Question 1 — minimum diff that preserves the
#     existing MCP_NETNS_CREATED audit semantics.
#   - `--bind / /` so the MCP sees the host's filesystem layout (its
#     own binaries, libs, the per-extension data dir) — only /tmp is
#     swapped out for the private tmpfs.
#   - When seccomp is active, `--seccomp <fd>` is appended AFTER the
#     tmpfs flags and BEFORE the `--` argv terminator. The FD value is
#     whatever the caller put in EZCORP_MCP_BWRAP_SECCOMP_FD (always 3
#     in production — the conventional FD slot we copy into).
if [ "${EZCORP_MCP_BWRAP_ENABLED:-0}" = "1" ]; then
  if [ -n "${EZCORP_MCP_BWRAP_SECCOMP_FD:-}" ]; then
    exec bwrap \
      --proc /proc \
      --dev /dev \
      --bind / / \
      --size 67108864 \
      --tmpfs /tmp \
      --seccomp "$EZCORP_MCP_BWRAP_SECCOMP_FD" \
      -- "$@"
  else
    exec bwrap \
      --proc /proc \
      --dev /dev \
      --bind / / \
      --size 67108864 \
      --tmpfs /tmp \
      -- "$@"
  fi
fi

# Step 1: drop capabilities — best-effort.
#
# Inside an unprivileged userns we ARE "root" but the bounding set is
# inherited from the parent process; CAP_SYS_ADMIN drop via capsh requires
# CAP_SETPCAP on some kernels, which we don't have. capsh on NixOS also
# misbehaves with non-script targets ("cannot execute binary file"). The
# primary security gate moved to the forward proxy (per-host PDP) +
# bearer-token auth at the loopback listener; cap-drop is icing.
#
# We probe with `/bin/true` and only `exec capsh ...` when the probe
# succeeds. Otherwise fall through to a direct exec.
if command -v capsh >/dev/null 2>&1; then
  if capsh --drop=cap_sys_admin -- /bin/true >/dev/null 2>&1; then
    exec capsh --drop=cap_sys_admin -- "$@"
  fi
fi
# Fallback: exec the inner command directly. The proxy + per-host PDP
# is the primary network gate; the userns + prlimit envelope still
# bounds resource usage even without the cap drop.
exec "$@"
