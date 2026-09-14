#!/usr/bin/env bun
/**
 * The reference image pack, executed for real on the local AMD GPU.
 *
 * This drives the pack's own launch path: the shared Python runner seals the
 * guest through the shared recipe machinery, a held pool allocation mints a
 * per-attempt device grant, and each recorded seed runs in its OWN isolated
 * attempt with exactly the C10 settings. Nothing here reconfigures the GPU and
 * nothing reimages anything; the user-scoped GPU lock is held for the whole run
 * so a second copy waits rather than sharing the device.
 *
 * One attempt per seed is the faithful reading of "map four recorded seeds over
 * isolated GPU generation", and it is also what the platform allows: the shared
 * runner caps a worker's control output at one mebibyte for its WHOLE LIFE
 * rather than per frame, so four variants could never report from one worker.
 *
 * The bytes leave through the material mount, not the control channel. The
 * guest writes each accepted variant into the per-attempt directory the host
 * bind-mounts at `/materials` and declares what it wrote; after the guest is
 * confirmed stopped, the host walks that directory through the shared
 * `listRunnerMaterials` and `openRunnerMaterial`, recomputes every digest, and
 * seals the bytes as a material. A variant at the contract's 1,024-pixel size
 * now reaches the host whole, which the control channel could never do: its
 * budget is one mebibyte for a worker's entire life.
 *
 * The semantic evaluation is not here either. It needs a provider the isolation
 * profile deliberately puts out of reach and a credential this host does not
 * carry, so it is an unmet readiness row rather than a silent omission.
 *
 * Usage: bun scripts/verify-factory-image-pack.ts [--out <path>] [--prompt <text>]
 *        [--seeds 11,23,37,53] [--width 1024] [--height 1024] [--label <name>]
 *        [--fixtures]
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResourceLimits } from "@ezcorp/extension-contract";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import { buildLimits, filesDigest, GUEST_MATERIALS_PATH, PythonPodmanRunner } from "@ezcorp/extension-runner";

import type {
  FactoryMaterialChunk,
  FactoryMaterialIdentity,
  FactoryMaterialRecord,
  FactoryMaterialScope,
} from "../src/factory/artifact-materials.ts";
import { referenceImageGuestFiles, REFERENCE_IMAGE_GUEST_ENTRYPOINT, referenceImageRunnerClosure } from "../src/factory/reference-image/closure.ts";
import { sealGuestMaterials, type GuestMaterialClaim, type GuestMaterialSink, type SealedGuestMaterial } from "../src/factory/reference-image/materials.ts";
import { referenceImageLock, referenceImageLockDigest } from "../src/factory/reference-image/lock.ts";
import { assessRound, type VariantRecord } from "../src/factory/reference-image/variants.ts";
import { factoryAttemptDeviceGrant, factoryHeldAllocationDevices, type FactoryAttemptLease } from "../src/factory/runner/attempt-runtime.ts";

/** The supported local profile: both render nodes, because this ROCm runtime fails initialization with only the discrete device. */
const LOCAL_AMD_PROFILE = Object.freeze({
  hostId: "local-amd-host",
  devices: Object.freeze(["/dev/kfd", "/dev/dri/renderD128", "/dev/dri/renderD129"]),
  cdiDevices: Object.freeze([] as readonly string[]),
});
const GPU_LOCK = `${process.env.XDG_RUNTIME_DIR ?? "/run/user/1001"}/ezcorp-factory-local-gpu.lock`;

const LEASE: FactoryAttemptLease = {
  reservationId: "image-pack-reservation",
  grantRevision: 1,
  allocationGeneration: 1,
  holderGeneration: 1,
  allocationToken: "image-pack-allocation",
  hostId: LOCAL_AMD_PROFILE.hostId,
};

/**
 * Generation needs far more than the shared defaults: the pipeline is several
 * gigabytes of weights. The ceiling is stated here rather than raised inside the
 * runner, so the shared defaults still apply to every other guest.
 */
const GPU_CEILING: ResourceLimits = Object.freeze({
  memoryBytes: 20 * 1024 ** 3,
  cpuMillis: 8_000,
  pids: 512,
  tmpBytes: 4 * 1024 ** 3,
  outputBytes: 4 * 1024 ** 2,
  timeoutMs: 90 * 60 * 1_000,
});

