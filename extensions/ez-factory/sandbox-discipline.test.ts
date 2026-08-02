/**
 * Mechanical proof that no file under `extensions/ez-factory/**` reaches
 * for a filesystem or process primitive directly.
 *
 * ── Why this is a grep and not a convention ────────────────────────────
 *
 * `src/extensions/runtime/sandbox-preload.ts` poisons `node:fs`,
 * `fs/promises`, `child_process`, `Bun.file`, `Bun.write`, `Bun.glob`,
 * `Bun.spawn` and `Bun.$` at load, so a direct call fails at run time
 * anyway. But it fails INSIDE the subprocess, as an opaque "Transport
 * closed" or a permission-shaped error three layers from the cause, and
 * only on the code path that happens to run. This test fails in CI, on
 * the diff that introduced it, naming the file and the line.
 *
 * It also protects a property the poison does not: the host mediates
 * every fs call so it can REALPATH before the PDP authorizes, which is
 * what closes the TOCTOU window a subprocess-side `Bun.file()` would
 * reopen. That is an architectural guarantee, and this is its guard.
 *
 * `Bun.Glob` (capital G) is deliberately NOT forbidden: `new
 * Bun.Glob(p).match(s)` is pure string matching over a path the host
 * already returned, and the preload leaves it alone. So the patterns
 * below are case-sensitive on purpose, and a test asserts that
 * distinction rather than leaving it to be re-derived.
 *
 * ── A live core gap this file works around ─────────────────────────────
 *
 * The preload poisons `Bun.glob` — LOWERCASE. On Bun 1.3.14 that property
 * does not exist (`typeof Bun.glob === "undefined"`), so the denier is
 * installed on a name nothing can call. The real API is the `Bun.Glob`
 * CLASS, it is untouched, and `new Bun.Glob(p).scanSync({cwd})` performs
 * genuine directory enumeration — verified by running it, not by reading.
 * That is an fs read that never passes the host's realpath check, the
 * PDP, or the audit log.
 *
 * Nothing here uses it, and `Glob#scan` is in the forbidden list below so
 * nothing here ever will. But the gap belongs to
 * `src/extensions/runtime/sandbox-preload.ts`, not to this extension, and
 * this comment is the pointer for whoever closes it.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXT_DIR = join(import.meta.dir);

/** Every forbidden primitive, with the permission it would need. */
const FORBIDDEN: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "node:fs / fs / fs/promises import", pattern: /\bfrom\s+["'](?:node:)?fs(?:\/promises)?["']/ },
  { label: "require('fs')", pattern: /\brequire\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/ },
  { label: "node:child_process", pattern: /["'](?:node:)?child_process["']/ },
  { label: "Bun.file", pattern: /\bBun\.file\b/ },
  { label: "Bun.write", pattern: /\bBun\.write\b/ },
  { label: "Bun.glob", pattern: /\bBun\.glob\b/ },
  { label: "Bun.spawn", pattern: /\bBun\.spawn(?:Sync)?\b/ },
  { label: "Bun.$", pattern: /\bBun\.\$/ },
  // `Bun.Glob#scan` / `#scanSync` DO walk the filesystem, and the preload
  // does NOT block them (see the header note on the poisoned name). Using
  // one here would take an fs read outside the host's realpath + PDP +
  // audit path — the exact bypass the reverse-RPC exists to prevent. Only
  // `.match()` is legitimate.
  { label: "Glob#scan", pattern: /\.scan(?:Sync)?\s*\(/ },
];

/**
 * Remove comments so the scan sees CODE only.
 *
 * The invariant is about what executes, not about what a file explains.
 * Every module here documents the poison it is avoiding by naming it, and
 * a scanner that could not tell prose from a call would force those
 * explanations out of the tree — trading a real comment for a fake green.
 *
 * String literals are preserved so a `require("node:fs")` written as a
 * string is still caught, and `//` inside a string (a URL) does not start
 * a comment.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  while (i < source.length) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (c === "'") state = "single";
      else if (c === '"') state = "double";
      else if (c === "`") state = "template";
      out += c;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      // Keep newlines so reported line numbers stay accurate.
      if (c === "\n") out += c;
      i += 1;
      continue;
    }
    // Inside a string literal.
    if (c === "\\") {
      out += c + (next ?? "");
      i += 2;
      continue;
    }
    if (
      (state === "single" && c === "'") ||
      (state === "double" && c === '"') ||
      (state === "template" && c === "`")
    ) {
      state = "code";
    }
    out += c;
    i += 1;
  }
  return out;
}

function tsFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...tsFilesUnder(full));
    else if (name.endsWith(".ts")) found.push(full);
  }
  return found;
}

interface Violation {
  file: string;
  line: number;
  label: string;
  text: string;
}

function scan(files: string[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((text, index) => {
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(text)) {
          violations.push({ file: file.slice(EXT_DIR.length + 1), line: index + 1, label, text: text.trim() });
        }
      }
    });
  }
  return violations;
}

const files = tsFilesUnder(EXT_DIR);

describe("the scanner itself discriminates", () => {
  // Guards against the failure mode this whole file exists to avoid: a
  // scanner that finds nothing because it is broken, not because the tree
  // is clean.

  test("it finds every forbidden primitive in code", () => {
    const sample = [
      'import { readFileSync } from "node:fs";',
      'const cp = require("child_process");',
      "await Bun.file(p).text();",
      "await Bun.write(p, x);",
      "Bun.glob(p);",
      "Bun.spawn(argv);",
      "Bun.$`ls`;",
      "for (const f of new Bun.Glob(p).scanSync({ cwd })) use(f);",
    ].join("\n");
    const violations = scan([writeTemp(sample)]);
    expect(violations.map((v) => v.label).sort()).toEqual(
      [
        "Bun.$",
        "Bun.file",
        "Bun.glob",
        "Bun.spawn",
        "Bun.write",
        "Glob#scan",
        "node:child_process",
        "node:fs / fs / fs/promises import",
      ].sort(),
    );
  });

  test("it ignores the same tokens inside comments", () => {
    const sample = [
      "// Bun.file is poisoned; use fsRead.",
      "/* node:fs and Bun.spawn are denied by the preload. */",
      "/** Bun.glob → use fsList. */",
      "const ok = 1;",
    ].join("\n");
    expect(scan([writeTemp(sample)])).toEqual([]);
  });

  test("it does NOT ignore a token inside a string literal", () => {
    expect(scan([writeTemp('const m = require("node:fs");')])).toHaveLength(1);
  });

  test("stripComments keeps real code intact", () => {
    const stripped = stripComments('const url = "http://x"; // a comment\nconst y = 2;');
    expect(stripped).toContain('const url = "http://x";');
    expect(stripped).toContain("const y = 2;");
    expect(stripped).not.toContain("a comment");
  });

  test("it is scanning a non-trivial number of real files", () => {
    // Vacuous-pass guard: if the walker breaks, the sweep below passes
    // over an empty list and proves nothing.
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files.some((f) => f.endsWith("lib/tools/read-files.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("index.ts"))).toBe(true);
  });
});

