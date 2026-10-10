import type { CompiledPartition, FactoryNode } from "@ezcorp/factory-sdk/types";
import { firstValidationIssue, validateCompiledExecutionManifest, validateCompiledPartitionArtifact } from "@ezcorp/factory-sdk/validation";
import type { KernelFactoryPlan } from "@ezcorp/factory-sdk/kernel-types";
import type { FactoryActivities, FactoryIdentity, FactoryPartitionSource } from "./contracts.ts";
import { validatePartitionSource } from "./validation.ts";

type PartitionReader = Pick<FactoryActivities, "loadExecutionManifest" | "loadPartitionArtifact">;

function requireValid(result: ReturnType<typeof validateCompiledExecutionManifest>, label: string): void {
  if (result.ok) return;
  const issue = firstValidationIssue(result);
  throw new Error(`${label} ${issue?.code ?? "INVALID"}: ${issue?.message ?? "is invalid"}`);
}

function localSuccessors(nodes: readonly FactoryNode[]): Readonly<Record<string, readonly string[]>> {
  const localIds = new Set(nodes.map(({ id }) => id));
  const successors = Object.create(null) as Record<string, string[]>;
  for (const { id } of nodes) successors[id] = [];
  for (const node of nodes) {
    const predecessors = node.kind === "join" ? node.predecessors : node.dependsOn ?? [];
    for (const predecessor of predecessors) if (localIds.has(predecessor)) successors[predecessor]!.push(node.id);
  }
  for (const values of Object.values(successors)) values.sort();
  return successors;
}

/** Load and validate only the two bounded records needed by one interpreter. */
export async function loadPartitionKernelPlan(
  identity: FactoryIdentity,
  source: FactoryPartitionSource,
  reader: PartitionReader,
): Promise<KernelFactoryPlan> {
  validatePartitionSource(source);
  const [manifest, artifact] = await Promise.all([
    reader.loadExecutionManifest({ ...identity, definitionDigest: source.definitionDigest, manifest: source.executionManifest }),
    reader.loadPartitionArtifact({ ...identity, definitionDigest: source.definitionDigest, partition: source.partition }),
  ]);
  requireValid(validateCompiledExecutionManifest(manifest, source.definitionDigest, source.executionManifest), "factory execution manifest");
  requireValid(validateCompiledPartitionArtifact(artifact, source.definitionDigest), "factory partition artifact");
  if (artifact.id !== source.partition.partitionId) throw new Error("factory partition artifact ID does not match its immutable reference");
  const partition: CompiledPartition = {
    id: artifact.id,
    nodeIds: artifact.nodeIds,
    dependsOn: artifact.dependsOn,
    inbound: artifact.inbound,
    outbound: artifact.outbound,
    encodedBytes: source.partition.encodedBytes,
    digest: source.partition.digest,
  };
  return {
    digest: source.definitionDigest,
    definition: {
      inputPorts: manifest.inputPorts,
      outputPorts: manifest.outputPorts,
      bounds: manifest.bounds,
      graph: { nodes: artifact.nodes, outputs: manifest.outputs },
    },
    indexes: { successors: localSuccessors(artifact.nodes) },
    partitions: [partition],
  };
}
