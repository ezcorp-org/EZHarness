/**
 * Linux user-namespace integration test for the Phase 7 MCP isolation
 * stack. Skips cleanly on macOS / Windows / hardened-Linux hosts.
 *
 * Coverage gate (any failure → test.skipIf):
 *   - `process.platform === "linux"`
 *   - `unshare` on PATH (Phase 7 fix-pass C2 dropped `ip` and `iptables`
 *     requirements — the launcher no longer touches network state)
 *   - `kernel.unprivileged_userns_clone` knob is `1` OR absent (modern
 *     kernel) AND `max_user_namespaces > 0`
 *   - A live `unshare -U -m --map-root-user true` exits 0
 *
 * What we prove (when the gate passes):
 *   1. `buildNetnsSpawnArgs` produces an `unshare -U -m -- launcher.sh`
 *      chain that the kernel actually accepts — `-n` was deliberately
 *      dropped in the fix-pass to keep the host's loopback proxy
 *      reachable from inside the namespace.
 *   2. From inside the namespace, the host's loopback IS reachable
 *      (`curl http://127.0.0.1:<host-port>` succeeds when a listener
 *      is up). Phase 7 fix-pass C2 — proves the architectural
 *      decision: shared netns + per-host PDP at the proxy.
 *   3. End-to-end HTTPS_PROXY round-trip — spawn the launcher, set
 *      HTTPS_PROXY env to the proxy URL, run curl through it, observe
 *      the proxy's CONNECT row in the audit tape. This is the M2 fix
 *      validation that the previous Phase 7 commits were missing.
 */

import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { existsSync, readFileSync } from "node:fs";

