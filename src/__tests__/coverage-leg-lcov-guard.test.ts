/**
 * Coverage-leg lcov guard (closes the full-local silent-skip gap).
 *
 * scripts/test-coverage.sh merges by GLOBBING "$TMPDIR"/cov_*​/lcov.info, so a
 * leg that dies before writing one is simply absent from the union — silently.
 * Shard mode has always guarded the analogous case (its N_LCOV check); the two
 * leg-running modes (full local + CI legs-only) did not. That never allowed a
 * false GREEN — the gating legs' exit codes and the coverage gate still red the
 * run — but it destroyed diagnosability: a single dead leg drops its files out
 * of the merged lcov and the gate then prints one
 * "listed in thresholds but no lcov data" violation per orphaned file, burying
 * the real failure under phantom ones naming files the change never touched.
 *
 * Two halves, both tested here:
 *   1. BEHAVIOUR — check_leg_lcov (scripts/lib/test-file-sets.sh) fails loud and
 *      NAMES each registered leg that produced no lcov. Exercised against the
 *      real function via bash + real temp dirs, never a re-implementation.
 *   2. ANTI-ROT — the leg producers in scripts/test-coverage.sh may only obtain
 *      a covdir from the LEG_COV_DIR registry, so a leg cannot be added that
 *      writes somewhere the guard never looks. This is what keeps the guard's
 *      leg list from rotting away from the legs the script actually runs.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SETS_LIB = "scripts/lib/test-file-sets.sh";
const RUNNER = join(REPO_ROOT, "scripts/test-coverage.sh");

const LCOV = "TN:\nSF:/repo/src/x.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n";

type Run = { code: number; stdout: string; stderr: string };

/** Run a bash snippet with the shared lib sourced and $TMPDIR pointed at `tmp`. */
function runGuard(tmp: string, body: string): Run {
  const script = `set -e\nsource ${SETS_LIB}\nTMPDIR=${JSON.stringify(tmp)}\n${body}\n`;
  const proc = Bun.spawnSync(["bash", "-c", script], { cwd: REPO_ROOT });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** Create <tmp>/<dir>/lcov.info with `content` ("" makes an EMPTY file). */
function seedLeg(tmp: string, dir: string, content: string): void {
  mkdirSync(join(tmp, dir), { recursive: true });
  writeFileSync(join(tmp, dir, "lcov.info"), content);
}

function withTmp<T>(fn: (tmp: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), "leg-lcov-"));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// The registrations the runner actually makes, so the behaviour cases below
// exercise realistic names/dirs rather than invented ones.
const REGISTER_ALL = [
  "register_leg sdk cov_sdk",
  "register_leg harness-client cov_hc",
  "register_leg suggest cov_suggest",
  "register_leg ai-kit cov_aikit",
  "register_leg web-vitest cov_vitest",
  "register_leg web-security cov_security",
].join("\n");

const ALL_DIRS: ReadonlyArray<[string, string]> = [
  ["sdk", "cov_sdk"],
  ["harness-client", "cov_hc"],
  ["suggest", "cov_suggest"],
  ["ai-kit", "cov_aikit"],
  ["web-vitest", "cov_vitest"],
  ["web-security", "cov_security"],
];

