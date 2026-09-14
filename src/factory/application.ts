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
import { FactoryArtifactAccess } from "./artifact-access";
import { FactoryInputArtifacts } from "./input-artifacts";
import { FactoryRunInputs } from "./run-inputs";
import { FactoryDefinitionArtifacts } from "./definition-artifacts";
import { FactoryServiceCredentials } from "./service-credentials";
import { FactoryExecutionJournal } from "./executions";
import { FactoryReleaseAuthorityStore } from "./release-authority";
import type { FactoryReleaseApplication } from "./release-application";
import type { FactoryAssuranceCommands } from "./assurance-commands";
import { FactoryTransitionArtifacts } from "./transition-artifacts";
import { FactoryTransitionAuthority } from "./transition-authority";
import { FactoryRunControls } from "./run-controls";

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
  readonly artifacts: FactoryArtifacts;
  readonly journal: FactoryExecutionJournal;
  readonly releaseAuthority: FactoryReleaseAuthorityStore;
  readonly releaseOperations?: FactoryReleaseApplication;
  readonly commandApprovals?: FactoryAssuranceCommands;
  readonly runControls?: FactoryRunControls;
  readonly availableResourceClasses: ReadonlySet<string>;
}

export interface FactoryApplicationOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  readonly blobs: BlobStore | BoundBlobStore;
  readonly runOptions: Omit<FactoryRunLifecycleOptions, "definitions" | "grants" | "stageDefinitionInTransaction" | "resolveParameters"> & Partial<Pick<FactoryRunLifecycleOptions, "resolveParameters">>;
  readonly grants?: FactoryGrants;
  readonly availableResourceClasses: Iterable<string>;
  readonly createReleaseOperations?: (context: Readonly<Pick<FactoryApplication, "tenantId" | "grants" | "runs" | "artifacts" | "journal" | "releaseAuthority">>) => FactoryReleaseApplication;
  readonly createCommandApprovals?: (context: Readonly<Pick<FactoryApplication, "tenantId" | "grants" | "runs" | "artifacts" | "journal" | "releaseAuthority" | "releaseOperations">>) => FactoryAssuranceCommands;
  readonly createRunControls?: (context: Readonly<Pick<FactoryApplication, "tenantId" | "definitions" | "grants" | "runs" | "artifacts"> & { readonly inputs: FactoryRunInputs; readonly transitions: FactoryTransitionArtifacts; readonly authority: FactoryTransitionAuthority }>) => FactoryRunControls;
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
  const artifacts = new FactoryArtifacts(options.database, options.blobs, options.tenantId);
  const definitionArtifacts = new FactoryDefinitionArtifacts(artifacts);
  const transitions = new FactoryTransitionArtifacts(artifacts);
  const inputs = new FactoryRunInputs(grants, new FactoryInputArtifacts(artifacts, new FactoryArtifactAccess(options.database, options.tenantId, grants, artifacts)));
  const runs = new FactoryRunLifecycle(options.database, options.tenantId, {
    ...options.runOptions, definitions, grants,
    resolveParameters: options.runOptions.resolveParameters ?? inputs.resolveInTransaction,
    stageDefinitionInTransaction: (transaction, compiled, identity) => definitionArtifacts.stageDefinitionInTransaction(transaction, compiled, identity),
  });
  const journal = new FactoryExecutionJournal(options.database, runs.authorizeAttemptInTransaction);
  const releaseAuthority = new FactoryReleaseAuthorityStore(options.database, options.tenantId, grants, runs, journal, artifacts);
  const transitionAuthority = new FactoryTransitionAuthority(options.tenantId, runs, transitions);
  // Repair and replan are part of the platform, so the production application composes them by
  // default; the seam stays for a test or a deployment that needs a different clock or store.
  const composeRunControls = options.createRunControls ?? (context => new FactoryRunControls(options.database, context.tenantId, context.grants, context.runs, context.authority, context.definitions, context.inputs));
  const runControls = composeRunControls(Object.freeze({ tenantId: options.tenantId, definitions, grants, runs, artifacts, inputs, transitions, authority: transitionAuthority }));
  if (runControls && runControls.tenantId !== options.tenantId) throw new Error("factory_scope_mismatch");
  if (runControls) Object.freeze(runControls);
  const releaseOperations = options.createReleaseOperations?.(Object.freeze({ tenantId: options.tenantId, grants, runs, artifacts, journal, releaseAuthority }));
  if (releaseOperations && releaseOperations.tenantId !== options.tenantId) throw new Error("factory_scope_mismatch");
  if (releaseOperations) Object.freeze(releaseOperations);
  const commandApprovals = options.createCommandApprovals?.(Object.freeze({ tenantId: options.tenantId, grants, runs, artifacts, journal, releaseAuthority, ...(releaseOperations ? { releaseOperations } : {}) }));
  if (commandApprovals && commandApprovals.tenantId !== options.tenantId) throw new Error("factory_scope_mismatch");
  if (commandApprovals) Object.freeze(commandApprovals);
  return Object.freeze({
    tenantId: options.tenantId,
    grants,
    credentials,
    definitions,
    runs,
    artifacts,
    journal,
    releaseAuthority,
    ...(runControls ? { runControls } : {}),
    ...(releaseOperations ? { releaseOperations } : {}),
    ...(commandApprovals ? { commandApprovals } : {}),
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
