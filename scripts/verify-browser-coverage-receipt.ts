#!/usr/bin/env bun
/** Fail closed unless browser LCOV was remapped from this exact checkout. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { REPO_ROOT } from "./coverage-config.ts";
import { coverageToLcovFromBuild, type RawCoverage } from "./browser-coverage-to-lcov.ts";
import { assertBrowserCanonicalSources, assertCompleteRouteInventory } from "./browser-route-coverage-manifest.ts";

const [rawPath, lcovPath] = process.argv.slice(2);
if (!rawPath || !lcovPath) throw new Error("usage: verify-browser-coverage-receipt.ts <raw.json> <lcov.info>");
const raw = await Bun.file(rawPath).json() as RawCoverage;
const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim();
if (!/^[0-9a-f]{40}$/.test(raw.sourceRevision ?? "") || raw.sourceRevision !== head) {
  throw new Error("browser coverage receipt sourceRevision does not match HEAD");
}
const manifest = await Bun.file(resolve(REPO_ROOT, "web/build/client/manifest.json")).arrayBuffer();
const buildId = createHash("sha256").update(Buffer.from(manifest)).digest("hex");
if (raw.buildId !== buildId) throw new Error("browser coverage receipt buildId does not match current mapped build");
assertCompleteRouteInventory(raw.expectedRouteFiles ?? []);
assertBrowserCanonicalSources(raw.expectedFiles ?? []);
const regenerated = await coverageToLcovFromBuild(raw);
const supplied = await Bun.file(lcovPath).text();
if (regenerated !== supplied) throw new Error("browser LCOV does not match raw CDP conversion");
console.log(`verified browser coverage receipt for ${head}`);
