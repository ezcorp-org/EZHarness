import { expect, test } from "bun:test";
import { LOCAL_PRODUCTION_PROOFS, PRODUCTION_PROOF_BOUND_TESTS, PRODUCTION_PROOF_SHARDS, proofBoundTests, selectedProductionProofs } from "../../scripts/production-proof-plan.ts";

test("production proof plan has one exact CI partition and preserves local order", () => {
  expect(PRODUCTION_PROOF_SHARDS.map(({ shard, web, proofs }) => ({ shard, web, proofs: proofs.map(({ name }) => name) }))).toEqual([
    { shard: "recovery", web: false, proofs: ["runtime", "historical-upgrade"] },
    { shard: "content", web: true, proofs: ["file-organizer", "legacy-adoption"] },
    { shard: "delivery", web: false, proofs: ["delivery", "revocation", "embeddings"] },
    { shard: "resources", web: false, proofs: ["runtime-resources"] },
    { shard: "namespace", web: false, proofs: ["namespace", "preview-isolation"] },
  ]);
  expect(LOCAL_PRODUCTION_PROOFS).toEqual(["file-organizer", "embeddings", "runtime", "delivery", "revocation", "runtime-resources", "historical-upgrade", "legacy-adoption", "preview-isolation"]);
  expect(selectedProductionProofs("content")).toEqual(["file-organizer", "legacy-adoption"]);
});

test("production proof selection rejects unknown and duplicate shard input", () => {
  expect(() => selectedProductionProofs("unknown")).toThrow("unknown production proof shard");
  expect(() => selectedProductionProofs("content,content")).toThrow("exactly one");
});

const PREVIEW_ISOLATION_TESTS = ["src/__tests__/preview-uid-keystone.docker.test.ts", "src/__tests__/preview-dynamic-e2e.docker.test.ts"];

test("the preview isolation proof owns the two in-image preview test files, and only it binds tests", () => {
  expect(proofBoundTests("preview-isolation")).toEqual(PREVIEW_ISOLATION_TESTS);
  expect(PRODUCTION_PROOF_BOUND_TESTS).toEqual(PREVIEW_ISOLATION_TESTS);
  expect(() => proofBoundTests("namespace")).toThrow("production proof namespace binds no test file");
  expect(() => proofBoundTests("unknown")).toThrow("production proof unknown binds no test file");
});

test("the command line prints a proof's bound test files for the proof script", () => {
  const plan = Bun.spawnSync([process.execPath, "scripts/production-proof-plan.ts", "bound-tests", "preview-isolation"], { cwd: `${import.meta.dir}/../..` });
  expect(plan.exitCode).toBe(0);
  expect(plan.stdout.toString().trim().split("\n")).toEqual(PREVIEW_ISOLATION_TESTS);
});
