import { sql } from "drizzle-orm";
import type { FactoryArtifactReference, FactoryArtifactShareBody, FactoryArtifactShareResource, FactoryArtifactTicket, FactorySharedArtifactQuery } from "@ezcorp/factory-sdk";
import type { FactoryArtifactAccess, FactoryArtifactReadGrant } from "./artifact-access";
import type { TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import type { FactoryArtifactKind, FactoryArtifacts } from "./artifacts";
import { FactoryConsoleError, type FactoryConsoleSigner } from "./console-tokens";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { assertFactoryIdentity, type FactoryRunKey } from "./records";

/** A ticket is good for one short window and one artifact. */
export const FACTORY_TICKET_TTL_MS = 60_000;
/** The console never pulls more than this through a ticket. */
export const FACTORY_TICKET_MAX_BYTES = 16 * 1024 * 1024;
const TICKET_PURPOSE = "factory-artifact-ticket.v1";
const KINDS: readonly FactoryArtifactKind[] = ["definition_page", "definition_manifest", "transition_page", "transition_manifest", "execution_manifest", "partition", "candidate_output", "material"];

interface TicketClaims { readonly v: 1; readonly t: string; readonly p: string; readonly r: string; readonly a: string; readonly d: string; readonly b: number; readonly k: string; readonly i: string; readonly e: number }

function shareResource(grant: FactoryArtifactReadGrant): FactoryArtifactShareResource {
  return {
    sourceProjectId: grant.sourceProjectId, sourceRunId: grant.sourceRunId, artifactId: grant.artifact.artifactId, targetProjectId: grant.targetProjectId,
    digest: grant.artifact.digest, encodedBytes: grant.artifact.encodedBytes, mediaType: grant.mediaType, revoked: grant.revoked,
  };
}

export interface FactoryArtifactDownload {
  readonly bytes: Uint8Array;
  readonly artifactId: string;
  readonly digest: string;
  readonly kind: string;
}

/**
 * Short-lived, artifact-specific download tickets (C09 hostile previews).
 *
 * A ticket names one artifact of one run and the principal it was issued to.
 * It is not a bearer credential: the download route must still authenticate the
 * same principal, and `download` rechecks current read authority before any
 * byte is loaded. Blob digests are never an authorization handle.
 */
export class FactoryArtifactTickets {
  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly grants: FactoryGrants,
    private readonly artifacts: Pick<FactoryArtifacts, "loadInTransaction">,
    private readonly signer: FactoryConsoleSigner,
    private readonly sharing: Pick<FactoryArtifactAccess, "grant" | "revoke" | "loadSharedInTransaction">,
    private readonly now: () => number = Date.now,
  ) {
    assertFactoryIdentity(tenantId);
    if (grants.tenantId !== tenantId) throw new Error("factory_scope_mismatch");
  }

  async issue(principal: FactoryPrincipal, key: FactoryRunKey, artifactId: string, basePath: string): Promise<FactoryArtifactTicket> {
    const artifact = await this.reference(principal, key, artifactId);
    const expiresAtMs = this.now() + FACTORY_TICKET_TTL_MS;
    const claims: TicketClaims = { v: 1, t: this.tenantId, p: key.projectId, r: key.runId, a: artifactId, d: artifact.digest, b: artifact.encodedBytes, k: principal.kind, i: principal.id, e: expiresAtMs };
    const ticket = this.signer.sign(TICKET_PURPOSE, { ...claims });
    return { url: `${basePath}?ticket=${ticket}`, expiresAtMs, mediaType: "application/octet-stream", encodedBytes: claims.b };
  }

  async download(principal: FactoryPrincipal, key: FactoryRunKey, artifactId: string, ticket: string): Promise<FactoryArtifactDownload> {
    const claims = this.verify(ticket);
    if (claims.t !== this.tenantId || claims.p !== key.projectId || claims.r !== key.runId || claims.a !== artifactId || claims.k !== principal.kind || claims.i !== principal.id) {
      throw new FactoryConsoleError("factory_ticket_invalid");
    }
    return this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, principal, key.projectId, "read");
      const loaded = await this.artifacts.loadInTransaction(transaction, { tenantId: this.tenantId, projectId: key.projectId, logicalRunId: key.runId, interpreterId: "root" },
        { objectId: artifactId, digest: claims.d, encodedBytes: claims.b }, KINDS);
      return { bytes: loaded.content, artifactId, digest: claims.d, kind: loaded.kind };
    });
  }

  /**
   * Grants another project a read of this artifact's exact bytes. W02's access
   * store requires a human session holding `factory.operate` on the source and
   * writes the audit; nothing else of the source run becomes readable.
   */
  async share(principal: FactoryPrincipal, key: FactoryRunKey, artifactId: string, body: FactoryArtifactShareBody, idempotencyKey: string): Promise<FactoryArtifactShareResource> {
    const artifact = await this.reference(principal, key, artifactId);
    return shareResource(await this.sharing.grant(principal, { sourceProjectId: key.projectId, sourceRunId: key.runId, targetProjectId: body.targetProjectId, artifact, mediaType: body.mediaType }, idempotencyKey));
  }

  async unshare(principal: FactoryPrincipal, key: FactoryRunKey, artifactId: string, targetProjectId: string, idempotencyKey: string): Promise<FactoryArtifactShareResource> {
    const artifact = await this.reference(principal, key, artifactId);
    return shareResource(await this.sharing.revoke(principal, { sourceProjectId: key.projectId, targetProjectId, artifact }, idempotencyKey));
  }

  /** The target project's read: current read authority on the target, then the named grant, in one transaction. */
  async readShared(principal: FactoryPrincipal, targetProjectId: string, artifactId: string, query: FactorySharedArtifactQuery): Promise<FactoryArtifactDownload> {
    assertFactoryIdentity(targetProjectId, artifactId);
    return this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, principal, targetProjectId, "read");
      const shared = await this.sharing.loadSharedInTransaction(transaction, targetProjectId, { artifactId, digest: query.digest, encodedBytes: query.encodedBytes }, query.mediaType);
      return { bytes: shared.content, artifactId, digest: shared.artifact.digest, kind: "shared" };
    });
  }

  /** The exact reference behind a run's artifact, after current read authority. */
  private async reference(principal: FactoryPrincipal, key: FactoryRunKey, artifactId: string): Promise<FactoryArtifactReference> {
    assertFactoryIdentity(key.projectId, key.runId, artifactId);
    const row = await this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, principal, key.projectId, "read");
      const [found] = rows<{ digest: string; encoded_bytes: string | number }>(await transaction.execute(sql`SELECT digest, encoded_bytes FROM factory_artifacts
        WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND object_id=${artifactId}`));
      return found;
    });
    if (!row || Number(row.encoded_bytes) > FACTORY_TICKET_MAX_BYTES) throw new FactoryConsoleError("factory_artifact_not_found");
    return { artifactId, digest: row.digest, encodedBytes: Number(row.encoded_bytes) };
  }

  private verify(ticket: string): TicketClaims {
    const claims = this.signer.open(TICKET_PURPOSE, ticket) as TicketClaims | null;
    if (claims?.v !== 1 || !Number.isSafeInteger(claims.e) || !Number.isSafeInteger(claims.b)) throw new FactoryConsoleError("factory_ticket_invalid");
    if (claims.e <= this.now()) throw new FactoryConsoleError("factory_ticket_expired");
    return claims;
  }
}
