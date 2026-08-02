// Phase 3 sec-SB4: filesystem primitives are unconditionally blocked
// inside the extension subprocess, even when filesystem permission is
// granted. Granted access flows through the host-mediated `ezcorp/fs.*`
// reverse-RPC (see `src/extensions/fs-handler.ts`); raw `Bun.file`,
// `Bun.write`, `Bun.Glob#scan`, `bun:ffi`, `node:fs`, and `node:fs/promises`
// are all poisoned by the sandbox-preload.
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

describe("sec-SB4/Phase3: Bun.file / Bun.write always denied", () => {
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

  test("denier message points to the SDK helper", async () => {
    const out = await runUnderPreload(probeSync(`Bun.file('/x')`));
    expect(out.stdout).toMatch(/fsRead|@ezcorp\/sdk/);
  });
});

// ── Bun.Glob — directory enumeration is mediated, matching is not ─
//
// Regression: the preload used to install its denier on `BunNs.glob`
// (lowercase) — a property Bun has never had. That merely created a phantom
// and left the real `Bun.Glob` CLASS untouched, so an extension could call
// `new Bun.Glob(p).scanSync({cwd})` and walk any directory the OS tier still
// allowed, with no realpath check, no PDP decision and no audit entry. On the
// `advisory` tier (no OS confinement at all — `buildSandboxArgv` returns the
// inner argv unchanged) that reached the whole filesystem.

describe("sec-SB4: Bun.Glob scan is denied, match still works", () => {
  test("scanSync enumerating an ungranted dir throws the filesystem denier", async () => {
    const out = await runUnderPreload(
      probeSync(`[...new Bun.Glob('*').scanSync({ cwd: '/etc' })]`),
    );
    expect(out.stdout).toMatch(FS_DENY);
    expect(out.stdout).not.toMatch(/^OK$/m);
  });

  test("scan() (async generator) is denied too", async () => {
    const out = await runUnderPreload(
      probeAsync(
        `const acc = []; for await (const h of new Bun.Glob('*').scan({ cwd: '/etc' })) acc.push(h);`,
      ),
    );
    expect(out.stdout).toMatch(FS_DENY);
    expect(out.stdout).not.toMatch(/^OK$/m);
  });

  test("scanSync STILL throws when EZCORP_FS_ALLOWED=1", async () => {
    const out = await runUnderPreload(
      probeSync(`[...new Bun.Glob('*').scanSync({ cwd: '/etc' })]`),
      { fsAllowed: true },
    );
    expect(out.stdout).toMatch(FS_DENY);
  });

  test("scanSync cannot enumerate $HOME (no OS confinement on the advisory tier)", async () => {
    const out = await runUnderPreload(
      probeSync(
        `[...new Bun.Glob('**/*').scanSync({ cwd: process.env.HOME + '/.ssh' })]`,
      ),
    );
    expect(out.stdout).toMatch(FS_DENY);
  });

  test("match() keeps working — pure string matching, opens nothing", async () => {
    // `ez-factory`'s `read_files` tool filters a host-mediated `fsList`
    // result through `Bun.Glob#match`. It touches no filesystem, so denying
    // it would break a legitimate consumer for no security gain.
    const out = await runUnderPreload(
      probeSync(
        `const g = new Bun.Glob('**/*.ts');` +
          `if (g.match('a/b.ts') !== true) throw new Error('match should be true');` +
          `if (g.match('a/b.js') !== false) throw new Error('match should be false');`,
      ),
    );
    expect(out.stdout).toMatch(/^OK$/m);
  });
});

// ── bun:ffi — arbitrary native code, never granted ───────────────
//
// Same class of bug as the `Bun.glob` phantom: the preload installed a denier
// on `BunNs.dlopen`, which Bun does not have. FFI is reached through the
// `bun:ffi` MODULE, so it stayed fully live — and `dlopen("libc.so.6", …)`
// executes native code, defeating every other denier in the preload.

describe("sec-SB4: bun:ffi is poisoned (FFI defeats the whole sandbox)", () => {
  const NATIVE_DENY = /requires 'native' permission|native.*blocked/;

  test("require('bun:ffi') throws the native denier", async () => {
    const out = await runUnderPreload(probeSync(`require('bun:ffi').dlopen`));
    expect(out.stdout).toMatch(NATIVE_DENY);
    expect(out.stdout).not.toMatch(/^OK$/m);
  });

  test("dynamic import('bun:ffi') is denied", async () => {
    const out = await runUnderPreload(
      probeAsync(`const m = await import('bun:ffi'); m.dlopen`),
    );
    expect(out.stdout).toMatch(NATIVE_DENY);
  });

  test("dlopen cannot execute native code (libc getpid)", async () => {
    // The end-to-end capability, not just the symbol: before the fix this
    // returned the real pid.
    const out = await runUnderPreload(
      probeSync(
        `const { dlopen, FFIType } = require('bun:ffi');` +
          `const lib = dlopen('libc.so.6', { getpid: { args: [], returns: FFIType.i32 } });` +
          `console.log('PID=' + lib.symbols.getpid());`,
      ),
    );
    expect(out.stdout).not.toMatch(/PID=\d+/);
    expect(out.stdout).toMatch(NATIVE_DENY);
  });
});

// ── Guard: a denier on a typo is indistinguishable from no denier ─

describe("sec-SB4: every poisoned Bun property actually exists", () => {
  test("every `BunNs.<name> =` target is a real property of Bun", async () => {
    // This is the check that was missing. `Bun.glob` and `Bun.dlopen` both
    // sailed through review because assigning to a non-existent property is
    // silent — it creates a phantom and leaves the real capability
    // (`Bun.Glob`, `bun:ffi`) wide open. Asserting the target exists BEFORE
    // it is poisoned turns that silent failure into a red test.
    const src = await Bun.file(SANDBOX_PRELOAD_PATH).text();
    const assigned = [
      ...new Set(
        [...src.matchAll(/BunNs\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]!),
      ),
    ];
    // Sanity: the scrape must actually find the deniers, or the guard is vacuous.
    expect(assigned).toContain("spawn");
    expect(assigned).toContain("Glob");
    expect(assigned.length).toBeGreaterThanOrEqual(8);

    const phantom = assigned.filter((name) => !(name in Bun));
    expect(phantom).toEqual([]);
  });

  test("the preload adds no property the real Bun namespace lacks", async () => {
    // Behavioural twin of the check above: whatever the preload does, the
    // shape of `Bun` must not GROW. Any future denier on a misspelled name
    // shows up here as an extra key, naming itself.
    const list = `console.log(JSON.stringify(Object.getOwnPropertyNames(Bun).sort()))`;
    const baseline = Bun.spawnSync(["bun", "-e", list], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    const before = JSON.parse(baseline.stdout.toString()) as string[];
    const after = JSON.parse(
      (await runUnderPreload(list)).stdout.trim(),
    ) as string[];

    // Non-vacuity FIRST. `after.filter(...)` is empty both when the preload
    // added nothing (pass) and when `after` itself is empty because the probe
    // never really ran (no signal). Those are indistinguishable downstream —
    // the same shape as the bug this suite exists to catch, one level up — so
    // assert both lists are real before comparing them.
    expect(before.length).toBeGreaterThan(10);
    expect(after.length).toBeGreaterThan(10);
    expect(after.filter((k) => !before.includes(k))).toEqual([]);
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