const CPU_LIMITS: ResourceLimits = Object.freeze({
  memoryBytes: 4 * 1024 ** 3,
  cpuMillis: 4_000,
  pids: 256,
  tmpBytes: 1024 ** 3,
  outputBytes: 4 * 1024 ** 2,
  timeoutMs: 20 * 60 * 1_000,
});

const BUILD_CEILING: ResourceLimits = Object.freeze({ ...buildLimits, memoryBytes: 6 * 1024 ** 3, tmpBytes: 2 * 1024 ** 3, timeoutMs: 30 * 60 * 1_000, outputBytes: 4 * 1024 ** 2 });

/** Raw bytes per transfer piece. Base64 adds a third and the envelope a little more. */
const PIECE_BYTES = 384 * 1024;

/** Where the guest writes what it wants the host to keep. */
const VARIANT_MATERIAL_PATH = "variant.png";

function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

/** Holds the user-scoped GPU lock for the whole run; a second copy waits rather than sharing the device. */
async function withGpuLock<Value>(action: () => Promise<Value>): Promise<Value> {
  const handle = await open(GPU_LOCK, "a");
  const lock = Bun.spawn(["flock", "--exclusive", String(handle.fd), "/bin/sh", "-c", "echo HELD; cat >/dev/null"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  try {
    const reader = lock.stdout.getReader();
    const first = await reader.read();
    if (new TextDecoder().decode(first.value).trim() !== "HELD") throw new Error("Could not take the local GPU lock.");
    return await action();
  } finally {
    lock.kill();
    await lock.exited.catch(() => undefined);
    await handle.close();
  }
}

/**
 * The material store this driver seals into.
 *
 * It is deliberately in-script and says so in the receipt. `FactoryAttemptMaterials`
 * needs a live admitted attempt with its journal and authority rows, which is
 * the production dispatch path rather than a standalone driver, and standing
 * one up here would measure W01's admission rather than this pack's egress.
 * What this run is the subject of is the mount: that the guest's bytes reach the
 * host whole and verified. The sealing contract itself is measured against the
 * real `FactoryMaterialService` interface in `materials.test.ts`, and the
 * durable store is W04's.
 */
class DriverMaterials implements GuestMaterialSink {
  private readonly held = new Map<string, Uint8Array>();
  private readonly parts = new Map<string, Uint8Array[]>();

  private record(identity: FactoryMaterialIdentity, mediaType: string, totalBytes: number, chunkCount: number): FactoryMaterialRecord {
    return { ...identity, schemaVersion: "factory.material.v1", mediaType, digest: "", totalBytes, chunkCount, storageVersion: "1", sealed: false, createdAtMs: Date.now() };
  }
  async begin(identity: FactoryMaterialIdentity, mediaType: string, totalBytes: number, chunkCount: number): Promise<FactoryMaterialRecord> {
    this.parts.set(identity.objectName, []);
    return this.record(identity, mediaType, totalBytes, chunkCount);
  }
  async writeChunk(identity: FactoryMaterialIdentity, chunk: FactoryMaterialChunk, content: Uint8Array): Promise<FactoryMaterialRecord> {
    // Never route this through `begin`: that resets the buffer, so every chunk
    // would clear the ones before it and the store would seal nothing. It did,
    // and the only symptom was a zero-byte file with a correct-looking digest.
    (this.parts.get(identity.objectName) as Uint8Array[])[chunk.index] = Uint8Array.from(content);
    return this.record(identity, "application/octet-stream", content.byteLength, 1);
  }
  async seal(identity: FactoryMaterialIdentity, digest: string): Promise<FactoryArtifactReference> {
    const assembled = Buffer.concat((this.parts.get(identity.objectName) ?? []) as Uint8Array[]);
    if (digestOf(assembled) !== digest) {
      throw new Error(`Sealing ${identity.objectName} assembled ${assembled.byteLength} bytes digesting ${digestOf(assembled)}, not the ${digest} the caller verified`);
    }
    this.held.set(identity.objectName, assembled);
    return { artifactId: identity.objectName, digest, encodedBytes: assembled.byteLength };
  }
  /** Re-checks the digest on the way out, so a store that lost bytes says so. */
  read(reference: FactoryArtifactReference): Uint8Array {
    const bytes = this.held.get(reference.artifactId);
    if (bytes === undefined) throw new Error(`no sealed material ${reference.artifactId}`);
    if (digestOf(bytes) !== reference.digest) throw new Error(`Sealed material ${reference.artifactId} no longer digests ${reference.digest}`);
    return bytes;
  }
}

interface Worker {
  request(method: string, params: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Reassembles one held image and verifies it against the digest the guest
 * reported. The digest is what binds the reassembly: a lost or reordered piece
 * is a mismatch rather than a picture that still looks like one.
 */
async function fetchImage(worker: Worker, context: unknown, digest: string, expectedBytes: number): Promise<Uint8Array> {
  const pieces: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const answer = (await worker.request("extension/invoke", { name: "fetch", input: { digest, offset, maximum: PIECE_BYTES }, context })) as { data: string; length: number; remaining: number };
    pieces.push(Buffer.from(answer.data, "base64"));
    offset += answer.length;
    if (answer.remaining === 0) break;
    if (answer.length === 0) throw new Error(`The guest returned an empty piece of ${digest} at offset ${offset}`);
  }
  const bytes = Buffer.concat(pieces);
  if (bytes.length !== expectedBytes) throw new Error(`Reassembled ${bytes.length} bytes of ${digest} where the guest reported ${expectedBytes}`);
  const observed = digestOf(bytes);
  if (observed !== digest) throw new Error(`Reassembled bytes digest ${observed}, not the reported ${digest}`);
  return bytes;
}

/**
 * Prepares one per-attempt material directory the guest can actually write to.
 *
 * The guest runs as uid 65534 inside its user namespace, and a directory the
 * host created is owned by the host user, so the guest gets `EPERM` on its first
 * write. `podman unshare` performs the chown INSIDE that namespace, which is
 * what maps 65534 to the right host subuid; a plain `chown` on this side cannot
 * name it.
 *
 * Group zero in the namespace is the host user, so mode 0770 lets the guest own
 * the directory and lets the host read the files back as group, while other gets
 * nothing. A world-writable 0777 would do the same job and is the reason this
 * says 0770 instead.
 *
 * The mode is set BEFORE the chown, not after. Once the directory belongs to a
 * subuid the host user does not own, a host-side `chmod` is `EPERM`; `mkdir`'s
 * mode argument is also subject to the umask, so it is set explicitly while the
 * host still owns the directory.
 *
 * A host with no container runtime fails here rather than continuing with a
 * directory the guest cannot use.
 */
async function prepareMaterialDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o770);
  const chown = Bun.spawn(["podman", "unshare", "chown", "65534:0", directory], { stdout: "pipe", stderr: "pipe" });
  const code = await chown.exited;
  if (code !== 0) {
    const detail = (await new Response(chown.stderr).text()).trim();
    throw new Error(`Could not give the guest ownership of ${directory}: podman unshare chown exited ${code}. ${detail}`);
  }
}

function contextFor(workerId: string, artifactDigest: string, limits: ResourceLimits): Record<string, unknown> {
  return {
    workerId,
    invocationId: randomUUID(),
    releaseId: artifactDigest,
    principalId: "image-tenant",
    scopeId: "image-project",
    token: "image-token",
    deadline: Date.now() + limits.timeoutMs - 5_000,
  };
}

function claimInput(digest: string, width: number, height: number): Record<string, unknown> {
  return {
    digest,
    width,
    height,
    colourModes: [referenceImageLock.normalization.colorMode],
    bitDepth: referenceImageLock.normalization.bitDepth,
    maximumBytes: referenceImageLock.normalization.maximumBytes,
    allowedChunks: [...referenceImageLock.normalization.allowedChunks],
    language: referenceImageLock.ocr.language,
    pageSegmentationMode: referenceImageLock.ocr.pageSegmentationMode,
    engineMode: referenceImageLock.ocr.engineMode,
    minimumWordConfidence: referenceImageLock.ocr.minimumWordConfidence,
  };
}

type ClaimOutcome = { id: string; verdict: string; summary: string; reasonCode: string; decisive: boolean; measuredAtMs: number; evidence: readonly unknown[] };
type Egress = "sealed-from-material-mount" | "not-attempted";

interface SeedRecord {
  readonly seed: number;
  readonly index: number;
  readonly outcome: "succeeded" | "failed";
  readonly attemptId: string;
  readonly devices: readonly string[];
  readonly generated?: { digest: string; bytes: number };
  readonly normalized?: { digest: string; bytes: number; sourceDigest: string };
  readonly claims?: readonly ClaimOutcome[];
  readonly egress: Egress;
  readonly runtime?: Record<string, string>;
  readonly elapsedMs: number;
  readonly error?: string;
}

async function main(): Promise<number> {
  const out = argument("out", "");
  const label = argument("label", "reference-image-journey");
  const prompt = argument("prompt", "One green oak tree on a plain white background, no text.");
  const seeds = argument("seeds", referenceImageLock.generation.seeds.join(",")).split(",").map(value => Number.parseInt(value, 10));
  const width = Number.parseInt(argument("width", String(referenceImageLock.generation.width)), 10);
  const height = Number.parseInt(argument("height", String(referenceImageLock.generation.height)), 10);
  const withFixtures = process.argv.includes("--fixtures");

  const root = await mkdtemp(join(tmpdir(), "ez-factory-image-"));
  // The runner owns its store and removes staging directories inside it, so a
  // variant this run keeps lives somewhere the runner does not manage.
  const artifacts = await mkdtemp(join(tmpdir(), "ez-factory-image-out-"));
  // The per-attempt material directories live outside the runner's own store,
  // because the runner removes staging directories inside it.
  const materialRoot = await mkdtemp(join(tmpdir(), "ez-factory-image-materials-"));
  const store = new DriverMaterials();
  const closure = await referenceImageRunnerClosure();
  const files = await referenceImageGuestFiles();
  const sourceDigest = filesDigest(files);
  const started = new Date().toISOString();
  const records: SeedRecord[] = [];
  // What each seed's guest declared it wrote, and what the host sealed after
  // that guest stopped. A running guest can swap a directory component between
  // the walk and the open, so the read-back never overlaps a live worker.
  const claims = new Map<number, GuestMaterialClaim>();
  const sealed: (SealedGuestMaterial & { seed: number })[] = [];
  const fixtures: Record<string, unknown>[] = [];
  const notes: string[] = [];
  let artifactDigest = "";
  let cpuDevices: readonly string[] = [];
  let observedRuntime: Record<string, string> = {};
  let fatal: string | undefined;

  // The host runner is configured with the FULL local device list, exactly the
  // host-global list a factory start must never inherit.
  const runner = new PythonPodmanRunner({
    root,
    image: referenceImageLock.runtime.guestImage,
    closure,
    configuredDevices: LOCAL_AMD_PROFILE.devices,
    buildCeiling: BUILD_CEILING,
    executionCeiling: GPU_CEILING,
  });

  try {
    const build = await runner.build({ operationId: randomUUID(), files, sourceDigest, entrypoint: REFERENCE_IMAGE_GUEST_ENTRYPOINT, limits: BUILD_CEILING });
    if (build.state !== "succeeded" || build.artifactDigest === undefined) {
      throw new Error(`The image guest did not seal: ${JSON.stringify(build.diagnostics)}`);
    }
    artifactDigest = build.artifactDigest;
    notes.push(`the guest sealed through the shared Python recipe machinery with ${closure.distributions.length} pinned distribution(s) and ${closure.models.length} pinned model file(s)`);

    // --- one isolated GPU attempt per seed -------------------------------
    for (const [index, seed] of seeds.entries()) {
      const startedAt = Date.now();
      const attemptId = `image-attempt-seed-${seed}`;
      const grant = factoryAttemptDeviceGrant(attemptId, LEASE, factoryHeldAllocationDevices(LEASE, { "gpu-host": 1 }, LOCAL_AMD_PROFILE));
      const workerId = randomUUID();
      const context = contextFor(workerId, artifactDigest, GPU_CEILING);
      // One host-owned directory per attempt, never shared between two.
      const materialDirectory = join(materialRoot, `seed-${seed}`);
      await prepareMaterialDirectory(materialDirectory);
      let worker: Worker | undefined;
      try {
        worker = (await runner.start(
          { workerId, artifactDigest, context: context as never, limits: GPU_CEILING, devices: grant.devices, materials: materialDirectory },
          async () => { throw new Error("the image guest never reaches the broker"); },
        )) as unknown as Worker;
        const runtime = (await worker.request("extension/invoke", { name: "runtime", input: {}, context })) as { runtime: Record<string, string> };
        observedRuntime = runtime.runtime;
        const generated = (await worker.request("extension/invoke", {
          name: "generate",
          input: {
            seed,
            prompt,
            inferenceSteps: referenceImageLock.generation.inferenceSteps,
            guidance: referenceImageLock.generation.guidanceScale,
            width,
            height,
            dtype: referenceImageLock.generation.dtype,
            device: referenceImageLock.generation.device,
          },
          context,
        })) as { digest: string; bytes: number; runtime: Record<string, string> };
        const rewritten = (await worker.request("extension/invoke", {
          name: "normalize",
          input: { digest: generated.digest, compressLevel: referenceImageLock.normalization.compressLevel },
          context,
        })) as { digest?: string; bytes?: number; error?: { code: string; message: string } };
        if (rewritten.digest === undefined || rewritten.bytes === undefined) {
          throw new Error(`seed ${seed} could not be normalized: ${rewritten.error?.code ?? "unknown"}`);
        }
        const report = (await worker.request("extension/invoke", {
          name: "claims",
          input: claimInput(rewritten.digest, referenceImageLock.generation.width, referenceImageLock.generation.height),
          context,
        })) as { claims: readonly ClaimOutcome[] };

        // The guest writes into its mount and declares what it wrote. Nothing
        // is read back until the worker is confirmed stopped, below.
        const declared = (await worker.request("extension/invoke", {
          name: "emit",
          input: { digest: rewritten.digest, path: VARIANT_MATERIAL_PATH, mediaType: "image/png" },
          context,
        })) as GuestMaterialClaim;
        claims.set(seed, declared);
        records.push({
          seed,
          index,
          outcome: "succeeded",
          attemptId,
          devices: [...grant.devices],
          generated: { digest: generated.digest, bytes: generated.bytes },
          normalized: { digest: rewritten.digest, bytes: rewritten.bytes, sourceDigest: generated.digest },
          claims: report.claims,
          egress: "sealed-from-material-mount",
          runtime: generated.runtime,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
        records.push({
          seed,
          index,
          outcome: "failed",
          attemptId,
          devices: [...grant.devices],
          egress: "not-attempted",
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await worker?.close();
      }

      // Only now, with the worker confirmed stopped, read the mount back.
      const declared = claims.get(seed);
      if (declared !== undefined) {
        const scope: FactoryMaterialScope = { tenantId: "image-tenant", projectId: "image-project", runId: "image-run", attemptId, operationId: `${attemptId}-materials` };
        for (const entry of await sealGuestMaterials({ directory: materialDirectory, claims: [declared], materials: store, scope })) {
          sealed.push({ ...entry, seed });
          await writeFile(join(artifacts, `seed-${seed}.normalized.png`), store.read(entry.artifact));
        }
      }
    }

    // --- one CPU attempt from the same sealed artifact, with an empty grant
    if (withFixtures) {
      const cpuGrant = factoryAttemptDeviceGrant("image-attempt-fixtures", LEASE, factoryHeldAllocationDevices(LEASE, {}, LOCAL_AMD_PROFILE));
      cpuDevices = cpuGrant.devices;
      const workerId = randomUUID();
      const context = contextFor(workerId, artifactDigest, CPU_LIMITS);
      const worker = (await runner.start(
        { workerId, artifactDigest, context: context as never, limits: CPU_LIMITS, devices: cpuGrant.devices },
        async () => { throw new Error("the image guest never reaches the broker"); },
      )) as unknown as Worker;
      try {
        const drawn = (await worker.request("extension/invoke", {
          name: "fixtures",
          input: {
            width: referenceImageLock.generation.width,
            height: referenceImageLock.generation.height,
            scale: 40,
            compressLevel: referenceImageLock.normalization.compressLevel,
          },
          context,
        })) as { caption: { digest: string; bytes: number }; blank: { digest: string; bytes: number } };
        for (const [name, held] of [["sale-caption", drawn.caption], ["blank-control", drawn.blank]] as const) {
          const report = (await worker.request("extension/invoke", {
            name: "claims",
            input: claimInput(held.digest, referenceImageLock.generation.width, referenceImageLock.generation.height),
            context,
          })) as { claims: readonly ClaimOutcome[] };
          const bytes = await fetchImage(worker, context, held.digest, held.bytes);
          await writeFile(join(artifacts, `${name}.png`), bytes);
          fixtures.push({ name, digest: held.digest, bytes: held.bytes, claims: report.claims, egress: "fetched-and-verified" });
        }
      } finally {
        await worker.close();
      }
    }
  } catch (error) {
    // A failure is evidence. Losing everything measured before it would make a
    // partial run indistinguishable from a run that never started.
    fatal = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await runner.close();
  }

  // --- assess the round -------------------------------------------------
  const variants: VariantRecord[] = records.map(record => ({
    index: record.index,
    seed: record.seed,
    generation:
      record.outcome === "succeeded" && record.generated !== undefined
        ? { outcome: "succeeded", digest: record.generated.digest, bytes: record.generated.bytes, runtime: record.runtime ?? {} }
        : { outcome: "failed", error: record.error ?? "MAP_ITEM_FAILED" },
    ...(record.normalized === undefined ? {} : { normalization: record.normalized }),
    ...(record.claims === undefined ? {} : { deterministic: record.claims as never }),
  }));
  const sameSeeds = seeds.length === referenceImageLock.generation.seeds.length && seeds.every((seed, index) => seed === referenceImageLock.generation.seeds[index]);
  let assessment: ReturnType<typeof assessRound> | undefined;
  let assessmentError: string | undefined;
  if (sameSeeds && variants.length === seeds.length) {
    try {
      assessment = assessRound(variants);
    } catch (error) {
      assessmentError = error instanceof Error ? error.message : String(error);
    }
  }

  const report = {
    schemaVersion: "factory.reference-image-journey.v1",
    label,
    startedAt: started,
    completedAt: new Date().toISOString(),
    lockDigest: referenceImageLockDigest(),
    guestImage: referenceImageLock.runtime.guestImage,
    modelRevision: referenceImageLock.model.revision,
    guestSourceDigest: sourceDigest,
    guestArtifactDigest: artifactDigest,
    prompt,
    settings: { seeds, inferenceSteps: referenceImageLock.generation.inferenceSteps, guidance: referenceImageLock.generation.guidanceScale, width, height },
    hostConfiguredDevices: [...LOCAL_AMD_PROFILE.devices],
    cpuAttemptDevices: [...cpuDevices],
    observedRuntime,
    seeds: records,
    fixtures,
    round:
      assessment ??
      {
        note:
          assessmentError ??
          (sameSeeds
            ? `no round selection was made: ${variants.length} variant record(s) for ${seeds.length} seed(s)`
            : "the seeds differ from the recorded set, so no round selection was made"),
      },
    notes,
    ...(fatal === undefined ? {} : { fatal }),
    artifacts,
    egressPolicy: `every variant leaves through the material mount at ${GUEST_MATERIALS_PATH}, walked and opened only through the shared listRunnerMaterials and openRunnerMaterial after the guest stopped, with each digest recomputed from the bytes read back; the control channel's ${1024 ** 2} byte lifetime budget is never the data path`,
    sealedMaterials: sealed.map(entry => ({ seed: entry.seed, path: entry.path, objectName: entry.objectName, digest: entry.digest, bytes: entry.bytes, mediaType: entry.mediaType })),
    materialStore: "in-script; FactoryAttemptMaterials needs a live admitted attempt, and the sealing contract is measured against the real interface in src/factory/reference-image/materials.test.ts",
    productionGpuIsolation: "unmet; see docs/factory-local-gpu.md. This run measures the local AMD profile only.",
    semanticEvaluation: "not executed here; it needs a provider the isolated guest cannot reach and a credential this host does not carry",
  };
  const text = `${JSON.stringify(report, undefined, 2)}\n`;
  if (out) await writeFile(out, text);
  process.stdout.write(text);
  if (fatal !== undefined) return 1;
  const failed = records.filter(record => record.outcome !== "succeeded");
  return failed.length === 0 && records.length === seeds.length ? 0 : 1;
}

process.exitCode = await withGpuLock(main).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  return 1;
});
