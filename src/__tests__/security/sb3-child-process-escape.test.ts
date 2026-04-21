// Regression test for sec-SB3: the extension subprocess sandbox must block
// `child_process` imports (and Bun's native spawn equivalents) unless the
// extension has the `shell` permission grant.
//
// Pre-fix: `src/extensions/runtime/sandbox-preload.ts` only poisoned the
// network modules. An extension could `require('child_process').spawn('sh',
// ['-c', '...'])` or call `Bun.spawn(['curl', ...])` to reach a full shell
// without ever going through the mediated `ezcorp/shell` RPC — a complete
// bypass of the sandbox's shell mediation.
//
// Fix (a00f242): the preload now also:
//   - Eagerly require()s `child_process` and rewrites every own property
//     into a throwing getter — this catches `await import('child_process')`
//     because Bun caches the same module object for CJS and ESM.
//   - Extends the `Module.prototype.require` monkey-patch to reject plain
//     `require("child_process")` and `require("node:child_process")` before
//     the cached (poisoned) module object is returned.
//   - Replaces `Bun.spawn` / `Bun.spawnSync` on the global `Bun` namespace
//     with throwing deniers so Bun's native spawn path (which does NOT go
//     through Node's `child_process`) is also closed.
//   - All of the above activate only when `EZCORP_SHELL_ALLOWED` is NOT
//     "1". `subprocess.ts` sets that env var when `shellAllowed` is true,
//     which `registry.ts` derives from `granted.shell === true`.
//
// Strategy: mirror sb2-network-egress.test.ts — spawn a real bun subprocess
// with `--preload <sandbox-preload>` and a short `-e` probe, toggling
// `EZCORP_SHELL_ALLOWED` between runs. This is the same code path
// `ExtensionProcess` uses in production.
//
// Tests fix(sec-SB3): a00f242

import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";

const SANDBOX_PRELOAD_PATH = resolve(
  import.meta.dir,
  "../../extensions/runtime/sandbox-preload.ts",
);

type ProbeResult = { stdout: string; stderr: string; exitCode: number };

