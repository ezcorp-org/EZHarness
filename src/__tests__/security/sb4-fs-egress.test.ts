// Phase 3 sec-SB4: filesystem primitives are unconditionally blocked
// inside the extension subprocess, even when filesystem permission is
// granted. Granted access flows through the host-mediated `ezcorp/fs.*`
// reverse-RPC (see `src/extensions/fs-handler.ts`); raw `Bun.file`,
// `Bun.write`, `Bun.glob`, `node:fs`, and `node:fs/promises` are all
// poisoned by the sandbox-preload.
//
// This test mirrors `sb2-network-egress.test.ts`'s pattern: spawn a real
// `bun` subprocess with `--preload <sandbox-preload>`, run a tiny `-e`
// probe, and inspect stdout/stderr. The deniers must fire regardless of
// `EZCORP_FS_ALLOWED` (informational flag for SDK helpers).
//
// Tests fix(sec-SB4): Phase 3 fs-handler commit series.

import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";

const SANDBOX_PRELOAD_PATH = resolve(
  import.meta.dir,
  "../../extensions/runtime/sandbox-preload.ts",
);

type ProbeResult = { stdout: string; stderr: string; exitCode: number };

async function runUnderPreload(
  code: string,
  opts: { networkAllowed?: boolean; shellAllowed?: boolean; fsAllowed?: boolean } = {},
): Promise<ProbeResult> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
  };
  if (opts.networkAllowed) env.EZCORP_NETWORK_ALLOWED = "1";
  if (opts.shellAllowed) env.EZCORP_SHELL_ALLOWED = "1";
  if (opts.fsAllowed) env.EZCORP_FS_ALLOWED = "1";

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

function probeSync(expr: string): string {
  return `try { ${expr}; console.log("OK"); } catch (e) { console.log("ERR:" + (e?.message ?? String(e))); }`;
}

function probeAsync(expr: string): string {
  return `(async () => { try { ${expr}; console.log("OK"); } catch (e) { console.log("ERR:" + (e?.message ?? String(e))); } })();`;
}

const FS_DENY = /requires 'filesystem' permission|filesystem.*blocked/;

// ── Bun-namespace fs primitives — always denied ──────────────────

describe("sec-SB4/Phase3: Bun.file / Bun.write / Bun.glob always denied", () => {
  test("Bun.file('/etc/passwd') throws filesystem denier (no fs permission)", async () => {
    const out = await runUnderPreload(
      probeSync(`Bun.file('/etc/passwd').text()`),
    );
    expect(out.stdout).toMatch(FS_DENY);
    expect(out.stdout).not.toMatch(/^OK$/m);
  });

  test("Bun.file STILL throws even when EZCORP_FS_ALLOWED=1 (informational only)", async () => {
    // The flag doesn't unblock the in-sandbox primitive — granted access
    // means the SDK helper's reverse-RPC has a chance of succeeding, but
    // raw Bun.file is always denied (see sandbox-preload.ts FS_MODULES
    // block).
    const out = await runUnderPreload(
      probeSync(`Bun.file('/tmp/anywhere').text()`),
      { fsAllowed: true },
    );
    expect(out.stdout).toMatch(FS_DENY);
  });

  test("Bun.write throws filesystem denier", async () => {
    const out = await runUnderPreload(
      probeSync(`Bun.write('/tmp/x', 'data')`),
    );
    expect(out.stdout).toMatch(FS_DENY);
  });

  test("Bun.write STILL throws when EZCORP_FS_ALLOWED=1", async () => {
    const out = await runUnderPreload(
      probeSync(`Bun.write('/tmp/x', 'data')`),
      { fsAllowed: true },
    );
    expect(out.stdout).toMatch(FS_DENY);
  });

  test("Bun.glob throws filesystem denier", async () => {
    const out = await runUnderPreload(
      probeSync(`Bun.glob('*.txt').scan('/tmp')`),
    );
    expect(out.stdout).toMatch(FS_DENY);
  });

  test("denier message points to the SDK helper", async () => {
    const out = await runUnderPreload(probeSync(`Bun.file('/x')`));
    expect(out.stdout).toMatch(/fsRead|@ezcorp\/sdk/);
  });
});

// ── node:fs / node:fs/promises — always poisoned ─────────────────

