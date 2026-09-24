/** Supervisor-only offline verifier. The managed app must be stopped before
 * this process opens PGlite; the supervisor keeps it stopped through apply. */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { IncusQualificationFixtureService } from "../../src/infrastructure/incus-qualification";
import { applyNoEffectRecovery, type NoEffectRecoveryPayload,
  type NoEffectRecoveryReceipt } from "../../src/infrastructure/incus-create-noeffect-recovery";
import { resourceName } from "../../src/infrastructure/incus-transport/lifecycle";
import type { LiveReadbackContext } from "../../src/infrastructure/incus-transport/live-readback";

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

type Observation = { host: string; user: string; identityFile: string; knownHostsFile: string;
  project: string; instance: string; oldCertificateSha256: string };

export function verifiedObservation(result: { error?: Error; status: number | null; stdout: string },
  expected: Pick<Observation, "project" | "instance" | "oldCertificateSha256">):
  { absent: true; activeOperations: [] } {
  requireFact(!result.error && result.status === 0 && typeof result.stdout === "string",
    "independent Incus observation failed");
  let observed: Record<string, unknown>;
  try { observed = JSON.parse(result.stdout) as Record<string, unknown>; }
  catch { throw new Error("operator no-effect recovery denied: independent Incus observation is invalid"); }
  requireFact(observed && typeof observed === "object" && !Array.isArray(observed)
    && Object.keys(observed).sort().join() ===
    "absent,activeOperations,instance,oldCertificateRevoked,oldCertificateSha256,project,version"
    && observed.version === 1 && observed.project === expected.project
    && observed.instance === expected.instance
    && observed.oldCertificateSha256 === expected.oldCertificateSha256
    && observed.absent === true && observed.oldCertificateRevoked === true
    && Array.isArray(observed.activeOperations) && observed.activeOperations.length === 0,
  "independent Incus observation did not prove no effect");
  return { absent: true, activeOperations: [] };
}

function config(): { context: LiveReadbackContext; observation: Observation } {
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
  const { context, observation } = config();
  requireFact(context.scope.installationId === target.scope.installationId
    && context.scope.releaseId === target.scope.releaseId
    && context.scope.connectionId === target.scope.connectionId
    && context.preset.id === target.scope.presetId
    && context.connection.revision === target.connectionRevision
    && context.connection.project === observation.project
    && context.recipe.guestImage?.fingerprint === context.preset.imageDigest,
  "operator pins changed");
  requireFact(observation.instance === resourceName(target.scope.connectionId, target.bindingId)
    && /^[a-z][a-z0-9-]{0,62}$/.test(observation.project)
    && /^[a-f0-9]{64}$/.test(observation.oldCertificateSha256)
    && /^[a-z_][a-z0-9_-]{0,31}$/.test(observation.user)
    && /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/.test(observation.host),
  "independent observation pins changed");
  privateFile(observation.identityFile);
  privateFile(observation.knownHostsFile);
  const result = spawnSync("/run/current-system/sw/bin/ssh", ["-F", "/dev/null", "-T",
    "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
    "-o", "ClearAllForwardings=yes", "-o", "NumberOfPasswordPrompts=0",
    "-o", `UserKnownHostsFile=${observation.knownHostsFile}`,
    "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=5",
    "-i", observation.identityFile, "-l", observation.user, observation.host,
    "ezh-incus-noeffect-observe-v1"], { input: "", encoding: "utf8", timeout: 20_000,
    maxBuffer: 64 * 1024, env: { PATH: "/run/current-system/sw/bin", HOME: "/var/empty", LC_ALL: "C" } });
  return verifiedObservation(result, observation);
}

if (import.meta.main) {
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
}