/**
 * Run a tiny script under the sandbox preload. `shellAllowed` toggles the
 * env var the preload looks at — this is exactly how subprocess.ts
 * communicates the `shell` permission to the preload.
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

// The preload's denier always mentions the missing permission, so we anchor
// on that keyword rather than the full error string.
const SHELL_DENY = /requires 'shell' permission/;

describe("sec-SB3: child_process blocked without shell permission", () => {
  test("require('child_process').spawn throws with shell-permission error", async () => {
    const out = await runUnderPreload(
      probeSync(`require('child_process').spawn('ls', [])`),
    );
    expect(out.stdout).toMatch(SHELL_DENY);
    expect(out.stdout).not.toMatch(/^OK$/m);
  });

  test("require('child_process').exec throws with shell-permission error", async () => {
    // exec is the classic shell-escape surface; it must also be denied.
    const out = await runUnderPreload(
      probeSync(`require('child_process').exec('echo hi')`),
    );
    expect(out.stdout).toMatch(SHELL_DENY);
  });

  test("require('node:child_process') throws (node: prefix is also blocked)", async () => {
    // Pre-fix neither form was blocked; post-fix the `node:` prefix form is
    // registered in the blocklist alongside the bare form.
    const out = await runUnderPreload(
      probeSync(`require('node:child_process').spawn('ls', [])`),
    );
    expect(out.stdout).toMatch(SHELL_DENY);
  });

  test("dynamic import('child_process') returns a poisoned module object", async () => {
    // Bun caches the same module object for CJS and ESM, so the preload's
    // own-property poisoning catches `await import('child_process')` even
    // though the require patch does not fire. Accessing `.spawn` must throw.
    const out = await runUnderPreload(
      probeAsync(`const m = await import('child_process'); m.spawn`),
    );
    expect(out.stdout).toMatch(SHELL_DENY);
  });

  test("dynamic import('node:child_process') is also poisoned", async () => {
    const out = await runUnderPreload(
      probeAsync(`const m = await import('node:child_process'); m.exec`),
    );
    expect(out.stdout).toMatch(SHELL_DENY);
  });

  test("Bun.spawn(['ls']) is replaced with a deny stub", async () => {
    // Bun.spawn bypasses Node's child_process entirely; the preload must
    // deny it on the Bun global as well or the block is incomplete.
    const out = await runUnderPreload(probeSync(`Bun.spawn(['ls'])`));
    expect(out.stdout).toMatch(SHELL_DENY);
    expect(out.stdout).not.toMatch(/^OK$/m);
  });

  test("Bun.spawnSync(['ls']) is replaced with a deny stub", async () => {
    const out = await runUnderPreload(probeSync(`Bun.spawnSync(['ls'])`));
    expect(out.stdout).toMatch(SHELL_DENY);
  });
});

describe("sec-SB3: child_process available WITH shell permission (no-op mode)", () => {
  test("require('child_process') succeeds when EZCORP_SHELL_ALLOWED=1", async () => {
    const out = await runUnderPreload(
      probeSync(
        `const cp = require('child_process'); ` +
          `if (typeof cp.spawn !== "function") throw new Error("spawn not a function")`,
      ),
      { shellAllowed: true },
    );
    expect(out.stdout).toMatch(/^OK$/m);
    expect(out.stdout).not.toMatch(SHELL_DENY);
  });

  test("require('node:child_process') succeeds when EZCORP_SHELL_ALLOWED=1", async () => {
    const out = await runUnderPreload(
      probeSync(
        `const cp = require('node:child_process'); ` +
          `if (typeof cp.exec !== "function") throw new Error("exec not a function")`,
      ),
      { shellAllowed: true },
    );
    expect(out.stdout).toMatch(/^OK$/m);
  });

  test("dynamic import('child_process') is un-poisoned when EZCORP_SHELL_ALLOWED=1", async () => {
    const out = await runUnderPreload(
      probeAsync(
        `const m = await import('child_process'); ` +
          `if (typeof m.spawn !== "function") throw new Error("spawn not a function")`,
      ),
      { shellAllowed: true },
    );
    expect(out.stdout).toMatch(/^OK$/m);
    expect(out.stdout).not.toMatch(SHELL_DENY);
  });

  test("Bun.spawn is restored (real function) when EZCORP_SHELL_ALLOWED=1", async () => {
    // Actually spawn `true` so we exercise the real builtin — the deny stub
    // would throw synchronously, so reaching exit code 0 proves restoration.
    const out = await runUnderPreload(
      probeSync(
        `const p = Bun.spawn(['true']); ` +
          `if (typeof p.exited?.then !== "function") throw new Error("not a real Subprocess")`,
      ),
      { shellAllowed: true },
    );
    expect(out.stdout).toMatch(/^OK$/m);
    expect(out.stdout).not.toMatch(SHELL_DENY);
  });

  test("Bun.spawnSync is restored when EZCORP_SHELL_ALLOWED=1", async () => {
    const out = await runUnderPreload(
      probeSync(
        `const r = Bun.spawnSync(['true']); ` +
          `if (typeof r.exitCode !== "number") throw new Error("not a real SyncSubprocess result")`,
      ),
      { shellAllowed: true },
    );
    expect(out.stdout).toMatch(/^OK$/m);
  });
});

describe("sec-SB3: grant/revoke cycle — a fresh subprocess respects a flipped env", () => {
  test("deny → allow → deny across three fresh spawns", async () => {
    // Subprocesses inherit env at spawn time. Permission changes take effect
    // on the NEXT spawned subprocess — existing procs are not dynamically
    // revoked. This test pins that a permission grant or revoke is honored
    // by the next process the mediator spawns.
    const deny1 = await runUnderPreload(
      probeSync(`require('child_process').spawn('ls', [])`),
    );
    expect(deny1.stdout).toMatch(SHELL_DENY);

    const grantRun = await runUnderPreload(
      probeSync(
        `const cp = require('child_process'); ` +
          `if (typeof cp.spawn !== "function") throw new Error("missing spawn")`,
      ),
      { shellAllowed: true },
    );
    expect(grantRun.stdout).toMatch(/^OK$/m);

    const deny2 = await runUnderPreload(probeSync(`Bun.spawn(['ls'])`));
    expect(deny2.stdout).toMatch(SHELL_DENY);
  });
});
