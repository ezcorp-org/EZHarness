#!/usr/bin/env bun
/** Fail closed unless browser LCOV was remapped from this exact checkout. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { REPO_ROOT } from "./coverage-config.ts";
import { coverageToLcovFromBuild, type RawCoverage } from "./browser-coverage-to-lcov.ts";
import { assertBrowserCanonicalSources, assertCompleteRouteInventory } from "./browser-route-coverage-manifest.ts";

export type BrowserCoverageReceiptVerifier = {
  repoRoot: string;
  currentHead(): string;
  readManifest(): Promise<ArrayBuffer>;
  remap(raw: RawCoverage): Promise<string>;
  assertRouteInventory(expected: readonly string[]): void;
  assertCanonicalSources(expected: readonly string[]): void;
};

/**
 * Production uses the real checkout. Tests inject a small fixture root plus a
 * controlled remapper, while exercising the same identity checks and order.
 */
export function browserCoverageReceiptVerifierForRoot(
  repoRoot: string,
  overrides: Partial<Omit<BrowserCoverageReceiptVerifier, "repoRoot">> = {},
): BrowserCoverageReceiptVerifier {
  return {
    repoRoot,
    currentHead: () => Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim(),
    readManifest: () => Bun.file(resolve(repoRoot, "web/build/client/manifest.json")).arrayBuffer(),
    remap: coverageToLcovFromBuild,
    assertRouteInventory: assertCompleteRouteInventory,
    assertCanonicalSources: assertBrowserCanonicalSources,
    ...overrides,
  };
}

/** Verify a browser receipt against one immutable checkout and mapped build. */
export async function verifyBrowserCoverageReceipt(
  rawPath: string,
  lcovPath: string,
  verifier: BrowserCoverageReceiptVerifier = browserCoverageReceiptVerifierForRoot(REPO_ROOT),
): Promise<string> {
  const raw = await Bun.file(rawPath).json() as RawCoverage;
  const head = verifier.currentHead();
  if (!/^[0-9a-f]{40}$/.test(raw.sourceRevision ?? "") || raw.sourceRevision !== head) {
    throw new Error("browser coverage receipt sourceRevision does not match HEAD");
  }
  const manifest = await verifier.readManifest();
  const buildId = createHash("sha256").update(Buffer.from(manifest)).digest("hex");
  if (raw.buildId !== buildId) throw new Error("browser coverage receipt buildId does not match current mapped build");
  verifier.assertRouteInventory(raw.expectedRouteFiles ?? []);
  verifier.assertCanonicalSources(raw.expectedFiles ?? []);
  const regenerated = await verifier.remap(raw);
  const supplied = await Bun.file(lcovPath).text();
  if (regenerated !== supplied) throw new Error("browser LCOV does not match raw CDP conversion");
  return head;
}

if (import.meta.main) {
  const [rawPath, lcovPath] = process.argv.slice(2);
  if (!rawPath || !lcovPath) throw new Error("usage: verify-browser-coverage-receipt.ts <raw.json> <lcov.info>");
  console.log(`verified browser coverage receipt for ${await verifyBrowserCoverageReceipt(rawPath, lcovPath)}`);
}
