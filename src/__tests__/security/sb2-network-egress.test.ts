// Regression test for sec-SB2: the extension subprocess sandbox must block
// imports of network modules (http, https, net, tls, dns, dgram) and the
// global fetch() unless the extension has the `network` permission.
//
// Pre-fix: `src/extensions/subprocess.ts`'s `getSpawnArgs()` just ran
// `bun run <ext>` — there was no --preload script, so an extension could
// `require('http')` and dial out to any host without declaring the
// `network` permission, bypassing the env allowlist entirely.
//
// Fix (d720e40): a new `src/extensions/runtime/sandbox-preload.ts` is
// injected via `bun --preload` before the extension entrypoint runs. The
// preload:
//   - Eagerly require()s each network module and rewrites every own
//     property into a throwing getter — this also catches `await
//     import(...)` because Bun caches the same module object for CJS
//     and ESM access.
//   - Monkey-patches `Module.prototype.require` so plain `require("http")`
//     throws before ever returning the poisoned module.
//   - Replaces the global `fetch` with a throwing denier.
//   - `subprocess.ts` sets `EZCORP_NETWORK_ALLOWED=1` in the subprocess
//     env when the extension has a non-empty `network` permission array,
//     and the preload is a no-op in that mode.
//
// Strategy: spawn a real bun subprocess with `--preload <sandbox-preload>`
// and a short `-e` probe script, toggling `EZCORP_NETWORK_ALLOWED` between
// runs. This is the same code path `ExtensionProcess` uses in production
// (minus the prlimit wrapper, which is unrelated to the network block).
//
// Tests fix(sec-SB2): d720e40

import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";

const SANDBOX_PRELOAD_PATH = resolve(
  import.meta.dir,
  "../../extensions/runtime/sandbox-preload.ts",
);

type ProbeResult = { stdout: string; stderr: string; exitCode: number };

/**
 * Run a tiny script under the sandbox preload. `networkAllowed` toggles the
 * env var the preload looks at — this is exactly how subprocess.ts
 * communicates the `network` permission to the preload.
 */
