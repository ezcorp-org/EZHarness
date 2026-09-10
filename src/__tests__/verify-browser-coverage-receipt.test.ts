import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBrowserCanonicalSources, assertCompleteRouteInventory } from "../../scripts/browser-route-coverage-manifest.ts";
import {
  browserCoverageReceiptVerifierForRoot,
  verifyBrowserCoverageReceipt,
} from "../../scripts/verify-browser-coverage-receipt.ts";

const REVISION = "a".repeat(40);
const ROUTE = "web/src/routes/+page.svelte";
const LCOV = `TN:ezcorp-browser-v8\nSF:/fixture/${ROUTE}\nDA:1,1\nend_of_record\n`;

function git(root: string, ...args: string[]): void {
  const process = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (process.exitCode !== 0) throw new Error(process.stderr.toString());
}

function fixture(): {
  root: string;
  rawPath: string;
  lcovPath: string;
  verifier: ReturnType<typeof browserCoverageReceiptVerifierForRoot>;
} {
  const root = mkdtempSync(join(tmpdir(), "browser-receipt-"));
  const manifest = "{\"app\":\"fixture\"}\n";
  const manifestPath = join(root, "web", "build", "client", "manifest.json");
  mkdirSync(join(root, "web", "build", "client"), { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "Browser receipt fixture");
  git(root, "config", "user.email", "browser-receipt@example.invalid");
  writeFileSync(join(root, ".gitignore"), "web/build/\nraw.json\nlcov.info\n");
  writeFileSync(join(root, "source.ts"), "export const source = true;\n");
  git(root, "add", ".gitignore", "source.ts");
  git(root, "commit", "-qm", "fixture");
  writeFileSync(manifestPath, manifest);
  const rawPath = join(root, "raw.json");
  const lcovPath = join(root, "lcov.info");
  writeFileSync(rawPath, JSON.stringify({
    result: [],
    sourceRevision: REVISION,
    buildId: createHash("sha256").update(manifest).digest("hex"),
    expectedRouteFiles: [ROUTE],
    expectedFiles: [],
  }));
  writeFileSync(lcovPath, LCOV);
  const verifier = browserCoverageReceiptVerifierForRoot(root, {
    remap: async () => LCOV,
    assertRouteInventory: (expected) => assertCompleteRouteInventory(expected, [ROUTE]),
    assertCanonicalSources: assertBrowserCanonicalSources,
    currentHead: () => REVISION,
  });
  return { root, rawPath, lcovPath, verifier };
}

function withFixture(check: (value: ReturnType<typeof fixture>) => Promise<void>): Promise<void> {
  const value = fixture();
  return check(value).finally(() => rmSync(value.root, { recursive: true, force: true }));
}

test("browser receipt verifier accepts only the exact fixture remap", async () => {
  await withFixture(async ({ rawPath, lcovPath, verifier }) => {
    await expect(verifyBrowserCoverageReceipt(rawPath, lcovPath, verifier)).resolves.toBe(REVISION);
  });
});

test("browser receipt verifier rejects a stale source revision", async () => {
  await withFixture(async ({ rawPath, lcovPath, verifier }) => {
    const raw = await Bun.file(rawPath).json() as Record<string, unknown>;
    raw.sourceRevision = "b".repeat(40);
    await Bun.write(rawPath, JSON.stringify(raw));
    await expect(verifyBrowserCoverageReceipt(rawPath, lcovPath, verifier)).rejects.toThrow("sourceRevision");
  });
});

test("browser receipt verifier rejects dirty source bytes at the matching revision", async () => {
  await withFixture(async ({ root, rawPath, lcovPath, verifier }) => {
    writeFileSync(join(root, "source.ts"), "export const source = false;\n");
    await expect(verifyBrowserCoverageReceipt(rawPath, lcovPath, verifier)).rejects.toThrow("clean Git worktree");
  });
});

test("browser receipt verifier rejects a build hash for another manifest", async () => {
  await withFixture(async ({ rawPath, lcovPath, verifier }) => {
    const raw = await Bun.file(rawPath).json() as Record<string, unknown>;
    raw.buildId = "0".repeat(64);
    await Bun.write(rawPath, JSON.stringify(raw));
    await expect(verifyBrowserCoverageReceipt(rawPath, lcovPath, verifier)).rejects.toThrow("buildId");
  });
});

test("browser receipt verifier rejects a missing route inventory", async () => {
  await withFixture(async ({ rawPath, lcovPath, verifier }) => {
    const raw = await Bun.file(rawPath).json() as Record<string, unknown>;
    raw.expectedRouteFiles = [];
    await Bun.write(rawPath, JSON.stringify(raw));
    await expect(verifyBrowserCoverageReceipt(rawPath, lcovPath, verifier)).rejects.toThrow("route inventory is incomplete");
  });
});

test("browser receipt verifier rejects a supplied LCOV changed after remapping", async () => {
  await withFixture(async ({ rawPath, lcovPath, verifier }) => {
    await Bun.write(lcovPath, LCOV.replace("DA:1,1", "DA:1,999"));
    await expect(verifyBrowserCoverageReceipt(rawPath, lcovPath, verifier)).rejects.toThrow("does not match raw CDP conversion");
  });
});
