/**
 * The Bun.SQL pipelining guard (src/db/bun-sql-pipelining.ts): which Bun releases it covers, how it reads the flag,
 * that a late process.env write cannot satisfy it, that the pinned Bun is either covered or recorded as fixed, and
 * that no product code opens Bun.SQL around it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Glob } from "bun";
import {
  BUN_SQL_PIPELINING_DEFECT,
  BUN_SQL_PIPELINING_FLAG,
  BunSqlPipeliningGuardError,
  assertBunSqlPipeliningOff,
  bunSqlPipeliningVerdict,
  flagIsOn,
  guardedBunSqlClass,
  openBunSql,
  startEnvironment,
} from "./bun-sql-pipelining";

const ROOT = resolve(import.meta.dir, "../..");
const GUARD = join(import.meta.dir, "bun-sql-pipelining.ts");

/** Runs `code` in a fresh Bun whose start environment has, or lacks, the flag. */
function child(code: string, flag: string | undefined) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (flag !== undefined) env[BUN_SQL_PIPELINING_FLAG] = flag;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "pipe" });
  return { exitCode: run.exitCode, stdout: run.stdout.toString().trim(), stderr: run.stderr.toString() };
}

describe("assertBunSqlPipeliningOff", () => {
  test("covers exactly the affected releases", () => {
    expect(BUN_SQL_PIPELINING_DEFECT.affected).toEqual(["1.4.0", "1.4.1", "1.4.2"]);
    for (const version of ["1.3.14", "1.4.3", "2.0.0"]) expect(() => assertBunSqlPipeliningOff(version, {})).not.toThrow();
    for (const version of BUN_SQL_PIPELINING_DEFECT.affected) {
      expect(() => assertBunSqlPipeliningOff(version, {})).toThrow(BunSqlPipeliningGuardError);
      expect(() => assertBunSqlPipeliningOff(version, { [BUN_SQL_PIPELINING_FLAG]: "1" })).not.toThrow();
    }
  });

  test("refuses by name, and reads the flag the way Bun does", () => {
    expect(() => assertBunSqlPipeliningOff("1.4.2", {})).toThrow(`bun_sql_pipelining_guard: Bun 1.4.2 needs ${BUN_SQL_PIPELINING_FLAG}=1`);
    for (const off of [undefined, "", "0", "false", "FALSE", "no", "Off"]) expect(flagIsOn(off)).toBe(false);
    for (const on of ["1", "true", "yes", "on", "anything"]) expect(flagIsOn(on)).toBe(true);
    expect(() => assertBunSqlPipeliningOff("1.4.2", { [BUN_SQL_PIPELINING_FLAG]: "off" })).toThrow(BunSqlPipeliningGuardError);
  });

  test("reads the start environment from /proc/self/environ, and falls back to process.env", () => {
    expect(startEnvironment(() => Buffer.from(`A=1\0${BUN_SQL_PIPELINING_FLAG}=1\0B=x=y\0`))).toEqual({ A: "1", [BUN_SQL_PIPELINING_FLAG]: "1", B: "x=y" });
    expect(startEnvironment(() => { throw new Error("no /proc"); })).toBe(process.env);
  });

  test("takes the /proc/self/environ path whenever that file exists", () => {
    const procExists = existsSync("/proc/self/environ");
    const read = startEnvironment();
    expect(read === process.env).toBe(!procExists);
    if (procExists) expect(read.PATH).toBe(process.env.PATH);
  });

  // Bun ignores the flag when it is written into process.env after start; so must the guard, where the start
  // environment is readable (Linux). Elsewhere the guard can only read process.env, and says so in its comment.
  test("a process.env write after start does not satisfy it on Linux", () => {
    const code = `process.env.${BUN_SQL_PIPELINING_FLAG} = "1"; const g = await import(${JSON.stringify(GUARD)}); try { g.assertBunSqlPipeliningOff("1.4.2"); console.log("allowed"); } catch (e) { console.log(e.name); }`;
    expect(child(code, undefined).stdout).toBe(process.platform === "linux" ? "BunSqlPipeliningGuardError" : "allowed");
    expect(child(code, "1").stdout).toBe("allowed");
  });

  test("openBunSql refuses on the pinned Bun without the flag at start, and opens with it", () => {
    const code = `const g = await import(${JSON.stringify(GUARD)}); try { const sql = g.openBunSql("postgres://u:p@127.0.0.1:1/db", { max: 1 }); console.log(typeof sql.close); } catch (e) { console.log(e.name); }`;
    const affected = BUN_SQL_PIPELINING_DEFECT.affected.includes(Bun.version);
    expect(child(code, undefined).stdout).toBe(affected ? "BunSqlPipeliningGuardError" : "function");
    expect(child(code, "1").stdout).toBe("function");
  });

  test("in this process, openBunSql follows this process's own start environment", async () => {
    const allowed = !BUN_SQL_PIPELINING_DEFECT.affected.includes(Bun.version) || flagIsOn(startEnvironment()[BUN_SQL_PIPELINING_FLAG]);
    if (allowed) {
      const sql = openBunSql("postgres://u:p@127.0.0.1:1/db", { max: 1 });
      expect(typeof sql.close).toBe("function");
      await sql.close();
      expect(guardedBunSqlClass(Bun.SQL)).toBe(Bun.SQL);
    } else {
      expect(() => openBunSql("postgres://u:p@127.0.0.1:1/db", { max: 1 })).toThrow(BunSqlPipeliningGuardError);
      expect(() => guardedBunSqlClass(Bun.SQL)).toThrow(BunSqlPipeliningGuardError);
    }
  });
});

