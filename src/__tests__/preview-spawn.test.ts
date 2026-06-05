import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  PREVIEW_UID_MIN,
  PREVIEW_UID_MAX,
  isValidPreviewUid,
  buildPreviewSpawnArgv,
  buildPreviewKillArgv,
  killPreviewProcess,
  isPreviewSpawnHelperPresent,
  spawnPreviewServer,
  previewSpawnHelperPath,
  type PreviewProcess,
} from "../runtime/preview/preview-spawn";

describe("isValidPreviewUid — the uid-range allowlist (keystone)", () => {
  test("accepts the inclusive range boundaries + an interior value", () => {
    expect(isValidPreviewUid(PREVIEW_UID_MIN)).toBe(true);
    expect(isValidPreviewUid(PREVIEW_UID_MAX)).toBe(true);
    expect(isValidPreviewUid(90500)).toBe(true);
  });

  test("rejects below the floor — incl. root (0) and the app uid (1000)", () => {
    expect(isValidPreviewUid(0)).toBe(false);
    expect(isValidPreviewUid(1000)).toBe(false);
    expect(isValidPreviewUid(PREVIEW_UID_MIN - 1)).toBe(false);
  });

  test("rejects above the ceiling", () => {
    expect(isValidPreviewUid(PREVIEW_UID_MAX + 1)).toBe(false);
    expect(isValidPreviewUid(1_000_000)).toBe(false);
  });

  test("rejects negatives", () => {
    expect(isValidPreviewUid(-1)).toBe(false);
    expect(isValidPreviewUid(-90001)).toBe(false);
  });

  test("rejects non-integers (NaN, Infinity, floats)", () => {
    expect(isValidPreviewUid(Number.NaN)).toBe(false);
    expect(isValidPreviewUid(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidPreviewUid(90000.5)).toBe(false);
  });
});

describe("buildPreviewSpawnArgv", () => {
  const helper = "/opt/preview-spawn";

  test("assembles [helper, uid, workDir, cmd, ...args]", () => {
    const argv = buildPreviewSpawnArgv(
      { uid: 90001, workDir: "/work/conv", command: "bun", args: ["run", "dev"] },
      helper,
    );
    expect(argv).toEqual([helper, "90001", "/work/conv", "bun", "run", "dev"]);
  });

  test("works with no args", () => {
    const argv = buildPreviewSpawnArgv({ uid: 90002, workDir: "/w", command: "serve" }, helper);
    expect(argv).toEqual([helper, "90002", "/w", "serve"]);
  });

  test("passes args verbatim — no shell interpretation", () => {
    const argv = buildPreviewSpawnArgv(
      { uid: 90003, workDir: "/w", command: "sh-not-invoked", args: ["a; rm -rf /", "$X", "&& y"] },
      helper,
    );
    expect(argv).toEqual([helper, "90003", "/w", "sh-not-invoked", "a; rm -rf /", "$X", "&& y"]);
  });

  test("defaults the helper path from previewSpawnHelperPath()", () => {
    const argv = buildPreviewSpawnArgv({ uid: 90004, workDir: "/w", command: "x" });
    expect(argv[0]).toBe(previewSpawnHelperPath());
  });

  test("throws on an out-of-range uid (fail-closed before spawning)", () => {
    expect(() => buildPreviewSpawnArgv({ uid: 0, workDir: "/w", command: "x" }, helper)).toThrow(
      /allowlisted preview range/,
    );
    expect(() => buildPreviewSpawnArgv({ uid: 1000, workDir: "/w", command: "x" }, helper)).toThrow();
  });

  test("throws on a non-absolute workDir", () => {
    expect(() =>
      buildPreviewSpawnArgv({ uid: 90001, workDir: "relative/dir", command: "x" }, helper),
    ).toThrow(/absolute path/);
  });

  test("throws on a missing command", () => {
    expect(() =>
      buildPreviewSpawnArgv({ uid: 90001, workDir: "/w", command: "" }, helper),
    ).toThrow(/command is required/);
  });
});

describe("isPreviewSpawnHelperPresent — capability gate for uid mode", () => {
  const setuidRoot = { uid: 0, mode: 0o755 | 0o4000 };

  test("true when root-owned + setuid bit set", () => {
    expect(isPreviewSpawnHelperPresent("/x", () => setuidRoot)).toBe(true);
  });

  test("false when not setuid (no privilege drop possible)", () => {
    expect(isPreviewSpawnHelperPresent("/x", () => ({ uid: 0, mode: 0o755 }))).toBe(false);
  });

  test("false when not root-owned (setuid to non-root is useless here)", () => {
    expect(
      isPreviewSpawnHelperPresent("/x", () => ({ uid: 1000, mode: 0o755 | 0o4000 })),
    ).toBe(false);
  });

  test("false (fail-closed) when stat throws — missing file", () => {
    expect(
      isPreviewSpawnHelperPresent("/missing", () => {
        throw new Error("ENOENT");
      }),
    ).toBe(false);
  });

  test("honors EZCORP_PREVIEW_SPAWN_HELPER override for the default path", () => {
    const prev = process.env.EZCORP_PREVIEW_SPAWN_HELPER;
    process.env.EZCORP_PREVIEW_SPAWN_HELPER = "/custom/helper";
    try {
      expect(previewSpawnHelperPath()).toBe("/custom/helper");
    } finally {
      if (prev === undefined) delete process.env.EZCORP_PREVIEW_SPAWN_HELPER;
      else process.env.EZCORP_PREVIEW_SPAWN_HELPER = prev;
    }
  });
});

describe("spawnPreviewServer", () => {
  test("spawns the helper argv via the injected spawner with piped streams", () => {
    let captured: { argv: string[]; opts: unknown } | null = null;
    const fake: PreviewProcess = {
      pid: 4242,
      kill: () => {},
      exited: Promise.resolve(0),
    };
    const proc = spawnPreviewServer(
      { uid: 90007, workDir: "/work", command: "bun", args: ["dev"] },
      {
        helperPath: "/opt/preview-spawn",
        spawn: (argv, opts) => {
          captured = { argv, opts };
          return fake;
        },
      },
    );
    expect(proc.pid).toBe(4242);
    expect(captured).not.toBeNull();
    expect(captured!.argv).toEqual(["/opt/preview-spawn", "90007", "/work", "bun", "dev"]);
    expect(captured!.opts).toEqual({ stdout: "pipe", stderr: "pipe" });
  });

  test("propagates the build-time refusal on a bad uid (never spawns)", () => {
    let spawned = false;
    expect(() =>
      spawnPreviewServer(
        { uid: 5, workDir: "/work", command: "bun" },
        {
          spawn: () => {
            spawned = true;
            return { pid: 1, kill: () => {}, exited: Promise.resolve(0) };
          },
        },
      ),
    ).toThrow(/allowlisted preview range/);
    expect(spawned).toBe(false);
  });
});

describe("buildPreviewKillArgv — setuid helper --kill mode argv", () => {
  const helper = "/opt/preview-spawn";

  test("assembles [helper, '--kill', uid, pgid]", () => {
    expect(buildPreviewKillArgv(90001, 4242, helper)).toEqual([
      helper,
      "--kill",
      "90001",
      "4242",
    ]);
  });

  test("defaults the helper path from previewSpawnHelperPath()", () => {
    expect(buildPreviewKillArgv(90001, 4242)[0]).toBe(previewSpawnHelperPath());
  });

  test("throws on an out-of-range uid (defense in depth — TS-side allowlist)", () => {
    expect(() => buildPreviewKillArgv(0, 100, helper)).toThrow(/allowlisted preview range/);
    expect(() => buildPreviewKillArgv(1000, 100, helper)).toThrow(/allowlisted preview range/);
    expect(() => buildPreviewKillArgv(PREVIEW_UID_MAX + 1, 100, helper)).toThrow();
  });

  test("throws on an invalid pgid (<=1, non-integer)", () => {
    expect(() => buildPreviewKillArgv(90001, 1, helper)).toThrow(/pgid/);
    expect(() => buildPreviewKillArgv(90001, 0, helper)).toThrow(/pgid/);
    expect(() => buildPreviewKillArgv(90001, -5, helper)).toThrow(/pgid/);
    expect(() => buildPreviewKillArgv(90001, 4.5, helper)).toThrow(/pgid/);
  });
});

describe("killPreviewProcess — confirmed-kill via the helper", () => {
  test("resolves true when the helper exits 0 (confirmed)", async () => {
    let captured: string[] | null = null;
    const ok = await killPreviewProcess(90001, 4242, {
      helperPath: "/opt/preview-spawn",
      spawn: (argv) => { captured = argv; return { exited: Promise.resolve(0) }; },
    });
    expect(ok).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!).toEqual(["/opt/preview-spawn", "--kill", "90001", "4242"]);
  });

  test("resolves false when the helper exits non-zero (unconfirmed)", async () => {
    const ok = await killPreviewProcess(90001, 4242, {
      spawn: () => ({ exited: Promise.resolve(1) }),
    });
    expect(ok).toBe(false);
  });

  test("resolves false (never throws) when the spawn itself throws", async () => {
    const ok = await killPreviewProcess(90001, 4242, {
      spawn: () => { throw new Error("ENOENT helper"); },
    });
    expect(ok).toBe(false);
  });

  test("resolves false on an invalid uid/pgid without ever spawning", async () => {
    let spawned = false;
    const ok = await killPreviewProcess(0, 4242, {
      spawn: () => { spawned = true; return { exited: Promise.resolve(0) }; },
    });
    expect(ok).toBe(false);
    expect(spawned).toBe(false);
  });
});

