/** Supervisor-only offline verifier. The managed app must be stopped before
 * this process opens PGlite; the supervisor keeps it stopped through apply. */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { IncusQualificationFixtureService } from "../../src/infrastructure/incus-qualification";
import { applyNoEffectRecovery, type NoEffectRecoveryPayload,
  type NoEffectRecoveryReceipt } from "../../src/infrastructure/incus-create-noeffect-recovery";
import { resourceName } from "../../src/infrastructure/incus-transport/lifecycle";
import type { LiveReadbackContext } from "../../src/infrastructure/incus-transport/live-readback";
import { isStableStartCleanup, isRetainedDestroyNoEffect, inspectRetainedDestroyNoEffect, type RetainedDestroyNoEffectPayload, requireRetainedDestroyNoEffectPins, requireRetainedDestroyNoEffectOriginal, requireFencedCleanupPinVersion, requireStableStartCleanupPins, requireStableStartOriginal, applyFencedCleanupRecovery, applyFencedCleanupAbort, inspectFencedCleanupAbort, requireFencedCleanupAuthority, type FencedCleanupProofPins, type FencedCleanupProofPayload, type FencedCleanupAbortReceipt, type FencedCleanupReceipt } from "../../src/infrastructure/incus-fenced-cleanup-recovery";
import { observeFencedCleanup, type FencedCleanupTarget } from "../../src/infrastructure/incus-fenced-cleanup-observer";
import { canonicalRecoveryJson } from "../../src/infrastructure/incus-create-noeffect-recovery";
import { incusSupervisorPublicKeyPem } from "../../src/infrastructure/incus-supervisor-public-key";
import { incusQualificationFixtures, sandboxBindings, sandboxOperations } from "../../src/db/schema";

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

type SealedFencedTarget = FencedCleanupTarget & { action: "recover-fenced-cleanup"; pins: FencedCleanupProofPins };
type FencedConfig = { version: 1 | 2 | 3; action: "recover-fenced-cleanup"; target: FencedCleanupTarget;
  pins: FencedCleanupProofPins; context: LiveReadbackContext;
  observation: Pick<Observation, "project" | "instance" | "oldCertificateSha256">;
  operatorClientCertificateFile: string; operatorPrivateKeyFile: string };

/** These public pins come from the root-owned config, not the control request. */
async function durableFenced(target: SealedFencedTarget): Promise<{ verified: true; pins: FencedCleanupProofPins }> {
  requireFencedCleanupPinVersion(isRetainedDestroyNoEffect(target.pins) ? 3 : isStableStartCleanup(target.pins) ? 2 : 1, target.pins);
  if (isStableStartCleanup(target.pins)) requireStableStartCleanupPins(target, target.pins);
  await withOfflineDb(async db => {
    await requireFencedCleanupAuthority(db, { ...target, ...target.pins });
    if (isRetainedDestroyNoEffect(target.pins)) {
      requireRetainedDestroyNoEffectPins(target, target.pins);
      await requireRetainedDestroyNoEffectOriginal(db, { ...target, ...target.pins });
      return;
    }
    const [fixture] = await db.select().from(incusQualificationFixtures)
      .where(eq(incusQualificationFixtures.operationId, target.fixtureOperationId));
    const [binding] = await db.select().from(sandboxBindings).where(eq(sandboxBindings.id, target.bindingId));
    const [operation] = await db.select().from(sandboxOperations).where(eq(sandboxOperations.id, target.operationId));
    requireFact(fixture && binding && operation && fixture.bindingId === target.bindingId
      && fixture.installationId === target.scope.installationId && fixture.releaseId === target.scope.releaseId
      && fixture.connectionId === target.scope.connectionId && fixture.presetId === target.scope.presetId
      && fixture.connectionRevision === target.connectionRevision
      && binding.currentOperationId === operation.id && binding.generation === target.generation
      && !binding.tombstonedAt && operation.generation === target.generation
      && ["START", "STOP"].includes(operation.kind) && operation.state === "OUTCOME_UNKNOWN"
      && operation.providerOperationId === target.pins.providerOperationId
      && operation.payloadHash === target.pins.payloadHash
      && operation.idempotencyScope === "incus-qualification-power"
      && operation.idempotencyKey.startsWith(`${target.fixtureOperationId}:`), "fenced cleanup durable target changed");
    if (isStableStartCleanup(target.pins)) requireStableStartOriginal(operation, binding, target.pins);
  });
  return { verified: true, pins: target.pins };
}

