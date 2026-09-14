import { sql } from "drizzle-orm";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { factoryArchivePublicationSet, type FactoryArchiveMemberSources, type FactoryArchivePublicationSet } from "./archive-writer";
import type { FactoryMaterialScope } from "./artifact-materials";
import { assertFactoryIdentity } from "./records";
import type { FactoryReleaseAuthorityStore } from "./release-authority";
import { FactoryReleaseError, type FactoryReleaseMaterial } from "./releases";

/**
 * The publication set's scope resolver, which W04a left to the adapter owners.
 *
 * The archive writer must read every publication member through W04's scoped reader, and that
 * reader authorizes by an attempt-scoped `FactoryMaterialScope`. A release operation carries no
 * attempt id — it names a tenant, project, run, node instance, and candidate generation. This is
 * the mapping between them, and the one rule that matters is where the attempt id comes from:
 *
 *   `factory_release_current_candidates.attempt_id`, written by
 *   `FactoryReleaseAuthorityStore.completeCurrentCandidateInTransaction` from the succeeded,
 *   stopped, non-uncertain attempt that `protected-command-provenance.ts` traced at the current
 *   generation.
 *
 * Never caller input, and never the release operation's own id. A caller that could name the
 * attempt could point the archive at another attempt's materials.
 */

export class FactoryReleasePublicationScopeError extends Error {
  constructor(readonly code: "factory_release_publication_scope_unknown" | "factory_release_publication_scope_unavailable") {
    super(code);
    this.name = "FactoryReleasePublicationScopeError";
  }
}

interface OperationIdentityRow {
  project_id: string;
  run_id: string;
  node_instance_id: string;
  candidate_generation: number | string;
  candidate_digest: string;
}

export interface FactoryReleasePublicationScopeOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  readonly authority: FactoryReleaseAuthorityStore;
}

/**
 * Resolves one release operation to the attempt scope its members were written under.
 *
 * The candidate artifact is named only when it exists as a sealed material for that exact attempt,
 * because that is the only form W04's scoped reader can return. When it does not, the resolver
 * refuses rather than guessing a scope: an unreadable member must leave publication pending, and
 * `FactoryArchiveWriter` already enforces that by never setting `archive_ready`.
 */
export class FactoryReleasePublicationScopes {
  readonly tenantId: string;
  private readonly database: TransactionalDb;
  private readonly authority: FactoryReleaseAuthorityStore;

  constructor(options: FactoryReleasePublicationScopeOptions) {
    assertFactoryIdentity(options.tenantId);
    if (options.authority.tenantId !== options.tenantId) throw new FactoryReleaseError("factory_release_scope");
    this.tenantId = options.tenantId;
    this.database = options.database;
    this.authority = options.authority;
  }

  async resolve(tenantId: string, operationId: string, _material: FactoryReleaseMaterial, signal?: AbortSignal): Promise<FactoryArchiveMemberSources> {
    signal?.throwIfAborted();
    if (tenantId !== this.tenantId) throw new FactoryReleaseError("factory_release_scope");
    assertFactoryIdentity(operationId);
    return this.database.transaction(async transaction => {
      const operation = rows<OperationIdentityRow>(await transaction.execute(sql`
        SELECT project_id,run_id,node_instance_id,candidate_generation,candidate_digest
        FROM factory_release_operations WHERE tenant_id=${this.tenantId} AND operation_id=${operationId} FOR SHARE`))[0];
      if (!operation) throw new FactoryReleasePublicationScopeError("factory_release_publication_scope_unknown");
      const verified = await this.authority.readVerifiedCandidateInTransaction(transaction, this.tenantId, {
        projectId: operation.project_id, runId: operation.run_id, nodeInstanceId: operation.node_instance_id,
        candidateGeneration: Number(operation.candidate_generation),
      });
      if (verified.candidateDigest !== operation.candidate_digest) throw new FactoryReleasePublicationScopeError("factory_release_publication_scope_unavailable");
      const scope = await this.materialScopeInTransaction(transaction, operation, verified.attemptId, verified.artifact);
      return Object.freeze({ scope, candidate: verified.artifact });
    });
  }

  /** The material row the verified attempt wrote for the candidate artifact, and nothing else. */
  private async materialScopeInTransaction(transaction: MigrationDb, operation: OperationIdentityRow, attemptId: string, artifact: FactoryArtifactReference): Promise<FactoryMaterialScope> {
    const material = rows<{ operation_id: string; digest: string }>(await transaction.execute(sql`
      SELECT operation_id,digest FROM factory_artifact_materials
      WHERE tenant_id=${this.tenantId} AND project_id=${operation.project_id} AND run_id=${operation.run_id}
        AND attempt_id=${attemptId} AND object_id=${artifact.artifactId} AND sealed=TRUE FOR SHARE`))[0];
    if (!material) throw new FactoryReleasePublicationScopeError("factory_release_publication_scope_unavailable");
    assertFactoryIdentity(material.operation_id);
    return Object.freeze({
      tenantId: this.tenantId, projectId: operation.project_id, runId: operation.run_id,
      attemptId, operationId: material.operation_id,
    });
  }
}

/** The publication set W09 wires into `FactoryArchiveWriter` for git and object destinations alike. */
export function factoryReleasePublicationSet(scopes: FactoryReleasePublicationScopes): FactoryArchivePublicationSet {
  return factoryArchivePublicationSet((tenantId, operationId, material, signal) => scopes.resolve(tenantId, operationId, material, signal));
}