describe("check_leg_lcov: behaviour", () => {
  test("passes silently when every registered leg wrote a non-empty lcov", () => {
    withTmp((tmp) => {
      for (const [, dir] of ALL_DIRS) seedLeg(tmp, dir, LCOV);
      const r = runGuard(tmp, `${REGISTER_ALL}\ncheck_leg_lcov`);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
    });
  });

  test("a leg with NO lcov fails the guard and is named — healthy legs are not", () => {
    withTmp((tmp) => {
      // Every leg but sdk produced its lcov: exactly the incident shape (the
      // sdk leg is pass/fail-TOLERATED, so its death is otherwise invisible).
      for (const [name, dir] of ALL_DIRS) if (name !== "sdk") seedLeg(tmp, dir, LCOV);
      const r = runGuard(tmp, `${REGISTER_ALL}\ncheck_leg_lcov`);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("::error::sdk coverage leg produced no lcov output");
      expect(r.stdout).toContain("(infrastructure failure)");
      // The expected path is named so the failure is actionable, not just loud.
      expect(r.stdout).toContain(join(tmp, "cov_sdk", "lcov.info"));
      for (const name of ["harness-client", "suggest", "ai-kit", "web-vitest", "web-security"]) {
        expect(r.stdout).not.toContain(`::error::${name} coverage leg`);
      }
    });
  });

  test("an EMPTY lcov counts as missing (it merges to nothing either way)", () => {
    withTmp((tmp) => {
      for (const [name, dir] of ALL_DIRS) seedLeg(tmp, dir, name === "web-vitest" ? "" : LCOV);
      const r = runGuard(tmp, `${REGISTER_ALL}\ncheck_leg_lcov`);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("::error::web-vitest coverage leg produced no lcov output");
    });
  });

  test("every dead leg is named, not just the first", () => {
    withTmp((tmp) => {
      seedLeg(tmp, "cov_sdk", LCOV);
      seedLeg(tmp, "cov_hc", LCOV);
      const r = runGuard(tmp, `${REGISTER_ALL}\ncheck_leg_lcov`);
      expect(r.code).toBe(1);
      for (const name of ["suggest", "ai-kit", "web-vitest", "web-security"]) {
        expect(r.stdout).toContain(`::error::${name} coverage leg produced no lcov output`);
      }
    });
  });

  test("only legs registered in THIS mode are expected (web-security is full-local only)", () => {
    withTmp((tmp) => {
      // legs-only mode never runs run_security_leg, so cov_security is absent
      // by design and must not be reported.
      for (const [name, dir] of ALL_DIRS) if (name !== "web-security") seedLeg(tmp, dir, LCOV);
      const legsOnly = REGISTER_ALL.split("\n")
        .filter((l) => !l.includes("web-security"))
        .join("\n");
      const r = runGuard(tmp, `${legsOnly}\ncheck_leg_lcov`);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    });
  });

  test("registering nothing passes — host-shard mode runs no legs at all", () => {
    withTmp((tmp) => {
      const r = runGuard(tmp, "check_leg_lcov");
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    });
  });

  test("registering from a subshell is REFUSED, not silently discarded", () => {
    withTmp((tmp) => {
      // The one-line mistake that would reinstate the silent skip: registering
      // inside the `( … ) &` that launches the leg mutates a COPY, so the
      // parent never expects it. Enforced rather than merely commented.
      const r = runGuard(tmp, "( register_leg sdk cov_sdk )\ncheck_leg_lcov");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("register_leg 'sdk' was called from a SUBSHELL");
    });
  });

  test("…while the correct parent-shell call still registers normally", () => {
    withTmp((tmp) => {
      // Negative control: the guard must not fire on legitimate usage, or the
      // real producers in test-coverage.sh would all die at registration.
      const r = runGuard(tmp, "register_leg sdk cov_sdk\ncheck_leg_lcov");
      expect(r.code).toBe(1); // no lcov seeded → the leg is reported, not skipped
      expect(r.stderr).not.toContain("SUBSHELL");
      expect(r.stdout).toContain("::error::sdk coverage leg produced no lcov output");
    });
  });
});

// ── anti-rot: the producers may only get a covdir from the registry ─────────
describe("test-coverage.sh: leg covdirs come from the registry", () => {
  const runner = Bun.file(RUNNER).text();

  test("no leg hardcodes a $TMPDIR/cov_<name> path (host pool's cov_$idx aside)", async () => {
    const src = await runner;
    // The ONLY legitimate literal `$TMPDIR/cov_…` uses are the host pool's
    // per-file dirs (indexed: $idx while running, $i while counting) and the
    // merge glob `cov_*`. Anything else is a leg writing outside the registry
    // — exactly the drift that would let a future leg run unguarded.
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => /\$TMPDIR\/cov_/.test(line))
      .filter(({ line }) => !/\$TMPDIR\/cov_(\$(idx|i)\b|\*)/.test(line));
    expect(
      offenders.map((o) => `${o.no}: ${o.line.trim()}`),
      "a leg covdir must be read out of the LEG_COV_DIR registry " +
        "(scripts/lib/test-file-sets.sh) so check_leg_lcov is guaranteed to look " +
        "where the leg actually writes",
    ).toEqual([]);
  });

  test("every registered leg is used by a producer, and every used leg is registered", async () => {
    const src = await runner;
    const registered = [...src.matchAll(/^\s*register_leg\s+(\S+)\s+(\S+)\s*$/gm)].map((m) => m[1]);
    const referenced = [...src.matchAll(/\$\{LEG_COV_DIR\[([^\]]+)\]\}/g)].map((m) => m[1]);
    expect(registered.length).toBeGreaterThanOrEqual(6);
    expect(new Set(registered).size).toBe(registered.length);
    expect([...new Set(referenced)].sort()).toEqual([...new Set(registered)].sort());
  });

  test("both leg-running modes call the guard", async () => {
    const src = await runner;
    const legsOnlyBranch = src.indexOf('if [ -n "$COVERAGE_LEGS_ONLY" ]');
    const fullModeTail = src.indexOf("# ── full local mode:");
    expect(legsOnlyBranch).toBeGreaterThan(-1);
    expect(fullModeTail).toBeGreaterThan(legsOnlyBranch);
    const calls = [...src.matchAll(/^\s*check_leg_lcov\b/gm)].map((m) => m.index ?? -1);
    // One call inside the legs-only branch, one in the full-local tail.
    expect(calls.filter((i) => i > legsOnlyBranch && i < fullModeTail).length).toBe(1);
    expect(calls.filter((i) => i > fullModeTail).length).toBe(1);
  });
});
