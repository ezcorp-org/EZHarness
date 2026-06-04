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
 *  - assertJailArgsSafe rejects a tampered argv
 */
import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import {
  buildPreviewJailBwrapArgs,
  assertJailArgsSafe,
  assertOutsideDataDir,
  forbiddenDataDir,
  DEFAULT_RO_SYSTEM_DIRS,
} from "../extensions/preview-jail";

const ROOT = "/srv/project";
const WORK = "/srv/project/.ezcorp/sites/conv-1";

function build(over: Partial<Parameters<typeof buildPreviewJailBwrapArgs>[0]> = {}) {
  return buildPreviewJailBwrapArgs({
    workDir: WORK,
    projectRoot: ROOT,
    command: "bun",
    args: ["run", "dev"],
    roSystemDirs: ["/usr", "/bin", "/lib"],
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

  test("the work dir is the ONLY rw --bind; system dirs are --ro-bind", () => {
    const args = build();
    const rwBinds: string[] = [];
    const roBinds: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--bind") rwBinds.push(args[i + 1]!);
      if (args[i] === "--ro-bind") roBinds.push(args[i + 1]!);
    }
    expect(rwBinds).toEqual([resolve(WORK)]);
    expect(roBinds).toEqual(["/usr", "/bin", "/lib"]);
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

  test("includes hardening flags + chdir into the work dir", () => {
    const args = build();
    expect(args).toContain("--unshare-all");
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--new-session");
    const chdirIdx = args.indexOf("--chdir");
    expect(args[chdirIdx + 1]).toBe(resolve(WORK));
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

  test("uses the default RO system dir list when none given", () => {
    const args = build({ roSystemDirs: undefined });
    const roBinds: string[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === "--ro-bind") roBinds.push(args[i + 1]!);
    expect(roBinds).toEqual([...DEFAULT_RO_SYSTEM_DIRS]);
  });

  test("fails closed when the work dir IS the data dir / under it / an ancestor", () => {
    expect(() => build({ workDir: resolve(ROOT, ".ezcorp/data") })).toThrow();
    expect(() => build({ workDir: resolve(ROOT, ".ezcorp/data/x") })).toThrow();
    expect(() => build({ workDir: "/" })).toThrow();
    expect(() => build({ workDir: ROOT })).toThrow();
  });

  test("fails closed when a RO dir overlaps the data dir", () => {
    expect(() => build({ roSystemDirs: ["/usr", resolve(ROOT, ".ezcorp/data")] })).toThrow();
  });

  test("rejects empty required inputs", () => {
    expect(() => buildPreviewJailBwrapArgs({ workDir: "", projectRoot: ROOT, command: "bun" })).toThrow(/workDir/);
    expect(() => buildPreviewJailBwrapArgs({ workDir: WORK, projectRoot: "", command: "bun" })).toThrow(/projectRoot/);
    expect(() => buildPreviewJailBwrapArgs({ workDir: WORK, projectRoot: ROOT, command: "" })).toThrow(/command/);
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
