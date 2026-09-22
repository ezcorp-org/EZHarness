import { hkdfSync } from "node:crypto";
import type { TransactionalDb } from "../db/migrations/types";
import type { BlobStore } from "../extensions/v4/types";
import { getJwtSecret } from "../auth/jwt";
import { FactoryArtifactAccess } from "./artifact-access";
import { FactoryArtifactTickets } from "./artifact-tickets";
import type { FactoryArtifacts } from "./artifacts";
import { factoryPackageReadiness } from "./attempt-composition";
import { FactoryConsoleSigner, FactoryEventCursors } from "./console-tokens";
import type { BoundBlobStore } from "./encryption";
import type { FactoryGrants } from "./grants";
import { FactoryPackageAdmin } from "./package-admin";
import { FactoryPackageTrusts } from "./package-preparation";
import { FactoryPurgeRequests } from "./purge-requests";
import { FactoryRunEvents } from "./run-events";
import { FactoryRunInspections } from "./run-inspection";
import type { FactoryRunLifecycle } from "./run-lifecycle";

/** The live console's read models and administrator actions (C09, W14). */
export interface FactoryConsoleServices {
  readonly tenantId: string;
  readonly inspections: FactoryRunInspections;
  readonly events: FactoryRunEvents;
  readonly packages: FactoryPackageAdmin;
  readonly purge: FactoryPurgeRequests;
  readonly tickets: FactoryArtifactTickets;
}

export interface FactoryConsoleOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  readonly grants: FactoryGrants;
  readonly runs: FactoryRunLifecycle;
  readonly artifacts: FactoryArtifacts;
  readonly blobs: BlobStore | BoundBlobStore;
  /** At least 32 bytes. Signs event cursors and artifact tickets. */
  readonly key: Uint8Array;
  readonly now?: () => number;
}

/**
 * The console never prepares a package, so it never reads package source. An
 * encrypted installation has no unbound read at all, and this says so by name
 * instead of handing the catalog a store that would answer.
 */
export const UNBOUND_SOURCE_UNAVAILABLE: BlobStore = Object.freeze({
  put: () => Promise.reject(new Error("factory_console_package_source_unavailable")),
  get: () => Promise.reject(new Error("factory_console_package_source_unavailable")),
});

function plainBlobStore(blobs: BlobStore | BoundBlobStore): BlobStore {
  return "get" in blobs && "put" in blobs ? blobs : UNBOUND_SOURCE_UNAVAILABLE;
}

export function createFactoryConsole(options: FactoryConsoleOptions): FactoryConsoleServices {
  const signer = new FactoryConsoleSigner(options.key);
  const now = options.now ?? Date.now;
  const cursors = new FactoryEventCursors(signer, now);
  const preparations = factoryPackageReadiness(options.database, options.tenantId, options.grants, plainBlobStore(options.blobs));
  const trusts = new FactoryPackageTrusts(options.database, options.tenantId, options.grants);
  const sharing = new FactoryArtifactAccess(options.database, options.tenantId, options.grants, options.artifacts);
  return Object.freeze({
    tenantId: options.tenantId,
    inspections: new FactoryRunInspections(options.database, options.tenantId, options.grants, options.runs, cursors),
    events: new FactoryRunEvents(options.database, options.tenantId, options.grants, cursors),
    packages: new FactoryPackageAdmin(options.database, options.tenantId, options.grants, preparations, trusts),
    purge: new FactoryPurgeRequests(options.database, options.tenantId, now),
    tickets: new FactoryArtifactTickets(options.database, options.tenantId, options.grants, options.artifacts, signer, sharing, now),
  });
}

/**
 * The console signing key: HKDF over the installation's JWT secret, salted by
 * tenant. Every web replica of one installation derives the same key, so a
 * reconnect to another replica resumes; another installation cannot forge one.
 */
export async function factoryConsoleKey(tenantId: string): Promise<Uint8Array> {
  return new Uint8Array(hkdfSync("sha256", await getJwtSecret(), `ezcorp-factory-console:${tenantId}`, "ezcorp.factory.console.v1", 32));
}
