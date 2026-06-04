import { test, expect, describe } from "bun:test";
import {
  PREVIEW_UID_MIN,
  PREVIEW_UID_MAX,
  isValidPreviewUid,
  buildPreviewSpawnArgv,
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
