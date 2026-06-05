/**
 * Docker-gated LIVE end-to-end for the DYNAMIC preview passthrough (Secure
 * User-Site Preview / Port Exposure, Phase 3b).
 *
 * These need a real Linux container with the compiled setuid-root
 * `preview-spawn` helper (4755), live /proc/net/tcp, and the ability to bind
 * loopback ports — so they are gated behind DOCKER_TEST=1, mirroring the
 * uid-keystone split (preview-uid-keystone.docker.test.ts). Locally (no
 * DOCKER_TEST) the whole suite is a logged no-op.
 *
 * Imports are kept to BACKEND modules only (no web `$server`-aliased glue,
 * which bun can't resolve outside vite). The proxy's loopback port-pin +
 * inbound sanitation are exercised directly here; the SvelteKit wrapper
 * around them is unit-tested in web/src/__tests__/preview-dispatch.server.
 *
 * What they prove LIVE:
 *   1. HAPPY PATH: spawn a dev server as a preview uid → ProcPortSource
 *      detects its port via the /proc uid column → a loopback fetch (the
 *      exact pin the proxy makes) returns 200 with the body. Bun servers may
 *      bind IPv6; ProcPortSource reads tcp6 and we connect to 127.0.0.1.
 *   2. WS BRIDGE upstream: a WebSocket to the spawned server (the upstream
 *      leg of the bridge) connects + echoes a frame — proving the loopback
 *      ws://127.0.0.1:<port> the bridge pins is reachable end-to-end.
 */

import { test, expect, describe } from "bun:test";

const DOCKER = process.env.DOCKER_TEST === "1";

async function spawnListener(conv: string, port: number, ws = false) {
  const { allocatePreviewUid, _resetPreviewUidPoolForTests } = await import(
    "../runtime/preview/preview-uid-pool"
  );
  const { spawnPreviewServer } = await import("../runtime/preview/preview-spawn");
  _resetPreviewUidPoolForTests();
  const alloc = allocatePreviewUid(conv);
  expect(alloc).not.toBeNull();
  const serve = ws
    ? `Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch(req, s) { if (s.upgrade(req)) return; return new Response("no"); }, websocket: { message(w, m) { w.send("echo:" + m); } } });`
    : `Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch: () => new Response("LIVE-OK") });`;
  const server = spawnPreviewServer({
    uid: alloc!.uid,
    workDir: "/tmp",
    command: "bun",
    args: ["-e", `${serve}setTimeout(() => process.exit(0), 15000);await new Promise(r => setTimeout(r, 15000));`],
  });
  return server;
}

async function teardown(server: { kill(): void; exited: Promise<number> }) {
  try {
    server.kill();
  } catch {
    // EPERM (foreign uid) — the listener's self-exit reaps it.
  }
  await Promise.race([server.exited.catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
}

describe.skipIf(!DOCKER)("dynamic preview — LIVE e2e (DOCKER_TEST=1)", () => {
  test(
    "spawn as preview uid → ProcPortSource detects → loopback fetch 200",
    async () => {
      const { ProcPortSource } = await import("../runtime/preview/preview-port-source");
      const PORT = 58741;
      const server = await spawnListener("conv-e2e", PORT);
      try {
        let detected = false;
        for (let i = 0; i < 50; i++) {
          if (new ProcPortSource().listListeners("conv-e2e").some((l) => l.port === PORT)) {
            detected = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(detected).toBe(true);

        // The exact loopback pin the dynamic proxy uses.
        const res = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "manual" });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("LIVE-OK");
      } finally {
        await teardown(server);
      }
    },
    30000,
  );

  test(
    "WS upstream (ws://127.0.0.1:<port>) connects + echoes a frame",
    async () => {
      const PORT = 58743;
      const server = await spawnListener("conv-ws", PORT, true);
      try {
        await new Promise((r) => setTimeout(r, 2500)); // let it bind
        const echo = await new Promise<string>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
          const timer = setTimeout(() => reject(new Error("ws timeout")), 5000);
          ws.addEventListener("open", () => ws.send("ping"));
          ws.addEventListener("message", (ev: MessageEvent) => {
            clearTimeout(timer);
            resolve(String(ev.data));
            ws.close();
          });
          ws.addEventListener("error", () => {
            clearTimeout(timer);
            reject(new Error("ws error"));
          });
        });
        expect(echo).toBe("echo:ping");
      } finally {
        await teardown(server);
      }
    },
    30000,
  );
});