describe("the test harness", () => {
  // src/__tests__/preload.ts runs the guard whenever a real PostgreSQL URL is configured, so a real-PostgreSQL suite
  // started without the flag fails before its first test instead of running with the defect.
  test("a real-PostgreSQL test run without the flag at start fails by name in the preload", () => {
    const probe = join(mkdtempSync(join(tmpdir(), "pipelining-preload-")), "probe.test.ts");
    writeFileSync(probe, 'import { expect, test } from "bun:test";\ntest("ran", () => { expect(1).toBe(1); });\n');
    try {
      const run = (flag: string | undefined) => {
        const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", FACTORY_TEST_POSTGRES_URL: "postgres://u:p@127.0.0.1:1/db" };
        if (flag !== undefined) env[BUN_SQL_PIPELINING_FLAG] = flag;
        const result = Bun.spawnSync([process.execPath, "test", probe], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
        return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
      };
      const affected = BUN_SQL_PIPELINING_DEFECT.affected.includes(Bun.version);
      const without = run(undefined);
      expect(without.exitCode === 0).toBe(!affected);
      if (affected) expect(without.output).toContain("bun_sql_pipelining_guard");
      const withFlag = run("1");
      expect(withFlag.exitCode, withFlag.output).toBe(0);
    } finally { rmSync(dirname(probe), { recursive: true, force: true }); }
  }, 60_000);
});

describe("the pin and the list agree", () => {
  // The list is closed upward: a Bun at or above 1.4.0 is either affected (guarded) or proven clean by a recorded
  // 3000-trial harness pass. A bump to any other release cannot drop the mitigation without that proof.
  test("sorts releases: before the defect's range, affected, proven clean, or unknown", () => {
    expect(bunSqlPipeliningVerdict("1.3.14")).toBe("before-range");
    expect(bunSqlPipeliningVerdict("1.4.2")).toBe("affected");
    expect(bunSqlPipeliningVerdict("1.4.3")).toBe("unknown");
    expect(BUN_SQL_PIPELINING_DEFECT.provenClean).toEqual([]);
  });

  test("the pinned Bun is before the range, affected or proven clean", () => {
    const pin = readFileSync(join(ROOT, ".bun-version"), "utf8").trim();
    expect(
      bunSqlPipeliningVerdict(pin),
      `Bun ${pin} is neither affected nor proven clean for the request-queue defect (oven-sh/bun#32088, #43187): run the 3000-trial harness and record the result`,
    ).not.toBe("unknown");
  });
});

describe("every Bun.SQL client goes through the guard", () => {
  // The guarded opener is the only place product and script code may construct Bun.SQL; tests open their own.
  test("no product or script file constructs Bun.SQL directly", () => {
    const offenders: string[] = [];
    for (const pattern of ["src/**/*.ts", "scripts/**/*.ts", "packages/@ezcorp/*/src/**/*.ts", "web/src/**/*.ts"]) {
      for (const file of new Glob(pattern).scanSync({ cwd: ROOT })) {
        if (/\.test\.ts$|\/__tests__\/|^src\/db\/bun-sql-pipelining\.ts$/.test(file)) continue;
        const source = readFileSync(join(ROOT, file), "utf8");
        if (/new\s+(Bun\.)?SQL\s*\(|new\s*\(\s*bunSqlClass\(\)\s*\)/.test(source)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