function sealedFencedConfig(target: SealedFencedTarget): FencedConfig {
  const path = process.env.EZCORP_INCUS_FENCED_CLEANUP_CONFIG;
  requireFact(path, "fenced cleanup sealed config required");
  const sealed = JSON.parse(privateFile(path)) as FencedConfig;
  const { action, pins, ...publicTarget } = target;
  requireFencedCleanupPinVersion(sealed.version, pins);
  requireFact(sealed.version === (isRetainedDestroyNoEffect(pins) ? 3 : isStableStartCleanup(pins) ? 2 : 1) && sealed.action === action
    && Object.keys(sealed).sort().join() === "action,context,observation,operatorClientCertificateFile,operatorPrivateKeyFile,pins,target,version"
    && canonicalRecoveryJson(sealed.target) === canonicalRecoveryJson(publicTarget)
    && canonicalRecoveryJson(sealed.pins) === canonicalRecoveryJson(pins)
    && sealed.observation.project === pins.project
    && sealed.observation.instance === resourceName(target.scope.connectionId, target.bindingId),
  "fenced cleanup sealed policy changed");
  return sealed;
}

function trustedSupervisorSigner(publicKeyPem: unknown): string {
  const trustedKey = incusSupervisorPublicKeyPem();
  requireFact(trustedKey && typeof publicKeyPem === "string"
    && createPublicKey(trustedKey).export({ format: "der", type: "spki" }).equals(
      createPublicKey(publicKeyPem).export({ format: "der", type: "spki" })),
  "fenced cleanup requires the configured supervisor signer");
  return trustedKey;
}

export async function handleFencedCleanupPhase(input: Record<string, unknown>): Promise<unknown> {
  if (input.phase === "durable" || input.phase === "backend") {
    requireFact(Object.keys(input).sort().join() === "phase,target", "fenced cleanup phase fields changed");
    const target = input.target as SealedFencedTarget;
    requireFact(target?.action === "recover-fenced-cleanup", "fenced cleanup action required");
    if (input.phase === "durable") return durableFenced(target);
    const sealed = sealedFencedConfig(target);
    const clientCertificatePem = privateFile(sealed.operatorClientCertificateFile);
    const privateKeyPem = privateFile(sealed.operatorPrivateKeyFile);
    return observeFencedCleanup({ resolveForHost: async scope => {
      requireFact(scope.connectionId === target.scope.connectionId
        && scope.providerInstallationId === target.scope.installationId
        && scope.providerReleaseId === target.scope.releaseId && scope.revision === target.connectionRevision,
      "fenced cleanup operator scope changed");
      return { endpoint: sealed.pins.endpoint, project: sealed.pins.project,
        serverCertificatePem: sealed.context.connection.serverCertificatePem, clientCertificatePem, privateKeyPem };
    } }, sealed.context, sealed.target, sealed.pins);
  }
  if (input.phase === "inspect-noeffect") {
    requireFact(Object.keys(input).sort().join() === "phase,publicKeyPem,receipt", "no-effect readback fields changed");
    const trustedKey = trustedSupervisorSigner(input.publicKeyPem);
    return withOfflineDb(db => inspectRetainedDestroyNoEffect(db, input.receipt as FencedCleanupReceipt<RetainedDestroyNoEffectPayload>, trustedKey));
  }
  if (input.phase === "abort" || input.phase === "inspect-abort") {
    requireFact(Object.keys(input).sort().join() === "phase,publicKeyPem,receipt", "abort phase fields changed");
    const trustedKey = trustedSupervisorSigner(input.publicKeyPem);
    return withOfflineDb(db => input.phase === "abort"
      ? applyFencedCleanupAbort(db, input.receipt as FencedCleanupAbortReceipt<FencedCleanupProofPins>, trustedKey)
      : inspectFencedCleanupAbort(db, input.receipt as FencedCleanupAbortReceipt<FencedCleanupProofPins>, trustedKey));
  }
  requireFact(input.phase === "apply" && Object.keys(input).sort().join() === "phase,publicKeyPem,receipt", "fenced cleanup phase invalid");
  const trustedKey = trustedSupervisorSigner(input.publicKeyPem);
  const cleanupOperationId = await withOfflineDb(db => applyFencedCleanupRecovery(db,
    input.receipt as FencedCleanupReceipt<FencedCleanupProofPayload>, trustedKey));
  return { cleanupOperationId };
}

if (import.meta.main) {
  const input = JSON.parse(await Bun.stdin.text());
  if (input.target?.action === "recover-fenced-cleanup" || ["recover-fenced-cleanup", "abort-fenced-cleanup-before-admission"].includes(input.receipt?.payload?.action)) {
    process.stdout.write(JSON.stringify(await handleFencedCleanupPhase(input)) + "\n");
  } else if (input.phase === "durable") {
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
