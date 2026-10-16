#!/usr/bin/env bun
/** The single production-proof partition used by CI and the local suite. */
/**
 * `boundTests`: test files only this proof's lane can run (they need the
 * candidate image). The proof script reads them from here (`bound-tests`), and
 * the hosted shard selection subtracts them (scripts/check-factory-lanes.ts
 * --bound-tests), so no shard selects a file that would only skip there.
 */
export type ProductionProof = { name: string; localOrder?: number; boundTests?: readonly string[] };
export type ProductionProofShard = {
  shard: string;
  web: boolean;
  proofs: readonly ProductionProof[];
};

export const PRODUCTION_PROOF_SHARDS: readonly ProductionProofShard[] = [
  { shard: "recovery", web: false, proofs: [{ name: "runtime", localOrder: 3 }, { name: "historical-upgrade", localOrder: 7 }] },
  { shard: "content", web: true, proofs: [{ name: "file-organizer", localOrder: 1 }, { name: "legacy-adoption", localOrder: 8 }] },
  { shard: "delivery", web: false, proofs: [{ name: "delivery", localOrder: 4 }, { name: "revocation", localOrder: 5 }, { name: "embeddings", localOrder: 2 }] },
  { shard: "resources", web: false, proofs: [{ name: "runtime-resources", localOrder: 6 }] },
  {
    shard: "namespace",
    web: false,
    proofs: [
      { name: "namespace" },
      {
        name: "preview-isolation",
        localOrder: 9,
        boundTests: ["src/__tests__/preview-uid-keystone.docker.test.ts", "src/__tests__/preview-dynamic-e2e.docker.test.ts"],
      },
    ],
  },
];

export const LOCAL_PRODUCTION_PROOFS = PRODUCTION_PROOF_SHARDS
  .flatMap(({ proofs }) => proofs)
  .filter((proof): proof is ProductionProof & { localOrder: number } => proof.localOrder !== undefined)
  .toSorted((left, right) => left.localOrder - right.localOrder)
  .map(({ name }) => name);

/** Every test file a production proof binds to its lane. */
export const PRODUCTION_PROOF_BOUND_TESTS: readonly string[] = PRODUCTION_PROOF_SHARDS.flatMap(({ proofs }) => proofs.flatMap(({ boundTests }) => boundTests ?? []));

/** The test files one proof runs in the candidate image. */
export function proofBoundTests(name: string): readonly string[] {
  const files = PRODUCTION_PROOF_SHARDS.flatMap(({ proofs }) => proofs).find((proof) => proof.name === name)?.boundTests ?? [];
  if (files.length === 0) throw new Error(`production proof ${name} binds no test file`);
  return files;
}

export function shardForName(name: string): ProductionProofShard {
  const shard = PRODUCTION_PROOF_SHARDS.find((candidate) => candidate.shard === name);
  if (!shard) throw new Error(`unknown production proof shard: ${name}`);
  return shard;
}

export function selectedProductionProofs(selection = process.env.EZ_SHIPPING_SHARD ?? ""): readonly string[] {
  if (selection === "") return LOCAL_PRODUCTION_PROOFS;
  if (selection.includes(",")) throw new Error("select exactly one production proof shard");
  return shardForName(selection).proofs.map(({ name }) => name);
}

function usage(): never {
  throw new Error("usage: production-proof-plan.ts matrix | select [SHARD] | bound-tests PROOF");
}

if (import.meta.main) {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "matrix" && arguments_.length === 0) {
    console.log(JSON.stringify({ include: PRODUCTION_PROOF_SHARDS.map(({ shard, web }) => ({ shard, web })) }));
  } else if (command === "select" && arguments_.length <= 1) {
    for (const proof of selectedProductionProofs(arguments_[0])) console.log(proof);
  } else if (command === "bound-tests" && arguments_.length === 1) {
    for (const file of proofBoundTests(arguments_[0]!)) console.log(file);
  } else {
    usage();
  }
}
