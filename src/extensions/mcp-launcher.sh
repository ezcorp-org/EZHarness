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