describe("extensions/ez-factory/** touches no filesystem or process primitive", () => {
  test("zero node:fs, Bun.file, Bun.write, Bun.glob, Bun.spawn, Bun.$ or child_process", () => {
    // `sandbox-discipline.test.ts` is itself excluded: it must read the
    // tree to scan it, and it runs host-side in the bun pool, never in a
    // sandbox.
    const scanned = files.filter((f) => !f.endsWith("sandbox-discipline.test.ts"));
    expect(scan(scanned)).toEqual([]);
  });

  test("every fs call goes through the SDK's host-mediated helpers", () => {
    // The positive half: absence of the primitives would also be
    // satisfied by an extension that does no IO at all.
    const entry = readFileSync(join(EXT_DIR, "index.ts"), "utf8");
    for (const helper of ["fsList", "fsStat", "fsRead", "fsWrite", "fsMkdir", "fsExists"]) {
      expect(entry).toContain(helper);
    }
  });

  test("Bun.Glob is used for matching ONLY — never for scanning", () => {
    const readFiles = stripComments(
      readFileSync(join(EXT_DIR, "lib/tools/read-files.ts"), "utf8"),
    );
    expect(readFiles).toContain("new Bun.Glob(");
    expect(readFiles).toContain(".match(");
    // `.match()` is pure string matching; `.scan()` walks the filesystem
    // and the preload does not stop it. Enumeration goes through `fsList`.
    expect(/\.scan(?:Sync)?\s*\(/.test(readFiles)).toBe(false);
    expect(/\bBun\.glob\b/.test(readFiles)).toBe(false);
  });
});

/** Write a scratch source file the scanner can read. Under the OS temp
 *  dir, never inside the scanned tree. */
function writeTemp(source: string): string {
  const path = join(
    process.env.TMPDIR ?? "/tmp",
    `ez-factory-scan-${Math.random().toString(36).slice(2)}.ts`,
  );
  writeFileSync(path, source, "utf8");
  return path;
}
