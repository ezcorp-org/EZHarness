/**
 * E2E — the deterministic extension-build acceptance gate.
 *
 * Required real e2e for the loop-fix (spec §Phase E). Driving the
 * extension-author UI flow end-to-end in Playwright is impractical
 * (LLM-mediated tool calls, draft lifecycle), so per the spec this
 * asserts the gate at the CLI surface — which is a TRUE end-to-end of
 * the deterministic pipeline: a real `bun run index.ts` process, a real
 * sandboxed extension subprocess round-trip, and a real exit code.
 *
 * Proves the two loop-fix invariants on the canonical fixture (the
 * exact extension the looping incident built):
 *
 *   1. `ext verify ./harness-smoke-test --json` ⇒ exit 0, pass:true,
 *      every step ok. (deterministic acceptance — root-cause #2)
 *   2. A draft with a FAILING smokeTest ⇒ exit 1, pass:false. The gate
 *      cannot be satisfied by a hallucinated "use the ping tool".
 *   3. `ext install` twice ⇒ 2nd run is idempotent (no raw dup-insert
 *      SQL error; "refreshed" path). (root-cause #1)
 */

import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  cpSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// web/e2e/<file> → repo root is two levels up from this file's dir.
// (`__dirname` is not defined in this ESM test module.)
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const HARNESS_DIR = join(
  REPO_ROOT,
  "docs/extensions/examples/harness-smoke-test",
);

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bun", ["run", "index.ts", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PI_SKIP_INIT: "1", ...env },
  });
}

test.describe("deterministic extension-build gate (CLI surface)", () => {
  test("canonical harness-smoke-test ⇒ ext verify --json exit 0, pass:true", () => {
    const r = runCli([
      "ext",
      "verify",
      "./docs/extensions/examples/harness-smoke-test",
      "--json",
    ]);
    expect(r.status).toBe(0);
    // The JSON is the last brace-balanced block on stdout (logger
    // warnings may precede it).
    const jsonStart = r.stdout.indexOf("{");
    const parsed = JSON.parse(r.stdout.slice(jsonStart));
    expect(parsed.pass).toBe(true);
    expect(
      parsed.steps.map((s: { name: string }) => s.name),
    ).toEqual([
      "load-manifest",
      "validate-manifest",
      "smoke-test-present",
      "smoke-test-roundtrip",
    ]);
    expect(parsed.steps.every((s: { ok: boolean }) => s.ok)).toBe(true);
  });

  test("draft with a FAILING smokeTest ⇒ ext verify exit 1, pass:false", () => {
    // Copy the canonical fixture and break ONLY the smokeTest contract
    // (expect text the ping tool will never emit). The gate must fail
    // deterministically — it cannot be talked into a pass.
    const dir = mkdtempSync(join(tmpdir(), "harness-fail-"));
    try {
      cpSync(HARNESS_DIR, dir, { recursive: true });
      // Rewrite ezcorp.config.ts: fix the relative `defineExtension`
      // import (the copy is outside the repo tree) + break the expect.
      const cfg = join(dir, "ezcorp.config.ts");
      const src = readFileSync(cfg, "utf8");
      const patched = src
        .replace(
          /from "\.\.\/\.\.\/\.\.\/\.\.\/src\/extensions\/sdk\/define"/,
          `from "${join(REPO_ROOT, "src/extensions/sdk/define")}"`,
        )
        .replace(
          /textIncludes: '"ok": true'/,
          "textIncludes: 'this string is never emitted by ping'",
        );
      writeFileSync(cfg, patched);

      const r = runCli(["ext", "verify", dir, "--json"]);
      expect(r.status).toBe(1);
      const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
      expect(parsed.pass).toBe(false);
      expect(
        parsed.steps.some(
          (s: { name: string; ok: boolean }) =>
            s.name === "smoke-test-roundtrip" && s.ok === false,
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ext install twice ⇒ 2nd run is idempotent (no raw dup-insert SQL)", () => {
    // Isolated PERSISTENT PGlite dir (shared across the two separate
    // CLI processes — `:memory:` would not persist the first row, so
    // the 2nd run couldn't hit the idempotent path). Never touches the
    // dev DB. The 2nd install MUST take the "refreshed" path, NOT a
    // raw `Failed query: insert into "extensions"` unique error — the
    // exact string the looping agent rationalized as "expected".
    const dbDir = mkdtempSync(join(tmpdir(), "harness-idem-db-"));
    try {
      const env = { EZCORP_DB_PATH: join(dbDir, "db") };
      const first = runCli(
        ["ext", "install", "./docs/extensions/examples/harness-smoke-test", "--yes"],
        env,
      );
      const second = runCli(
        ["ext", "install", "./docs/extensions/examples/harness-smoke-test", "--yes"],
        env,
      );

      const secondOut = `${second.stdout}\n${second.stderr}`;
      expect(secondOut).not.toMatch(
        /Failed query|insert into "extensions"|duplicate key value/i,
      );
      // 2nd run must take the idempotent refresh path + exit clean.
      expect(second.status).toBe(0);
      expect(secondOut).toContain(
        "already installed from same source — refreshed",
      );
      expect(first.status).toBe(0);
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
