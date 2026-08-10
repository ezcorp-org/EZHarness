/**
 * Secure User-Site Preview / Port Exposure — Phase 1.
 * Filesystem-jail bind-set builder (CRITICAL — closes the .ezcorp/data
 * read hole for untrusted preview processes).
 *
 * The load-bearing invariants under test:
 *  - NO `--bind / /` (root bind) is ever produced
 *  - NOTHING under <projectRoot>/.ezcorp/data is bound
 *  - the work dir is the ONLY rw bind; system dirs are --ro-bind
 *  - a private tmpfs at /tmp with --size BEFORE --tmpfs
 *  - the builder fails CLOSED if asked to bind the data dir, a path under
 *    it, or an ancestor of it (incl. "/")
 *  - the builder REALPATHs the work dir before the exclusion check, so a
 *    symlink (or symlinked ancestor) pointing into .ezcorp/data is caught
 *  - a non-existent work/RO dir fails closed (throws) rather than binding
 *    an unverified path
 *  - assertJailArgsSafe rejects a tampered argv
 *
 * NOTE: the builder now canonicalizes paths with realpath + fails closed
 * on missing dirs, so these tests use REAL temp fixtures (not fictional
 * /srv paths). Bind assertions compare against the realpath of the input.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildPreviewJailBwrapArgs,
  buildMcpJailBwrapArgs,
  assertJailArgsSafe,
  assertOutsideDataDir,
  forbiddenDataDir,
  canonicalizeJailPath,
  DEFAULT_RO_SYSTEM_DIRS,
} from "../extensions/preview-jail";

// Real on-disk fixtures: a project root, its .ezcorp/{data,sites/conv-1},
// and a small set of RO dirs the builder can canonicalize.
let ROOT: string; // realpath of the project root
let WORK: string; // <root>/.ezcorp/sites/conv-1 (real, writable)
let RO1: string; // real RO dir
let RO2: string; // real RO dir
let DATA: string; // <root>/.ezcorp/data
let symlinkIntoData: string; // a symlink whose target is under DATA

beforeAll(async () => {
  const base = realpathSync(await mkdtemp(join(tmpdir(), "ezjail-")));
  ROOT = join(base, "project");
  DATA = join(ROOT, ".ezcorp", "data");
  WORK = join(ROOT, ".ezcorp", "sites", "conv-1");
  RO1 = join(base, "ro1");
  RO2 = join(base, "ro2");
  await mkdir(WORK, { recursive: true });
  await mkdir(DATA, { recursive: true });
  await mkdir(RO1, { recursive: true });
  await mkdir(RO2, { recursive: true });
  // A symlink that LEXICALLY sits under .ezcorp/sites but REALLY points
  // into .ezcorp/data — the escape the realpath canonicalization defends
  // against.
  symlinkIntoData = join(ROOT, ".ezcorp", "sites", "sneaky");
  await symlink(DATA, symlinkIntoData);
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
});

function build(over: Partial<Parameters<typeof buildPreviewJailBwrapArgs>[0]> = {}) {
  return buildPreviewJailBwrapArgs({
    workDir: WORK,
    projectRoot: ROOT,
    command: "bun",
    args: ["run", "dev"],
    roSystemDirs: [RO1, RO2],
    ...over,
  });
}

describe("forbiddenDataDir / assertOutsideDataDir", () => {
  test("computes the normalized .ezcorp/data path", () => {
    expect(forbiddenDataDir(ROOT)).toBe(resolve(ROOT, ".ezcorp/data"));
  });

  test("throws for the data dir, a child, and an ancestor", () => {
    expect(() => assertOutsideDataDir(resolve(ROOT, ".ezcorp/data"), ROOT)).toThrow();
    expect(() => assertOutsideDataDir(resolve(ROOT, ".ezcorp/data/pglite"), ROOT)).toThrow();
    expect(() => assertOutsideDataDir(ROOT, ROOT)).toThrow(); // ancestor exposes it
    expect(() => assertOutsideDataDir("/", ROOT)).toThrow(); // root exposes it
  });

  test("allows a sibling path", () => {
    expect(() => assertOutsideDataDir(resolve(ROOT, ".ezcorp/sites/x"), ROOT)).not.toThrow();
    expect(() => assertOutsideDataDir("/usr", ROOT)).not.toThrow();
  });
});

describe("canonicalizeJailPath", () => {
  test("resolves a real path through symlinks", () => {
    expect(canonicalizeJailPath(WORK, "workDir")).toBe(realpathSync(WORK));
    // The sneaky symlink canonicalizes to its real target under .ezcorp/data.
    expect(canonicalizeJailPath(symlinkIntoData, "workDir")).toBe(realpathSync(DATA));
  });

  test("fails closed for a non-existent path", () => {
    expect(() => canonicalizeJailPath(join(ROOT, "nope"), "workDir")).toThrow(/fail-closed/);
  });
});

describe("buildPreviewJailBwrapArgs", () => {
  test("NEVER contains a root bind (--bind / /)", () => {
    const args = build();
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--bind" || args[i] === "--ro-bind") {
        expect(args[i + 1]).not.toBe("/");
      }
    }
    // also no bare "--bind / /" subsequence
    const joined = args.join(" ");
    expect(joined).not.toContain("--bind / /");
  });

  test("binds NOTHING under .ezcorp/data", () => {
    const args = build();
    const data = forbiddenDataDir(ROOT);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--bind" || args[i] === "--ro-bind") {
        const src = args[i + 1]!;
        expect(src === data || src.startsWith(data + "/")).toBe(false);
      }
    }
    // The whole argv passes the safety assertion.
    expect(() => assertJailArgsSafe(args, ROOT)).not.toThrow();
  });

  test("the work dir is the ONLY rw --bind (realpath'd); system dirs are --ro-bind", () => {
    const args = build();
    const rwBinds: string[] = [];
    const roBinds: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--bind") rwBinds.push(args[i + 1]!);
      if (args[i] === "--ro-bind") roBinds.push(args[i + 1]!);
    }
    expect(rwBinds).toEqual([realpathSync(WORK)]);
    expect(roBinds).toEqual([realpathSync(RO1), realpathSync(RO2)]);
  });

  test("sets a private tmpfs at /tmp with --size BEFORE --tmpfs", () => {
    const args = build({ tmpfsBytes: 1234 });
    const sizeIdx = args.indexOf("--size");
    const tmpfsIdx = args.indexOf("--tmpfs");
    expect(sizeIdx).toBeGreaterThanOrEqual(0);
    expect(args[sizeIdx + 1]).toBe("1234");
    expect(tmpfsIdx).toBe(sizeIdx + 2);
    expect(args[tmpfsIdx + 1]).toBe("/tmp");
  });

  test("includes hardening flags + chdir into the (realpath'd) work dir", () => {
    const args = build();
    expect(args).toContain("--unshare-all");
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--new-session");
    const chdirIdx = args.indexOf("--chdir");
    expect(args[chdirIdx + 1]).toBe(realpathSync(WORK));
  });

  test("appends --seccomp <fd> only when provided", () => {
    expect(build().includes("--seccomp")).toBe(false);
    const withFd = build({ seccompFd: 3 });
    const idx = withFd.indexOf("--seccomp");
    expect(withFd[idx + 1]).toBe("3");
  });

  test("terminates with -- then the inner command + args", () => {
    const args = build();
    const dd = args.indexOf("--");
    expect(args.slice(dd)).toEqual(["--", "bun", "run", "dev"]);
  });

  test("uses the default RO system dir list (filtered to existing dirs) when none given", () => {
    // The default list contains dirs that may not exist on every host
    // (NixOS lacks /sbin, /lib). Pass only the subset that exists so the
    // fail-closed canonicalization can resolve them — exactly what the
    // launcher does in production.
    const existing = DEFAULT_RO_SYSTEM_DIRS.filter((d) => {
      try {
        realpathSync(d);
        return true;
      } catch {
        return false;
      }
    });
    const args = build({ roSystemDirs: existing });
    const roBinds: string[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === "--ro-bind") roBinds.push(args[i + 1]!);
    expect(roBinds).toEqual(existing.map((d) => realpathSync(d)));
  });

  test("fails closed when the work dir IS the data dir / under it / an ancestor", () => {
    expect(() => build({ workDir: DATA })).toThrow();
    expect(() => build({ workDir: ROOT })).toThrow();
    expect(() => build({ workDir: "/" })).toThrow();
  });

  test("fails closed when the work dir is a SYMLINK into .ezcorp/data (realpath escape)", () => {
    // Lexically `symlinkIntoData` sits under .ezcorp/sites (would pass the
    // old string-prefix check); its realpath is under .ezcorp/data, so the
    // canonicalize-before-assert step must reject it.
    expect(() => build({ workDir: symlinkIntoData })).toThrow();
  });

  test("fails closed when the work dir does not exist", () => {
    expect(() => build({ workDir: join(ROOT, "missing-workdir") })).toThrow(/fail-closed/);
  });

  test("fails closed when a RO dir overlaps the data dir", () => {
    expect(() => build({ roSystemDirs: [RO1, DATA] })).toThrow();
  });

  test("fails closed when a RO dir does not exist", () => {
    expect(() => build({ roSystemDirs: [RO1, join(ROOT, "no-such-ro")] })).toThrow(/fail-closed/);
  });

  test("rejects empty required inputs", () => {
    expect(() =>
      buildPreviewJailBwrapArgs({ workDir: "", projectRoot: ROOT, command: "bun" }),
    ).toThrow(/workDir/);
    expect(() =>
      buildPreviewJailBwrapArgs({ workDir: WORK, projectRoot: "", command: "bun" }),
    ).toThrow(/projectRoot/);
    expect(() =>
      buildPreviewJailBwrapArgs({ workDir: WORK, projectRoot: ROOT, command: "" }),
    ).toThrow(/command/);
  });
});

// CRITICAL MCP filesystem-confinement fix — the strict-leg argv that
// replaces the launcher's `--bind / /` envelope for MCP spawns. Shares
// the bind-set core with the preview jail; the variant differences
// (namespace flags, --dir re-creation inside /tmp) are locked here.
describe("buildMcpJailBwrapArgs", () => {
  function buildMcp(over: Partial<Parameters<typeof buildMcpJailBwrapArgs>[0]> = {}) {
    return buildMcpJailBwrapArgs({
      workDir: WORK,
      projectRoot: ROOT,
      command: "prlimit",
      args: ["--rss=1", "--as=2", "/usr/bin/python3", "-m", "srv"],
      roSystemDirs: [RO1, RO2],
      ...over,
    });
  }

  test("NEVER contains a root bind and binds NOTHING under .ezcorp/data", () => {
    const args = buildMcp();
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--bind" || args[i] === "--ro-bind") {
        expect(args[i + 1]).not.toBe("/");
      }
    }
    expect(args.join(" ")).not.toContain("--bind / /");
    expect(() => assertJailArgsSafe(args, ROOT)).not.toThrow();
  });

  test("shares the HOST net + pid namespaces: no --unshare-* flags (proxy reachability + journalctl pid match)", () => {
    const args = buildMcp();
    expect(args.some((a) => a.startsWith("--unshare"))).toBe(false);
    // Hardening flags from the shared core stay on.
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--new-session");
  });

  test("work dir is the ONLY rw bind; system dirs are --ro-bind; tmpfs /tmp with --size first", () => {
    const args = buildMcp();
    const rwBinds: string[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === "--bind") rwBinds.push(args[i + 1]!);
    expect(rwBinds).toEqual([realpathSync(WORK)]);
    const sizeIdx = args.indexOf("--size");
    expect(args[sizeIdx + 2]).toBe("--tmpfs");
    expect(args[sizeIdx + 3]).toBe("/tmp");
  });

  test("re-creates tmpDirs via --dir AFTER the /tmp tmpfs (private-tmpfs targets only)", () => {
    const args = buildMcp({ tmpDirs: ["/tmp/ezcorp-ext/abc123"] });
    const dirIdx = args.indexOf("--dir");
    const tmpfsIdx = args.indexOf("--tmpfs");
    expect(dirIdx).toBeGreaterThan(tmpfsIdx);
    expect(args[dirIdx + 1]).toBe("/tmp/ezcorp-ext/abc123");
  });

  test("fails closed on a --dir target outside /tmp (would mkdir through a host bind)", () => {
    expect(() => buildMcp({ tmpDirs: ["/var/ezcorp-ext/abc"] })).toThrow(/\/tmp/);
    expect(() => buildMcp({ tmpDirs: ["/tmp"] })).toThrow(/\/tmp/);
  });

  test("terminates with -- then the inner prlimit chain; --seccomp passthrough", () => {
    const args = buildMcp({ seccompFd: 3 });
    const dd = args.indexOf("--");
    expect(args.slice(dd)).toEqual([
      "--",
      "prlimit",
      "--rss=1",
      "--as=2",
      "/usr/bin/python3",
      "-m",
      "srv",
    ]);
    expect(args[args.indexOf("--seccomp") + 1]).toBe("3");
  });

  test("fails closed on data-dir / ancestor / symlinked-into-data work dirs (same invariants as preview)", () => {
    expect(() => buildMcp({ workDir: DATA })).toThrow();
    expect(() => buildMcp({ workDir: ROOT })).toThrow();
    expect(() => buildMcp({ workDir: "/" })).toThrow();
    expect(() => buildMcp({ workDir: symlinkIntoData })).toThrow();
    expect(() => buildMcp({ roSystemDirs: [RO1, DATA] })).toThrow();
  });
});

describe("assertJailArgsSafe", () => {
  test("rejects a tampered argv that re-introduces a root bind", () => {
    const bad = ["--bind", "/", "/", "--", "bun"];
    expect(() => assertJailArgsSafe(bad, ROOT)).toThrow(/root bind/);
  });

  test("rejects a tampered argv binding the data dir", () => {
    const bad = ["--ro-bind", forbiddenDataDir(ROOT), "/data", "--", "bun"];
    expect(() => assertJailArgsSafe(bad, ROOT)).toThrow(/data dir/);
  });
});
