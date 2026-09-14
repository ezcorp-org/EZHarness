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
 * That cap is why nothing here moves a full variant to the host. Generation,
 * normalization, and every byte-level and OCR claim happen inside the guest that
 * holds the bytes, and only digests, sizes, and claim verdicts come back. A
 * variant small enough to fit the remaining budget is also fetched, which proves
 * the chunked transfer and its digest binding; a variant at the contract's
 * 1,024-pixel size is not, and is recorded as deferred rather than silently
 * skipped. Publishing those exact bytes needs a large-artifact egress path the
 * platform does not have for an isolated guest; the gate file records it.
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
import { mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResourceLimits } from "@ezcorp/extension-contract";
import { buildLimits, filesDigest, PythonPodmanRunner } from "@ezcorp/extension-runner";

import { referenceImageGuestFiles, REFERENCE_IMAGE_GUEST_ENTRYPOINT, referenceImageRunnerClosure } from "../src/factory/reference-image/closure.ts";
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

/**
 * The raw bytes one attempt may fetch out before its lifetime control budget
 * runs out. The runner allows a mebibyte of output per worker in total, base64
 * costs four bytes for every three, and the attempt's own small answers take
 * some of it, so the usable payload is well under three quarters of a mebibyte.
 */
const EGRESS_BUDGET = 600 * 1024;

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
type Egress = "fetched-and-verified" | "deferred-over-budget" | "not-attempted";

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
  const closure = await referenceImageRunnerClosure();
  const files = await referenceImageGuestFiles();
  const sourceDigest = filesDigest(files);
  const started = new Date().toISOString();
  const records: SeedRecord[] = [];
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
      let worker: Worker | undefined;
      try {
        worker = (await runner.start(
          { workerId, artifactDigest, context: context as never, limits: GPU_CEILING, devices: grant.devices },
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

        let egress: Egress = "deferred-over-budget";
        if (rewritten.bytes <= EGRESS_BUDGET) {
          const bytes = await fetchImage(worker, context, rewritten.digest, rewritten.bytes);
          await writeFile(join(artifacts, `seed-${seed}.normalized.png`), bytes);
          egress = "fetched-and-verified";
        }
        records.push({
          seed,
          index,
          outcome: "succeeded",
          attemptId,
          devices: [...grant.devices],
          generated: { digest: generated.digest, bytes: generated.bytes },
          normalized: { digest: rewritten.digest, bytes: rewritten.bytes, sourceDigest: generated.digest },
          claims: report.claims,
          egress,
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
          const bytes = held.bytes <= EGRESS_BUDGET ? await fetchImage(worker, context, held.digest, held.bytes) : undefined;
          if (bytes !== undefined) await writeFile(join(artifacts, `${name}.png`), bytes);
          fixtures.push({ name, digest: held.digest, bytes: held.bytes, claims: report.claims, egress: bytes === undefined ? "deferred-over-budget" : "fetched-and-verified" });
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
    egressPolicy: `a worker may emit ${1024 ** 2} bytes of control output in its whole life, so a variant above ${EGRESS_BUDGET} raw bytes stays in the guest and is recorded by digest`,
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