// Audit mock — the integration test asserts on rows the proxy writes
// when the curl-via-HTTPS_PROXY round-trip lands.
const auditCalls: Array<{ action: string; metadata: Record<string, unknown> | null }> = [];
mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    _userId: string | null,
    action: string,
    _target?: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> => {
    auditCalls.push({ action, metadata: metadata ?? null });
    return `audit-${auditCalls.length}`;
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

import {
  buildNetnsSpawnArgs,
  probeNetnsAvailability,
  getDefaultLauncherPath,
  _resetProbeCacheForTests,
} from "../extensions/mcp-netns";
import { createMcpProxy } from "../extensions/mcp-proxy";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";

afterAll(() => restoreModuleMocks());

function netnsAvailableOrSkip(): boolean {
  if (process.platform !== "linux") return false;
  if (!Bun.which("unshare")) return false;
  // Legacy knob check (modern kernels drop it)
  const userNsKnob = "/proc/sys/kernel/unprivileged_userns_clone";
  if (existsSync(userNsKnob)) {
    const value = readFileSync(userNsKnob, "utf8").trim();
    if (value !== "1") return false;
  }
  // max_user_namespaces > 0
  const maxKnob = "/proc/sys/user/max_user_namespaces";
  if (existsSync(maxKnob)) {
    const v = Number.parseInt(readFileSync(maxKnob, "utf8").trim(), 10);
    if (Number.isFinite(v) && v === 0) return false;
  }
  // Live test — same flags the production wrap uses.
  const probe = Bun.spawnSync({
    cmd: ["unshare", "-U", "-m", "--map-root-user", "true"],
    stdout: "ignore",
    stderr: "ignore",
  });
  return probe.success;
}

const SKIP = !netnsAvailableOrSkip();

// Resolve a curl-capable shell. NixOS puts everything in
// /run/current-system/sw/bin; standard Linux uses /bin/sh + curl on PATH.
const SHELL_BIN = Bun.which("sh") ?? "/bin/sh";

describe("mcp netns integration (Linux + unprivileged userns)", () => {
  beforeAll(() => {
    auditCalls.length = 0;
  });

  test.skipIf(SKIP)("probeNetnsAvailability returns available", () => {
    _resetProbeCacheForTests();
    const probe = probeNetnsAvailability();
    expect(probe.available).toBe(true);
    expect(probe.reason).toBeUndefined();
  });

  test.skipIf(SKIP)(
    "buildNetnsSpawnArgs uses -U -m only (no -n) — fix-pass C2",
    () => {
      _resetProbeCacheForTests();
      const result = buildNetnsSpawnArgs({
        origCommand: "prlimit",
        origArgs: ["--rss=536870912", "/usr/bin/python3", "-m", "x"],
        launcherPath: getDefaultLauncherPath(),
      });
      expect(result.wrapped).toBe(true);
      expect(result.command).toBe("unshare");
      // -U and -m only. -n was dropped so the host's loopback proxy
      // remains reachable from inside the namespace.
      expect(result.args.includes("-U")).toBe(true);
      expect(result.args.includes("-m")).toBe(true);
      expect(result.args.includes("-n")).toBe(false);
      expect(result.args.includes("--map-root-user")).toBe(true);
      const launcherIdx = result.args.indexOf(getDefaultLauncherPath());
      expect(launcherIdx).toBeGreaterThanOrEqual(0);
      expect(result.args[launcherIdx + 1]).toBe("prlimit");
    },
  );

  test.skipIf(SKIP)(
    "host loopback IS reachable from inside the namespace (post-fix-pass C2)",
    async () => {
      // Stand up a tiny TCP listener on the host's loopback. Then run
      // curl inside the namespace targeting it. Pre-fix-pass (`-n`),
      // this would fail with CURLE_COULDNT_CONNECT because the netns
      // has its own empty lo. Post-fix (no `-n`), it succeeds.
      //
      // CRITICAL: `Bun.spawn` (async) NOT `Bun.spawnSync` — the
      // listener runs in the same Bun event loop as the test, and
      // spawnSync would block accept() until curl times out.
      const listener = Bun.listen<undefined>({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          data(socket) {
            socket.write(
              "HTTP/1.1 204 No Content\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            );
            socket.end();
          },
        },
      });
      try {
        const child = Bun.spawn({
          cmd: [
            "unshare",
            "-U",
            "-m",
            "--map-root-user",
            "--",
            getDefaultLauncherPath(),
            SHELL_BIN,
            "-c",
            `curl --max-time 3 -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:${listener.port}/`,
          ],
          stdout: "pipe",
          stderr: "pipe",
        });
        await child.exited;
        const stdout = await new Response(child.stdout).text();
        expect(stdout.trim()).toBe("204");
      } finally {
        listener.stop(true);
      }
    },
  );

  test.skipIf(SKIP)(
    "HTTPS_PROXY round-trip: namespace curl → proxy → audit (M2 fix-pass)",
    async () => {
      // The reviewer's M2 ask: "spawn an MCP-like process with
      // HTTPS_PROXY env set, have it run curl through the proxy,
      // assert the proxy received the CONNECT and authorized."
      //
      // We use a deny-all engine so the round-trip terminates at
      // `403 Forbidden` from the proxy. That gives us:
      //   1. The HTTPS_PROXY URL was correctly parsed by curl (if
      //      parsing failed, curl wouldn't even attempt the tunnel).
      //   2. curl successfully dialed the proxy's loopback port from
      //      INSIDE the unshare namespace (post-C2 sanity check).
      //   3. The proxy received the CONNECT line + Proxy-Authorization.
      //   4. The PDP was consulted for the target hostname.
      //   5. The audit tape recorded a `host-blocked` row.
      //
      // This is the M2 validation gap that allowed the original Phase 7
      // commits to ship: the prior tests never exercised HTTPS_PROXY
      // through unshare, so the unparseable `http+unix://...` URL
      // slipped through.
      const engine = createStubPermissionEngine("deny-all");
      const proxy = createMcpProxy({
        extensionId: "ext-integration-roundtrip",
        extensionName: "rt",
        conversationId: null,
        userId: null,
        permittedHosts: [],
        engine,
        bindAddress: "127.0.0.1:0",
      });
      await proxy.start();
      auditCalls.length = 0;
      try {
        const proxyUrl = proxy.proxyUrl();
        // CRITICAL: `Bun.spawn` (async) — spawnSync would block the
        // event loop and the proxy listener (in this same process)
        // wouldn't be able to accept curl's connection.
        const child = Bun.spawn({
          cmd: [
            "unshare",
            "-U",
            "-m",
            "--map-root-user",
            "--",
            getDefaultLauncherPath(),
            SHELL_BIN,
            "-c",
            // Critical: use `https://...` so curl uses HTTP CONNECT
            // (the RFC 7230 §3.3.1 path) instead of absolute-form
            // GET (which it does for plain http through a proxy and
            // our proxy doesn't handle). curl with -x parses the
            // proxyUrl (incl. user:token@host:port), opens a TCP
            // socket to host:port, sends:
            //   CONNECT api.foo.test:443 HTTP/1.1
            //   Proxy-Authorization: Basic <b64(_:token)>
            // Our proxy's deny-all engine returns 403 for the host
            // gate; curl exits non-zero. We don't assert curl's exit
            // code — we assert that the PROXY observed the CONNECT and
            // ran authorize() with the right hostname.
            `curl --max-time 4 -s -o /dev/null -x ${proxyUrl} -k https://api.foo.test/ ; true`,
          ],
          stdout: "pipe",
          stderr: "pipe",
        });
        await child.exited;

        await new Promise((res) => setTimeout(res, 100));

        // 1. Proxy authorize() was called for api.foo.test (proves
        //    the URL was parsed AND curl reached the proxy AND the
        //    proxy parsed CONNECT).
        expect(engine.calls.length).toBeGreaterThanOrEqual(1);
        const networkCall = engine.calls.find(
          (c) => c.needed[0]?.kind === "network",
        );
        expect(networkCall).toBeDefined();
        expect(networkCall?.needed[0]?.value).toBe("api.foo.test");

        // 2. host-blocked audit row written (deny-all engine).
        const blocked = auditCalls.find(
          (c) => c.action === "ext:mcp:host-blocked" &&
                 c.metadata?.reason === "host",
        );
        expect(blocked).toBeDefined();
      } finally {
        await proxy.stop();
      }
    },
  );
});

// Skip-diagnosis describes WHY when the gate fails so a CI green-on-skip
// doesn't hide a real config drift.
describe("mcp netns integration — skip diagnosis", () => {
  test("test gate evaluated", () => {
    if (SKIP) {
      const probe = probeNetnsAvailability();
      expect(probe.available).toBe(false);
      expect(typeof probe.reason).toBe("string");
    } else {
      const probe = probeNetnsAvailability();
      expect(probe.available).toBe(true);
    }
  });
});
