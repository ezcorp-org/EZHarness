import { test, expect, describe } from "bun:test";
import {
  parseGrepTimeoutMs,
  resolveBackend,
  buildSearchArgs,
  type GrepParams,
} from "../runtime/tools/grep";

describe("parseGrepTimeoutMs", () => {
  test("env unset → 30000 default", () => {
    expect(parseGrepTimeoutMs(undefined)).toBe(30000);
  });

  test("valid finite positive → that value", () => {
    expect(parseGrepTimeoutMs("5000")).toBe(5000);
  });

  test("whitespace around a number is tolerated (Number coercion)", () => {
    expect(parseGrepTimeoutMs("  4000  ")).toBe(4000);
  });

  test("clamps below the 1000ms floor", () => {
    expect(parseGrepTimeoutMs("500")).toBe(1000);
  });

  test("clamps above the 600000ms ceiling", () => {
    expect(parseGrepTimeoutMs("999999")).toBe(600000);
  });

  test("floors fractional values", () => {
    expect(parseGrepTimeoutMs("60000.7")).toBe(60000);
  });

  test("non-numeric → default", () => {
    expect(parseGrepTimeoutMs("abc")).toBe(30000);
  });

  test("Infinity → default", () => {
    expect(parseGrepTimeoutMs("Infinity")).toBe(30000);
  });

  test("empty string → default", () => {
    expect(parseGrepTimeoutMs("")).toBe(30000);
  });

  test("zero → default", () => {
    expect(parseGrepTimeoutMs("0")).toBe(30000);
  });

  test("negative → default", () => {
    expect(parseGrepTimeoutMs("-100")).toBe(30000);
  });
});

describe("resolveBackend", () => {
  test("override 'grep' wins even when rg is available", () => {
    expect(resolveBackend("/usr/bin/rg", "grep")).toBe("grep");
  });

  test("override 'rg' wins even when rg path is null (misconfig is caller's problem)", () => {
    expect(resolveBackend(null, "rg")).toBe("rg");
  });

  test("auto: rg present → rg", () => {
    expect(resolveBackend("/usr/bin/rg", undefined)).toBe("rg");
  });

  test("auto: rg absent → grep fallback", () => {
    expect(resolveBackend(null, undefined)).toBe("grep");
  });

  test("unknown override string falls through to auto-detect (rg present)", () => {
    expect(resolveBackend("/usr/bin/rg", "auto")).toBe("rg");
  });

  test("unknown override string falls through to auto-detect (rg absent)", () => {
    expect(resolveBackend(null, "ripgrep-please")).toBe("grep");
  });

  test("empty-string override falls through to auto-detect", () => {
    expect(resolveBackend(null, "")).toBe("grep");
  });
});

describe("buildSearchArgs — ripgrep backend", () => {
  const base: GrepParams = { pattern: "needle" };

  test("default flags + -- guard + path last", () => {
    const args = buildSearchArgs("rg", base, "/proj");
    expect(args).toEqual([
      "--line-number",
      "--no-heading",
      "--color=never",
      "--with-filename",
      "-i", // caseSensitive absent → insensitive (preserves prior behaviour)
      "--max-count=100",
      "--",
      "needle",
      "/proj",
    ]);
  });

  test("caseSensitive:true omits -i", () => {
    const args = buildSearchArgs("rg", { ...base, caseSensitive: true }, "/proj");
    expect(args).not.toContain("-i");
  });

  test("caseSensitive:false includes -i", () => {
    const args = buildSearchArgs("rg", { ...base, caseSensitive: false }, "/proj");
    expect(args).toContain("-i");
  });

  test("contextLines clamps to 5", () => {
    const args = buildSearchArgs("rg", { ...base, contextLines: 99 }, "/proj");
    expect(args).toContain("-C5");
  });

  test("negative contextLines → no -C flag", () => {
    const args = buildSearchArgs("rg", { ...base, contextLines: -3 }, "/proj");
    expect(args.some((a) => a.startsWith("-C"))).toBe(false);
  });

  test("include glob → -g <glob> as separate args", () => {
    const args = buildSearchArgs("rg", { ...base, include: "*.ts" }, "/proj");
    const i = args.indexOf("-g");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("*.ts");
  });

  test("noIgnore adds --no-ignore", () => {
    const args = buildSearchArgs("rg", { ...base, noIgnore: true }, "/proj");
    expect(args).toContain("--no-ignore");
  });

  test("without noIgnore, --no-ignore is absent (gitignore respected)", () => {
    const args = buildSearchArgs("rg", base, "/proj");
    expect(args).not.toContain("--no-ignore");
  });

  test("explicit maxResults is honoured", () => {
    const args = buildSearchArgs("rg", { ...base, maxResults: 7 }, "/proj");
    expect(args).toContain("--max-count=7");
  });

  test("pattern beginning with - is shielded by --", () => {
    const args = buildSearchArgs("rg", { pattern: "-v" }, "/proj");
    const dd = args.indexOf("--");
    expect(dd).toBeGreaterThanOrEqual(0);
    expect(args[dd + 1]).toBe("-v");
    expect(args[dd + 2]).toBe("/proj");
  });
});

describe("buildSearchArgs — GNU grep fallback", () => {
  const base: GrepParams = { pattern: "needle" };

  test("default flags include -I, recursive, exclude-dir set, -e guard", () => {
    const args = buildSearchArgs("grep", base, "/proj");
    expect(args.slice(0, 4)).toEqual(["-rn", "--color=never", "-I", "-i"]);
    for (const d of [
      ".git",
      "node_modules",
      "dist",
      "build",
      "coverage",
      ".ezcorp",
      ".svelte-kit",
      ".next",
    ]) {
      expect(args).toContain(`--exclude-dir=${d}`);
    }
    expect(args).toContain("-m100");
    const e = args.indexOf("-e");
    expect(e).toBeGreaterThanOrEqual(0);
    expect(args[e + 1]).toBe("needle");
    expect(args[e + 2]).toBe("/proj");
  });

  test("caseSensitive:true omits -i", () => {
    const args = buildSearchArgs("grep", { ...base, caseSensitive: true }, "/proj");
    expect(args).not.toContain("-i");
  });

  test("include glob → --include= form", () => {
    const args = buildSearchArgs("grep", { ...base, include: "*.svelte" }, "/proj");
    expect(args).toContain("--include=*.svelte");
  });

  test("noIgnore drops all --exclude-dir flags", () => {
    const args = buildSearchArgs("grep", { ...base, noIgnore: true }, "/proj");
    expect(args.some((a) => a.startsWith("--exclude-dir="))).toBe(false);
  });

  test("contextLines clamps to 5", () => {
    const args = buildSearchArgs("grep", { ...base, contextLines: 12 }, "/proj");
    expect(args).toContain("-C5");
  });

  test("explicit maxResults is honoured", () => {
    const args = buildSearchArgs("grep", { ...base, maxResults: 3 }, "/proj");
    expect(args).toContain("-m3");
  });

  test("pattern beginning with - is shielded by -e", () => {
    const args = buildSearchArgs("grep", { pattern: "--foo" }, "/proj");
    const e = args.indexOf("-e");
    expect(args[e + 1]).toBe("--foo");
  });
});