async function runUnderPreload(
  code: string,
  opts: { networkAllowed?: boolean; shellAllowed?: boolean } = {},
): Promise<ProbeResult> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
  };
  if (opts.networkAllowed) env.EZCORP_NETWORK_ALLOWED = "1";
  if (opts.shellAllowed) env.EZCORP_SHELL_ALLOWED = "1";

  const proc = Bun.spawn(
    ["bun", "--preload", SANDBOX_PRELOAD_PATH, "-e", code],
    { stdout: "pipe", stderr: "pipe", env },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/**
 * Probe body: try the given expression; print "OK" on success, or
 * "ERR:<message>" on failure. Catches both sync throws from `require` and
 * the preload's own-property denier getters on the returned module object.
 */
function probeSync(expr: string): string {
  return `try { ${expr}; console.log("OK"); } catch (e) { console.log("ERR:" + (e?.message ?? String(e))); }`;
}

function probeAsync(expr: string): string {
  return `(async () => { try { ${expr}; console.log("OK"); } catch (e) { console.log("ERR:" + (e?.message ?? String(e))); } })();`;
}

// Regex factory — the preload's denier always mentions the missing
// permission, so we anchor on that keyword rather than the full string.
const NETWORK_DENY = /requires 'network' permission/;

describe("sec-SB2: network modules blocked without permission", () => {
  test("require('http') throws with network-permission error", async () => {
    const out = await runUnderPreload(probeSync(`require('http').createServer`));
    expect(out.stdout).toMatch(NETWORK_DENY);
    expect(out.stdout).not.toMatch(/^OK$/m);
  });

  test("require('https') throws with network-permission error", async () => {
    // https transitively requires http, so the preload's poisoning cascade
    // has to withstand the transitive access pattern.
    const out = await runUnderPreload(probeSync(`require('https').request`));
    expect(out.stdout).toMatch(NETWORK_DENY);
  });

  test("require('net') throws with network-permission error", async () => {
    const out = await runUnderPreload(probeSync(`require('net').Socket`));
    expect(out.stdout).toMatch(NETWORK_DENY);
  });

  test("require('node:http') throws (node: prefix is also blocked)", async () => {
    // Pre-fix there was no block at all; post-fix the `node:` prefix form
    // is registered in the blocklist alongside the bare form.
    const out = await runUnderPreload(probeSync(`require('node:http').createServer`));
    expect(out.stdout).toMatch(NETWORK_DENY);
  });

  test("require('dns') throws with network-permission error", async () => {
    const out = await runUnderPreload(probeSync(`require('dns').lookup`));
    expect(out.stdout).toMatch(NETWORK_DENY);
  });

  test("global fetch() is replaced with a deny stub", async () => {
    // fetch is the easiest egress path — if this slips through, the HTTP
    // module blocks are irrelevant.
    const out = await runUnderPreload(probeSync(`fetch('http://localhost:1/')`));
    expect(out.stdout).toMatch(NETWORK_DENY);
  });

  test("dynamic import('http') returns a poisoned module object", async () => {
    // Bun caches the same module object for CJS and ESM, so the preload's
    // own-property poisoning catches `await import('http')` even though
    // the require patch does not fire. Accessing any property on the
    // returned module must throw.
    const out = await runUnderPreload(
      probeAsync(`const m = await import('http'); m.createServer`),
    );
    expect(out.stdout).toMatch(NETWORK_DENY);
  });
});

describe("sec-SB2: network modules available WITH permission (no-op mode)", () => {
  test("require('http') succeeds when EZCORP_NETWORK_ALLOWED=1", async () => {
    const out = await runUnderPreload(
      probeSync(`const http = require('http'); if (typeof http.createServer !== "function") throw new Error("createServer not a function")`),
      { networkAllowed: true },
    );
    expect(out.stdout).toMatch(/^OK$/m);
    expect(out.stdout).not.toMatch(NETWORK_DENY);
  });

  test("require('net') succeeds when EZCORP_NETWORK_ALLOWED=1", async () => {
    const out = await runUnderPreload(
      probeSync(`const net = require('net'); if (typeof net.Socket !== "function") throw new Error("Socket not a function")`),
      { networkAllowed: true },
    );
    expect(out.stdout).toMatch(/^OK$/m);
  });

  test("global fetch() is restored when EZCORP_NETWORK_ALLOWED=1", async () => {
    // The preload must NOT replace fetch when the permission is granted.
    // We don't actually hit the network — just verify fetch is the real
    // builtin (a function that returns a Promise for an invalid URL).
    const out = await runUnderPreload(
      probeSync(
        `if (typeof fetch !== "function") throw new Error("fetch not a function"); ` +
        `const p = fetch('http://localhost:1/').catch(() => null); if (!(p instanceof Promise)) throw new Error("not promise")`,
      ),
      { networkAllowed: true },
    );
    expect(out.stdout).toMatch(/^OK$/m);
    expect(out.stdout).not.toMatch(NETWORK_DENY);
  });
});

describe("sec-SB2: revoke cycle — a fresh subprocess respects a flipped env", () => {
  test("granted proc succeeds, newly spawned ungranted proc blocks", async () => {
    // Subprocesses inherit env at spawn time. Granting and then revoking
    // the `network` permission results in the NEXT spawned subprocess
    // running the preload in block mode — existing procs are not
    // dynamically revoked (and that is fine: permission changes take
    // effect on restart, which is what this test pins).
    const grantedRun = await runUnderPreload(
      probeSync(`const http = require('http'); if (typeof http.createServer !== "function") throw new Error("missing")`),
      { networkAllowed: true },
    );
    expect(grantedRun.stdout).toMatch(/^OK$/m);

    const revokedRun = await runUnderPreload(
      probeSync(`require('http').createServer`),
      { networkAllowed: false },
    );
    expect(revokedRun.stdout).toMatch(NETWORK_DENY);
  });
});