// Regression guard for the image-only module-shadowing bug (Phase 3a).
//
// The compiled setuid helper is installed extensionless. App modules import
// the TS driver extensionless too (`import … from "./preview-spawn"`). If the
// binary is installed at `src/runtime/preview/preview-spawn` — the SAME
// dir+basename as `preview-spawn.ts` — bun resolves the extensionless
// specifier to the ELF in the built image and parses it as JS, crashing the
// entire dynamic-preview subsystem at import time. The host worktree has no
// binary, so this is invisible to host tests/typecheck UNLESS we assert the
// install LOCATION can never collide with a TS module. That is exactly what
// these tests do — they constrain `previewSpawnHelperPath()`, the single
// source of truth the Dockerfile install target must match.
describe("previewSpawnHelperPath — must not shadow a TS module (image-only bug guard)", () => {
  // Pin the env to the production default so the guard checks the BAKED-IN
  // path, not a test override. Restored after.
  function withDefaultPath<T>(fn: () => T): T {
    const prev = process.env.EZCORP_PREVIEW_SPAWN_HELPER;
    delete process.env.EZCORP_PREVIEW_SPAWN_HELPER;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.EZCORP_PREVIEW_SPAWN_HELPER;
      else process.env.EZCORP_PREVIEW_SPAWN_HELPER = prev;
    }
  }

  test("default helper path is absolute and lives OUTSIDE the source tree", () => {
    withDefaultPath(() => {
      const p = previewSpawnHelperPath();
      // Absolute (the image bakes it at a fixed location).
      expect(p.startsWith("/")).toBe(true);
      // Never under a `src/` directory — a compiled binary must not live
      // adjacent to TS modules.
      const dir = dirname(p);
      expect(dir.endsWith("/src/runtime/preview")).toBe(false);
      expect(dir.includes("/src/")).toBe(false);
      expect(dir.endsWith("/src")).toBe(false);
    });
  });

  test("no sibling <basename>.ts module exists next to the resolved helper path", () => {
    withDefaultPath(() => {
      const p = previewSpawnHelperPath();
      // A binary that shares dir+basename with a `.ts` file would be
      // shadowed by bun's extensionless module resolution. Assert no such
      // sibling exists at the configured location. (In the image /app/bin/
      // contains only the binary; on the host the dir may not exist at all —
      // either way there must be no `preview-spawn.ts` beside it.)
      const siblingTs = `${dirname(p)}/${basename(p)}.ts`;
      expect(existsSync(siblingTs)).toBe(false);
    });
  });

  test("default does NOT equal the known-bad in-tree location", () => {
    withDefaultPath(() => {
      // The exact path that caused the boot crash. Hard-pin it as forbidden
      // so a future edit can't silently reintroduce the collision.
      expect(previewSpawnHelperPath()).not.toBe("/app/src/runtime/preview/preview-spawn");
    });
  });
});