describe("sec-SB4/Phase3: node:fs and node:fs/promises always blocked", () => {
  test("require('fs') throws filesystem denier", async () => {
    const out = await runUnderPreload(probeSync(`require('fs').readFileSync`));
    expect(out.stdout).toMatch(FS_DENY);
  });

  test("require('node:fs') throws filesystem denier (node: prefix form)", async () => {
    const out = await runUnderPreload(
      probeSync(`require('node:fs').readFileSync`),
    );
    expect(out.stdout).toMatch(FS_DENY);
  });

  test("require('fs/promises') throws filesystem denier", async () => {
    const out = await runUnderPreload(
      probeSync(`require('fs/promises').readFile`),
    );
    expect(out.stdout).toMatch(FS_DENY);
  });

  test("require('node:fs/promises') throws filesystem denier", async () => {
    const out = await runUnderPreload(
      probeSync(`require('node:fs/promises').readFile`),
    );
    expect(out.stdout).toMatch(FS_DENY);
  });

  test("dynamic import('node:fs') returns a poisoned module object", async () => {
    // Bun caches the same module for CJS and ESM, so the property-poison
    // also catches `await import('node:fs')`.
    const out = await runUnderPreload(
      probeAsync(
        `const m = await import('node:fs'); m.readFileSync`,
      ),
    );
    expect(out.stdout).toMatch(FS_DENY);
  });

  test("dynamic import('node:fs/promises') returns a poisoned module object", async () => {
    const out = await runUnderPreload(
      probeAsync(
        `const m = await import('node:fs/promises'); m.readFile`,
      ),
    );
    expect(out.stdout).toMatch(FS_DENY);
  });

  test("require still works for unrelated modules (e.g. node:path)", async () => {
    // Sanity: the FS deniers must not break legitimate require flows.
    const out = await runUnderPreload(
      probeSync(
        `const path = require('node:path'); ` +
        `if (typeof path.join !== "function") throw new Error("path broken")`,
      ),
    );
    expect(out.stdout).toMatch(/^OK$/m);
  });
});

// ── createRequire factory propagation ────────────────────────────

describe("sec-SB4/Phase3: createRequire-derived require also blocks fs", () => {
  // Same fixture as sb2's createRequire suite: a `file://` base for the
  // factory call.
  const FAKE_REQUIRE_BASE = `'file://${resolve(import.meta.dir, "../..").replace(/\\/g, "/")}/x.js'`;

  test("createRequire-derived require('fs') is denied", async () => {
    const out = await runUnderPreload(
      probeSync(
        `const { createRequire } = require('node:module'); ` +
        `const r = createRequire(${FAKE_REQUIRE_BASE}); ` +
        `r('fs').readFileSync`,
      ),
    );
    expect(out.stdout).toMatch(FS_DENY);
  });

  test("createRequire-derived require('node:fs/promises') is denied", async () => {
    const out = await runUnderPreload(
      probeSync(
        `const { createRequire } = require('node:module'); ` +
        `const r = createRequire(${FAKE_REQUIRE_BASE}); ` +
        `r('node:fs/promises').readFile`,
      ),
    );
    expect(out.stdout).toMatch(FS_DENY);
  });
});

// ── Cross-cap interaction smoke ──────────────────────────────────

describe("sec-SB4/Phase3: deniers fire regardless of network/shell/fs flags", () => {
  test("all-permissions-granted does NOT unblock Bun.file", async () => {
    // Even with network + shell + fs all set, raw fs primitives stay
    // poisoned. The point of Phase 3 is that ALL fs IO goes through the
    // host. Granted means the SDK helpers work via reverse-RPC.
    const out = await runUnderPreload(
      probeSync(`Bun.file('/tmp/anywhere').text()`),
      { networkAllowed: true, shellAllowed: true, fsAllowed: true },
    );
    expect(out.stdout).toMatch(FS_DENY);
  });

  test("dynamic import('fs') with all flags set still throws", async () => {
    const out = await runUnderPreload(
      probeAsync(`const m = await import('fs'); m.readFileSync`),
      { networkAllowed: true, shellAllowed: true, fsAllowed: true },
    );
    expect(out.stdout).toMatch(FS_DENY);
  });
});
