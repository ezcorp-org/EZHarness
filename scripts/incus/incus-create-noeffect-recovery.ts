/** Supervisor-only offline verifier. The managed app must be stopped before
 * this process opens PGlite; the supervisor keeps it stopped through apply. */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { IncusQualificationFixtureService } from "../../src/infrastructure/incus-qualification";
import { applyNoEffectRecovery, type NoEffectRecoveryPayload,
  type NoEffectRecoveryReceipt } from "../../src/infrastructure/incus-create-noeffect-recovery";
import { HostIncusLiveReadback, type LiveReadbackContext } from "../../src/infrastructure/incus-transport/live-readback";
import type { ResolvedIncusConnection } from "../../src/infrastructure/incus-transport/transport";

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`operator no-effect recovery denied: ${message}`);
}

function privateFile(path: string): string {
  requireFact(path.startsWith("/"), "private file path required");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireFact(stat.isFile() && stat.uid === process.geteuid!() && (stat.mode & 0o077) === 0
      && stat.size > 0 && stat.size <= 128 * 1024, "private file ownership or mode changed");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

function config(): { context: LiveReadbackContext; transportConnection: ResolvedIncusConnection } {
  const path = process.env.EZCORP_INCUS_NOEFFECT_CONFIG;
  requireFact(path, "operator connection config required");
  return JSON.parse(privateFile(path)) as ReturnType<typeof config>;
}

async function withOfflineDb<T>(use: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
  const path = process.env.EZCORP_INCUS_SUPERVISOR_DB_PATH;
  requireFact(path?.startsWith("/") && !process.env.DATABASE_URL, "isolated PGlite path required");
  const client = new PGlite(path);
  try {
    await client.waitReady;
    return await use(drizzle(client));
  } finally { await client.close(); }
}

type Target = Pick<NoEffectRecoveryPayload, "scope" | "fixtureOperationId" | "bindingId"
  | "operationId" | "generation" | "connectionRevision">;

async function durable(target: Target): Promise<{ verified: true }> {
  await withOfflineDb(async db => {
    const status = await new IncusQualificationFixtureService({ db }).status(target.scope,
      target.fixtureOperationId);
    requireFact(status.fixture.bindingId === target.bindingId
      && status.fixture.connectionRevision === target.connectionRevision
      && status.binding.generation === target.generation
      && status.binding.desiredState === "STOPPED"
      && status.binding.observedState === "UNKNOWN"
      && status.operation?.id === target.operationId
      && status.operation.kind === "CREATE"
      && status.operation.state === "OUTCOME_UNKNOWN"
      && status.operation.providerOperationId === null,
    "durable CREATE changed");
  });
  return { verified: true };
}

async function backend(target: Target): Promise<{ absent: true; activeOperations: [] }> {
  const { context, transportConnection } = config();
  requireFact(context.scope.installationId === target.scope.installationId
    && context.scope.releaseId === target.scope.releaseId
    && context.scope.connectionId === target.scope.connectionId
    && context.preset.id === target.scope.presetId
    && context.connection.revision === target.connectionRevision
    && context.connection.project === transportConnection.project
    && context.connection.serverCertificatePem === transportConnection.serverCertificatePem
    && context.recipe.guestImage?.fingerprint === context.preset.imageDigest,
  "operator pins changed");
  const reader = new HostIncusLiveReadback({ resolveForHost: async input => {
    requireFact(input.connectionId === target.scope.connectionId
      && input.providerInstallationId === target.scope.installationId
      && input.providerReleaseId === target.scope.releaseId
      && input.revision === target.connectionRevision, "backend connection changed");
    return transportConnection;
  } });
  const instance = await reader.instance(context, target.bindingId);
  const activeOperations = await reader.activeOperations(context);
  requireFact(instance.state === "absent" && activeOperations.length === 0,
    "instance or delayed Incus operation remains");
  return { absent: true, activeOperations: [] };
}

const input = JSON.parse(await Bun.stdin.text());
if (input.phase === "durable") {
  process.stdout.write(JSON.stringify(await durable(input.target)) + "\n");
} else if (input.phase === "backend") {
  process.stdout.write(JSON.stringify(await backend(input.target)) + "\n");
} else if (input.phase === "apply") {
  const receipt = input.receipt as NoEffectRecoveryReceipt;
  const publicKeyPem = input.publicKeyPem as string;
  requireFact(typeof publicKeyPem === "string" && publicKeyPem.includes("BEGIN PUBLIC KEY"),
    "supervisor public key required");
  const cleanupOperationId = await withOfflineDb(db =>
    applyNoEffectRecovery(db, receipt, publicKeyPem));
  process.stdout.write(JSON.stringify({ cleanupOperationId }) + "\n");
} else {
  throw new Error("operator no-effect recovery phase is invalid");
}
