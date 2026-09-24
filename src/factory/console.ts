import { hkdfSync } from "node:crypto";
import type { TransactionalDb } from "../db/migrations/types";
import type { BlobStore } from "../extensions/v4/types";
import { getJwtSecret } from "../auth/jwt";
import { FactoryArtifactAccess } from "./artifact-access";
import { FactoryArtifactTickets } from "./artifact-tickets";
import type { FactoryArtifacts } from "./artifacts";
import { factoryPackageReadiness } from "./attempt-composition";
import { FACTORY_CURSOR_TTL_MS, FactoryConsoleSigner, FactoryEventCursors } from "./console-tokens";
import type { BoundBlobStore } from "./encryption";
import type { FactoryGrants } from "./grants";
import { FactoryPackageAdmin } from "./package-admin";
import { FactoryPackageTrusts } from "./package-preparation";
import { FactoryPurgeRequests } from "./purge-requests";
import { FactoryRestoreReports, type FactoryRestoreSigner } from "./restore-console";
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
  readonly restores: FactoryRestoreReports;
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
  /** How long an event cursor lives. Defaults to the installation setting, else 15 minutes. */
  readonly cursorTtlMs?: number;
  /** Composes the installation's restore to sign a report; absent, a signature answers unavailable. */
  readonly restoreSigner?: FactoryRestoreSigner;
}

const MIN_CURSOR_TTL_MS = 5_000;
const MAX_CURSOR_TTL_MS = 60 * 60_000;

/**
 * The installation's cursor lifetime (`EZCORP_FACTORY_CONSOLE_CURSOR_TTL_MS`),
 * bounded to 5 seconds through 1 hour. A missing value is the 15-minute
 * default; a malformed or out-of-bounds value is refused, not silently clamped.
 */
export function factoryConsoleCursorTtlMs(environment: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = environment.EZCORP_FACTORY_CONSOLE_CURSOR_TTL_MS;
  if (raw === undefined || raw === "") return FACTORY_CURSOR_TTL_MS;
  const value = Number(raw);
  if (!/^[0-9]+$/.test(raw) || value < MIN_CURSOR_TTL_MS || value > MAX_CURSOR_TTL_MS) throw new Error(`EZCORP_FACTORY_CONSOLE_CURSOR_TTL_MS must be an integer from ${MIN_CURSOR_TTL_MS} to ${MAX_CURSOR_TTL_MS} milliseconds.`);
  return value;
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
  const cursors = new FactoryEventCursors(signer, now, options.cursorTtlMs ?? factoryConsoleCursorTtlMs());
  const preparations = factoryPackageReadiness(options.database, options.tenantId, options.grants, plainBlobStore(options.blobs));
  const trusts = new FactoryPackageTrusts(options.database, options.tenantId, options.grants);
  const sharing = new FactoryArtifactAccess(options.database, options.tenantId, options.grants, options.artifacts);
  return Object.freeze({
    tenantId: options.tenantId,
    inspections: new FactoryRunInspections(options.database, options.tenantId, options.grants, options.runs, cursors),
    events: new FactoryRunEvents(options.database, options.tenantId, options.grants, cursors),
    packages: new FactoryPackageAdmin(options.database, options.tenantId, options.grants, preparations, trusts),
    purge: new FactoryPurgeRequests(options.database, options.tenantId, now),
    restores: new FactoryRestoreReports(options.database, options.tenantId, options.restoreSigner),
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
