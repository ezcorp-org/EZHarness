import type { FactoryAvailability, FactoryDefinition } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../db/migrations/types";
import type { BlobStore } from "../extensions/v4/types";
import type { BoundBlobStore } from "./encryption";
import { assertFactoryIdentity } from "./records";
import { factoryDefinitionRequirements, FactoryDefinitions, type FactoryDraftMetadata } from "./definitions";
import { configureProjectCreationParticipant } from "../db/queries/projects";
import { FactoryGrants } from "./grants";
import { FactoryRunLifecycle, type FactoryRunLifecycleOptions } from "./run-lifecycle";
import { FactoryArtifacts } from "./artifacts";
import { FactoryDefinitionArtifacts } from "./definition-artifacts";
import { FactoryServiceCredentials } from "./service-credentials";

export interface FactoryDefinitionAvailability {
  readonly availability: FactoryAvailability;
  readonly availabilityReason?: string;
}

export interface FactoryApplication {
  readonly tenantId: string;
  readonly definitions: FactoryDefinitions;
  readonly runs: FactoryRunLifecycle;
  readonly grants: FactoryGrants;
  readonly credentials: FactoryServiceCredentials;
  readonly availableResourceClasses: ReadonlySet<string>;
}

export interface FactoryApplicationOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  readonly blobs: BlobStore | BoundBlobStore;
  readonly runOptions: Omit<FactoryRunLifecycleOptions, "definitions" | "grants" | "stageDefinitionInTransaction">;
  readonly grants?: FactoryGrants;
  readonly availableResourceClasses: Iterable<string>;
}

let configuredApplication: FactoryApplication | null = null;

function immutableSet<T>(values: Iterable<T>): ReadonlySet<T> {
  const stored = new Set(values);
  const view: ReadonlySet<T> = {
    get size() { return stored.size; },
    has: value => stored.has(value),
    entries: () => stored.entries(),
    keys: () => stored.keys(),
    values: () => stored.values(),
    forEach(callback, thisArg) { stored.forEach(value => { callback.call(thisArg, value, value, view); }); },
    [Symbol.iterator]: () => stored[Symbol.iterator](),
    union: other => stored.union(other),
    intersection: other => stored.intersection(other),
    difference: other => stored.difference(other),
    symmetricDifference: other => stored.symmetricDifference(other),
    isSubsetOf: other => stored.isSubsetOf(other),
    isSupersetOf: other => stored.isSupersetOf(other),
    isDisjointFrom: other => stored.isDisjointFrom(other),
  };
  return Object.freeze(view);
}

/** Compose the HTTP-facing stores only from already-probed, trusted services. */
export function createFactoryApplication(options: FactoryApplicationOptions): FactoryApplication {
  assertFactoryIdentity(options.tenantId);
  const grants = options.grants ?? new FactoryGrants(options.database, options.tenantId);
  if (grants.tenantId !== options.tenantId) throw new Error("factory_scope_mismatch");
  const resources = new Set<string>();
  for (const resourceClass of options.availableResourceClasses) {
    assertFactoryIdentity(resourceClass);
    resources.add(resourceClass);
  }
  const definitions = new FactoryDefinitions(options.database, options.tenantId, grants, options.blobs);
  const credentials = new FactoryServiceCredentials(options.database, options.tenantId, grants);
  const artifacts = new FactoryDefinitionArtifacts(new FactoryArtifacts(options.database, options.blobs, options.tenantId));
  const runs = new FactoryRunLifecycle(options.database, options.tenantId, {
    ...options.runOptions, definitions, grants,
    stageDefinitionInTransaction: (transaction, compiled, identity) => artifacts.stageDefinitionInTransaction(transaction, compiled, identity),
  });
  return Object.freeze({
    tenantId: options.tenantId,
    grants,
    credentials,
    definitions,
    runs,
    availableResourceClasses: immutableSet(resources),
  });
}

/** Root boot configures this only after every required service probe succeeds. */
export function configureFactoryApplication(application: FactoryApplication | null): void {
  configuredApplication = application;
  configureProjectCreationParticipant(application ? (transaction, projectId, ownerId) => application.grants.initializeProjectInTransaction(transaction, projectId, ownerId) : null);
}

export function getFactoryApplication(): FactoryApplication | null {
  return configuredApplication;
}

/** Compile once, then inspect the compiler's deep node index for resource needs. */
export function definitionAvailability(
  source: FactoryDefinition,
  availableResourceClasses: ReadonlySet<string>,
): FactoryDefinitionAvailability {
  return requirementsAvailability(factoryDefinitionRequirements(source), availableResourceClasses);
}

export function draftAvailability(
  draft: Pick<FactoryDraftMetadata, "requiredResourceClasses" | "requirementsComplete" | "validationDiagnosticCount">,
  availableResourceClasses: ReadonlySet<string>,
): FactoryDefinitionAvailability {
  return requirementsAvailability(draft, availableResourceClasses);
}

function requirementsAvailability(
  requirements: Pick<FactoryDraftMetadata, "requiredResourceClasses" | "requirementsComplete" | "validationDiagnosticCount">,
  availableResourceClasses: ReadonlySet<string>,
): FactoryDefinitionAvailability {
  if (requirements.validationDiagnosticCount > 0) {
    return {
      availability: "unavailable",
      availabilityReason: `Definition validation failed with ${requirements.validationDiagnosticCount} diagnostic${requirements.validationDiagnosticCount === 1 ? "" : "s"}.`,
    };
  }
  if (!requirements.requirementsComplete) return { availability: "unavailable", availabilityReason: "Definition resource requirements exceed supported limits." };
  const missing = requirements.requiredResourceClasses.filter((resourceClass) => !availableResourceClasses.has(resourceClass));
  return missing.length === 0
    ? { availability: "available" }
    : { availability: "unavailable", availabilityReason: `Unavailable resource classes: ${missing.join(", ")}.` };
}
