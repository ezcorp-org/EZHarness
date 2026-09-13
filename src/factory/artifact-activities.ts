import type { FactoryActivities } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import type { FactoryDefinitionArtifacts } from "./definition-artifacts";
import type { FactoryTransitionArtifacts, LoadedTransitionManifest, LoadedTransitionPage } from "./transition-artifacts";

/** Added to FactoryActivities by the continuation-reader contract commit. */
export interface FactoryTransitionReadActivities {
  loadTransitionManifest(request: Parameters<FactoryTransitionArtifacts["loadTransitionManifest"]>[0]): Promise<LoadedTransitionManifest>;
  loadTransitionPage(request: Parameters<FactoryTransitionArtifacts["loadTransitionPage"]>[0]): Promise<LoadedTransitionPage>;
}

/** Storage-backed half of the Node worker activity contract. Effects stay at the gateway. */
export function createFactoryArtifactActivities(definitions: FactoryDefinitionArtifacts, transitions: FactoryTransitionArtifacts): Pick<FactoryActivities, "stageTransitionPage" | "finalizeTransitionArtifact" | "recordTransition" | "loadManifestPage" | "loadDefinitionPage" | "loadExecutionManifest" | "loadPartitionArtifact"> & FactoryTransitionReadActivities {
  return {
    stageTransitionPage: request => transitions.stageTransitionPage(request),
    finalizeTransitionArtifact: request => transitions.finalizeTransitionArtifact(request),
    recordTransition: record => transitions.recordTransition(record),
    loadManifestPage: request => definitions.loadManifestPage(request, request.definition, request.page),
    loadDefinitionPage: request => definitions.loadDefinitionPage(request, request.definitionDigest, request.page),
    loadExecutionManifest: request => definitions.loadExecutionManifest(request, request.definitionDigest, request.manifest),
    loadPartitionArtifact: request => definitions.loadPartition(request, request.definitionDigest, request.partition),
    loadTransitionManifest: request => transitions.loadTransitionManifest(request),
    loadTransitionPage: request => transitions.loadTransitionPage(request),
  };
}
