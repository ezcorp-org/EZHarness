import { expect, test } from "bun:test";
import { LOCAL_PRODUCTION_PROOFS, PRODUCTION_PROOF_SHARDS, selectedProductionProofs } from "../../scripts/production-proof-plan.ts";

test("production proof plan has one exact CI partition and preserves local order", () => {
  expect(PRODUCTION_PROOF_SHARDS.map(({ shard, web, proofs }) => ({ shard, web, proofs: proofs.map(({ name }) => name) }))).toEqual([
    { shard: "recovery", web: false, proofs: ["runtime", "historical-upgrade"] },
    { shard: "content", web: true, proofs: ["file-organizer", "legacy-adoption"] },
    { shard: "delivery", web: false, proofs: ["delivery", "revocation", "embeddings"] },
    { shard: "resources", web: false, proofs: ["runtime-resources"] },
    { shard: "namespace", web: false, proofs: ["namespace"] },
  ]);
  expect(LOCAL_PRODUCTION_PROOFS).toEqual(["file-organizer", "embeddings", "runtime", "delivery", "revocation", "runtime-resources", "historical-upgrade", "legacy-adoption"]);
  expect(selectedProductionProofs("content")).toEqual(["file-organizer", "legacy-adoption"]);
});

test("production proof selection rejects unknown and duplicate shard input", () => {
  expect(() => selectedProductionProofs("unknown")).toThrow("unknown production proof shard");
  expect(() => selectedProductionProofs("content,content")).toThrow("exactly one");
});
