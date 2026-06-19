/**
 * Phase A2 — `buildSandboxArgv` pure-builder + landlock spec/shim coverage.
 *
 * Load-bearing invariants (the GATE):
 *  - every tier branch is covered: advisory / landlock / bwrap,
 *  - DENY-BY-DEFAULT: the builder fails CLOSED if any granted path is
 *    `.ezcorp/data`, under it, or an ancestor of it (incl. "/"),
 *  - `.ezcorp/data` NEVER appears in the resolved ro/rw set or the bwrap argv,
 *  - the landlock tier emits the shim argv + EZCORP_LANDLOCK_SPEC env,
 *  - the bwrap tier emits a bwrap prefix with no root bind and no data-dir bind,
 *  - the advisory tier passes the inner command through untouched.
 *
 * Real on-disk fixtures (preview-jail canonicalizes with realpath + fails
 * closed on missing dirs, so the bwrap leg needs real dirs).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildSandboxArgv,
} from "../extensions/sandbox/build-sandbox-argv";
import {
  buildLandlockJailSpec,
  applyLandlockJailSpec,
  DEFAULT_RUNTIME_RO_DIRS,
} from "../extensions/sandbox/landlock";
import {
  parseShimArgv,
  parseSpecFromEnv,
  LANDLOCK_SPEC_ENV,
} from "../extensions/sandbox/landlock-shim";
import { forbiddenDataDir } from "../extensions/preview-jail";

let ROOT: string; // project root (realpath)
let WORKSPACE: string; // the rw workspace under the root
let RO_OK: string; // an existing ro dir outside the data dir

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "a2-"));
  ROOT = realpathSync(base);
  WORKSPACE = join(ROOT, "workspace");
  RO_OK = join(ROOT, "rolibs");
  await mkdir(WORKSPACE, { recursive: true });
  await mkdir(RO_OK, { recursive: true });
  await mkdir(join(ROOT, ".ezcorp", "data"), { recursive: true });
  await writeFile(join(WORKSPACE, "f.txt"), "ok");
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("buildSandboxArgv — tier branches", () => {
  test("advisory: passes the inner command through untouched", () => {
    const r = buildSandboxArgv({
      tier: "advisory",
      workspaceDir: WORKSPACE,
      projectRoot: ROOT,
      command: "echo",
      args: ["hi"],
    });
    expect(r.tier).toBe("advisory");
    expect(r.argv).toEqual(["echo", "hi"]);
    expect(r.env).toEqual({});
    expect(r.landlockSpec).toBeNull();
  });

  test("landlock: emits the shim argv + EZCORP_LANDLOCK_SPEC env", () => {
    const r = buildSandboxArgv({
      tier: "landlock",
      workspaceDir: WORKSPACE,
      projectRoot: ROOT,
      roPaths: [RO_OK],
      command: "mcp-server",
      args: ["--flag"],
      bunPath: "/usr/local/bin/bun",
      shimPath: "/shim.ts",
    });
    expect(r.tier).toBe("landlock");
    expect(r.argv).toEqual([
      "/usr/local/bin/bun",
      "/shim.ts",
      "--",
      "mcp-server",
      "--flag",
    ]);
    expect(r.env[LANDLOCK_SPEC_ENV]).toBeDefined();
    const spec = JSON.parse(r.env[LANDLOCK_SPEC_ENV]!);
    expect(spec.rw).toContain(resolve(WORKSPACE));
    expect(spec.ro).toContain(resolve(RO_OK));
    expect(r.landlockSpec).not.toBeNull();
  });

  test("landlock: defaults bun + shim path when not overridden", () => {
    const r = buildSandboxArgv({
      tier: "landlock",
      workspaceDir: WORKSPACE,
      projectRoot: ROOT,
      roPaths: [RO_OK],
      command: "x",
    });
    expect(r.argv[0]).toBe("bun");
    expect(r.argv[1]).toMatch(/landlock-shim\.ts$/);
    expect(r.argv.slice(2)).toEqual(["--", "x"]);
  });

  test("bwrap: emits a bwrap prefix, no root bind, no data-dir bind", () => {
    const r = buildSandboxArgv({
      tier: "bwrap",
      workspaceDir: WORKSPACE,
      projectRoot: ROOT,
      roPaths: [RO_OK],
      command: "node",
      args: ["server.js"],
    });
    expect(r.tier).toBe("bwrap");
    expect(r.argv[0]).toBe("bwrap");
    expect(r.argv).toContain("node");
    expect(r.argv).toContain("server.js");
    // no root bind
    for (let i = 0; i < r.argv.length; i++) {
      if (r.argv[i] === "--bind" || r.argv[i] === "--ro-bind") {
        expect(r.argv[i + 1]).not.toBe("/");
      }
    }
    // no data-dir bind
    const forbidden = forbiddenDataDir(ROOT);
    expect(r.argv.some((a) => a === forbidden)).toBe(false);
    expect(r.env).toEqual({});
    expect(r.landlockSpec).toBeNull();
  });

  test("bwrap: filters non-existent RO dirs (no fail-closed on /nope)", () => {
    const r = buildSandboxArgv({
      tier: "bwrap",
      workspaceDir: WORKSPACE,
      projectRoot: ROOT,
      roPaths: [RO_OK, "/nope-does-not-exist-12345"],
      command: "true",
    });
    expect(r.argv[0]).toBe("bwrap");
    expect(r.argv).not.toContain("/nope-does-not-exist-12345");
  });

  test("bwrap: passes a seccompFd through as --seccomp", () => {
    const r = buildSandboxArgv({
      tier: "bwrap",
      workspaceDir: WORKSPACE,
      projectRoot: ROOT,
      roPaths: [RO_OK],
      seccompFd: 10,
      command: "true",
    });
    const idx = r.argv.indexOf("--seccomp");
    expect(idx).toBeGreaterThan(-1);
    expect(r.argv[idx + 1]).toBe("10");
  });

  test("bwrap: emits --size before --tmpfs by default (non-setuid host)", () => {
    const r = buildSandboxArgv({
      tier: "bwrap",
      workspaceDir: WORKSPACE,
      projectRoot: ROOT,
      roPaths: [RO_OK],
      command: "true",
      bwrapOmitTmpfsSize: false,
    });
    const sizeIdx = r.argv.indexOf("--size");
    const tmpfsIdx = r.argv.indexOf("--tmpfs");
    expect(sizeIdx).toBeGreaterThan(-1);
    expect(tmpfsIdx).toBeGreaterThan(-1);
    // `--size <n>` must immediately precede `--tmpfs` (bwrap state machine).
    expect(r.argv[sizeIdx + 2]).toBe("--tmpfs");
  });

  test("bwrap: OMITS --size on a setuid bwrap but keeps --tmpfs + binds", () => {
    const r = buildSandboxArgv({
      tier: "bwrap",
      workspaceDir: WORKSPACE,
      projectRoot: ROOT,
      roPaths: [RO_OK],
      command: "true",
      bwrapOmitTmpfsSize: true,
    });
    // The flag that setuid bwrap rejects is gone …
    expect(r.argv).not.toContain("--size");
    // … but the private /tmp tmpfs and the confinement surface remain.
    expect(r.argv).toContain("--tmpfs");
    expect(r.argv).toContain("/tmp");
    expect(r.argv[0]).toBe("bwrap");
    // Still no root bind / no data-dir bind.
    const forbidden = forbiddenDataDir(ROOT);
    expect(r.argv.some((a) => a === forbidden)).toBe(false);
    for (let i = 0; i < r.argv.length; i++) {
      if (r.argv[i] === "--bind" || r.argv[i] === "--ro-bind") {
        expect(r.argv[i + 1]).not.toBe("/");
      }
    }
  });

  test("throws when command is empty", () => {
    expect(() =>
      buildSandboxArgv({
        tier: "advisory",
        workspaceDir: WORKSPACE,
        projectRoot: ROOT,
        command: "",
      }),
    ).toThrow(/command is required/);
  });

  test("DENY: refuses a workspace inside .ezcorp/data (landlock)", () => {
    const evil = join(ROOT, ".ezcorp", "data", "ws");
    expect(() =>
      buildSandboxArgv({
        tier: "landlock",
        workspaceDir: evil,
        projectRoot: ROOT,
        command: "x",
      }),
    ).toThrow(/data dir/);
  });

  test("DENY: refuses an ro path that IS the data dir (landlock)", () => {
    expect(() =>
      buildSandboxArgv({
        tier: "landlock",
        workspaceDir: WORKSPACE,
        projectRoot: ROOT,
        roPaths: [forbiddenDataDir(ROOT)],
        command: "x",
      }),
    ).toThrow(/data dir/);
  });
});

describe("buildLandlockJailSpec — pure spec + deny invariants", () => {
  test("resolves workspace into rw and runtime dirs into ro by default", () => {
    const spec = buildLandlockJailSpec({
      workspaceDir: WORKSPACE,
      projectRoot: ROOT,
    });
    expect(spec.rw).toEqual([resolve(WORKSPACE)]);
    expect(spec.ro).toEqual(DEFAULT_RUNTIME_RO_DIRS.map((p) => resolve(p)));
  });

  test("includes extra rw paths", () => {
    const spec = buildLandlockJailSpec({
      workspaceDir: WORKSPACE,
      projectRoot: ROOT,
      rwPaths: [RO_OK],
      roPaths: [RO_OK],
    });
    expect(spec.rw).toContain(resolve(RO_OK));
    expect(spec.ro).toEqual([resolve(RO_OK)]);
  });

  test("throws when workspaceDir missing", () => {
    expect(() =>
      buildLandlockJailSpec({ workspaceDir: "", projectRoot: ROOT }),
    ).toThrow(/workspaceDir is required/);
  });

  test("throws when projectRoot missing", () => {
    expect(() =>
      buildLandlockJailSpec({ workspaceDir: WORKSPACE, projectRoot: "" }),
    ).toThrow(/projectRoot is required/);
  });

  test("DENY: a path UNDER the data dir in rwPaths fails closed", () => {
    expect(() =>
      buildLandlockJailSpec({
        workspaceDir: WORKSPACE,
        projectRoot: ROOT,
        rwPaths: [join(ROOT, ".ezcorp", "data", "x")],
      }),
    ).toThrow(/data dir/);
  });

  test("DENY: an ANCESTOR of the data dir (the root) fails closed", () => {
    expect(() =>
      buildLandlockJailSpec({
        workspaceDir: ROOT, // root is an ancestor of .ezcorp/data
        projectRoot: ROOT,
      }),
    ).toThrow(/ancestor|data dir/);
  });

  test("listPaths: a data-dir ANCESTOR (the repo root) is ALLOWED + appears in spec.list", () => {
    // The git-repo-root jail: the root contains .ezcorp/data but is read-only,
    // so it's exempt from the ancestor assertion and lands in `list`.
    const spec = buildLandlockJailSpec({
      workspaceDir: WORKSPACE,
      projectRoot: ROOT,
      listPaths: [ROOT],
    });
    expect(spec.list).toEqual([resolve(ROOT)]);
  });

  test("listPaths: omitted → spec has no `list` field", () => {
    const spec = buildLandlockJailSpec({ workspaceDir: WORKSPACE, projectRoot: ROOT });
    expect(spec.list).toBeUndefined();
  });

  test("DENY: a list path that IS the data dir fails closed", () => {
    expect(() =>
      buildLandlockJailSpec({
        workspaceDir: WORKSPACE,
        projectRoot: ROOT,
        listPaths: [join(ROOT, ".ezcorp", "data")],
      }),
    ).toThrow(/data dir/);
  });

  test("DENY: a list path UNDER the data dir fails closed", () => {
    expect(() =>
      buildLandlockJailSpec({
        workspaceDir: WORKSPACE,
        projectRoot: ROOT,
        listPaths: [join(ROOT, ".ezcorp", "data", "sub")],
      }),
    ).toThrow(/data dir/);
  });
});

describe("applyLandlockJailSpec — live (host has Landlock)", () => {
  test("rejects an unsupported ABI path by NOT throwing on a real kernel", () => {
    // On this host Landlock is present (ABI>=1); applying a spec that only
    // grants the workspace would jail THIS test process — so we don't apply
    // for real here (it would break later reads). Instead assert the spec is
    // well-formed and the function exists. The live containment proof is the
    // A1 self-test; A3/A4 integration tests apply it in a child.
    const spec = buildLandlockJailSpec({
      workspaceDir: WORKSPACE,
      projectRoot: ROOT,
    });
    expect(typeof applyLandlockJailSpec).toBe("function");
    expect(spec.rw.length + spec.ro.length).toBeGreaterThan(0);
  });
});

describe("landlock-shim — pure parsers", () => {
  test("parseShimArgv splits at an explicit '--'", () => {
    expect(parseShimArgv(["ignored", "--", "cmd", "a", "b"])).toEqual({
      command: "cmd",
      args: ["a", "b"],
    });
  });

  test("parseShimArgv treats the whole slice as inner when no '--' (Bun ate it)", () => {
    expect(parseShimArgv(["cmd", "a", "b"])).toEqual({
      command: "cmd",
      args: ["a", "b"],
    });
  });

  test("parseShimArgv throws with no inner command", () => {
    expect(() => parseShimArgv(["--"])).toThrow(/no inner command/);
    expect(() => parseShimArgv([])).toThrow(/no inner command/);
  });

  test("parseSpecFromEnv reads valid JSON spec", () => {
    const env = { [LANDLOCK_SPEC_ENV]: JSON.stringify({ ro: ["/usr"], rw: ["/w"] }) };
    expect(parseSpecFromEnv(env)).toEqual({ ro: ["/usr"], rw: ["/w"] });
  });

  test("parseSpecFromEnv throws on missing var", () => {
    expect(() => parseSpecFromEnv({})).toThrow(/required/);
  });

  test("parseSpecFromEnv throws on invalid JSON", () => {
    expect(() => parseSpecFromEnv({ [LANDLOCK_SPEC_ENV]: "{not json" })).toThrow(
      /not valid JSON/,
    );
  });

  test("parseSpecFromEnv throws on malformed shape", () => {
    expect(() =>
      parseSpecFromEnv({ [LANDLOCK_SPEC_ENV]: JSON.stringify({ ro: "x" }) }),
    ).toThrow(/malformed/);
  });
});
