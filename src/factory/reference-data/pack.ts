import { randomUUID } from "node:crypto";
import type { InvocationContext, Runner, StartRequest } from "@ezcorp/extension-contract";
import { executionLimits } from "@ezcorp/extension-runner";
import {
  validateFactoryRunnerRequest,
  validateFactoryRunnerResult,
  type FactoryRunnerAuthority,
  type FactoryRunnerRequest,
  type FactoryRunnerResult,
  type JsonValue,
  type RunnerReference,
} from "@ezcorp/factory-sdk";
import type { FactoryAttemptMaterials, FactoryMaterialScope, FactoryScopedArtifactReader } from "../artifact-materials";
import { REFERENCE_DATA_CSV_MEDIA_TYPE, REFERENCE_DATA_LIMITS } from "./csv";
import { FACTORY_REFERENCE_DATA_EXPORTS, type FactoryReferenceDataExport } from "./guest";
import { REFERENCE_DATA_MANIFEST_MEDIA_TYPE, REFERENCE_DATA_MANIFEST_NAME, referenceDataPartitionName } from "./manifest";
import {
  readReferenceDataMaterial,
  ReferenceDataGuestDirectory,
  sealReferenceDataMaterial,
  type ReferenceDataMaterial,
} from "./materials";

/**
 * The `reference.data.v1` journey, as isolated attempts.
 *
 * Each of C10's four graph steps is one real guest execution: a pinned image,
 * a sealed artifact, a fresh per-attempt material directory, one framed
 * `extension/invoke`, and a result the shared C02 contract admits. Nothing here
 * trusts the guest. Every byte it leaves is re-hashed by the host and compared
 * with what the guest said it wrote before it becomes a durable material, and
 * every material the guest reads was streamed out of W04 rather than handed
 * over from the caller.
 *
 * This module does not accept anything. Acceptance rests on the protected
 * reconciliation in `reconcile.ts`, which recomputes every claim from the
 * immutable input and the exported bytes without consulting a single number
 * reported here.
 */

export const REFERENCE_DATA_JSON_MEDIA_TYPE = "application/json";
export const REFERENCE_DATA_PARQUET_MEDIA_TYPE = "application/vnd.apache.parquet";
/** The durable object names this pack writes, in the order it writes them. */
export const REFERENCE_DATA_INPUT_OBJECT = "input.csv";
export const REFERENCE_DATA_SNAPSHOT_OBJECT = "snapshot.json";
export const REFERENCE_DATA_PARTITIONS_OBJECT = "partitions.json";
export const REFERENCE_DATA_DATASET_OBJECT = "dataset.json";

/**
 * The three C02 operations one journey writes into.
 *
 * W04 admits at most `FACTORY_MATERIAL_LIMITS.maxObjectsPerOperation` objects
 * under one operation, and C10's hundred partitions produce three materials
 * each, so a single operation cannot hold a maximum-size run. The split is by
 * graph step, which is what an operation means:
 *
 *   `source`     the immutable input and its snapshot
 *   `partitions` every input partition and the transform's own summary of it
 *   `export`     the published Parquet, the dataset manifest, and the accepted
 *                candidate - everything W08 publishes lives in ONE operation,
 *                because `FactoryS3AcceptedPublication` names exactly one
 */
export const REFERENCE_DATA_OPERATIONS = Object.freeze(["source", "partitions", "export"] as const);
export type ReferenceDataOperation = (typeof REFERENCE_DATA_OPERATIONS)[number];

/** The operation id one step writes under, derived from the journey's base. */
export function referenceDataOperationId(base: string, step: ReferenceDataOperation): string {
  return `${base}:${step}`;
}

export class ReferenceDataPackError extends Error {
  constructor(
    readonly code:
      | "reference_data_attempt_failed"
      | "reference_data_result_invalid"
      | "reference_data_request_invalid"
      | "reference_data_report_invalid"
      | "reference_data_guest_disagrees"
      | "reference_data_unexpected_output",
    message: string,
  ) {
    super(message);
    this.name = "ReferenceDataPackError";
  }
}

/** The pinned guest one journey runs, already built and sealed. */
export interface ReferenceDataRunnerHost {
  readonly runner: Pick<Runner, "start">;
  /** The sealed artifact the build produced. */
  readonly artifactDigest: string;
  /** The compiled definition's runner reference, which every request repeats. */
  readonly reference: RunnerReference;
}

export interface ReferenceDataJourneyOptions {
  readonly host: ReferenceDataRunnerHost;
  readonly materials: Pick<FactoryAttemptMaterials, "begin" | "writeChunk" | "seal">;
  readonly reader: FactoryScopedArtifactReader;
  /** The journey's BASE scope. Each step seals under its own derived operation. */
  readonly scope: FactoryMaterialScope;
  /** The base C02 authority. Each step takes it with its own node instance. */
  readonly authority: Omit<FactoryRunnerAuthority, "nodeInstanceId">;
  /** Where per-attempt directories are created. Defaults to the system temporary root. */
  readonly workRoot?: string;
  readonly now?: () => number;
}

/** One guest attempt: what it was asked, and exactly what it left behind. */
export interface ReferenceDataAttemptRecord {
  readonly export: FactoryReferenceDataExport;
  readonly nodeInstanceId: string;
  readonly requestDigest: string;
  readonly result: FactoryRunnerResult;
  readonly report: Record<string, JsonValue>;
  /** Every file the guest wrote, host-measured. */
  readonly produced: readonly { readonly name: string; readonly digest: string; readonly totalBytes: number }[];
}

/** One partition, from its input slice to its exported Parquet. */
export interface ReferenceDataPartitionRecord {
  readonly index: number;
  readonly partition: ReferenceDataMaterial;
  readonly parquet: ReferenceDataMaterial;
  readonly summary: ReferenceDataMaterial;
  readonly rowCount: number;
}

export interface ReferenceDataJourney {
  readonly input: ReferenceDataMaterial;
  readonly snapshot: ReferenceDataMaterial;
  readonly partitions: readonly ReferenceDataPartitionRecord[];
  readonly manifest: ReferenceDataMaterial;
  readonly dataset: ReferenceDataMaterial;
  readonly attempts: readonly ReferenceDataAttemptRecord[];
}

const encoder = new TextEncoder();

function digestOf(value: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(encoder.encode(value)).digest("hex")}`;
}

/** Bounded, deterministic node identities, so two runs of one input name the same nodes. */
function nodeInstance(step: FactoryReferenceDataExport, index?: number): string {
  return index === undefined ? `reference-data:${step}` : `reference-data:${step}:${String(index).padStart(5, "0")}`;
}

/**
 * Runs one export as a real isolated attempt.
 *
 * The request is validated before it leaves the host and the result is
 * validated before anything reads it, so a guest that answers with a shape the
 * host would have to reject fails here rather than downstream.
 */
export async function dispatchReferenceDataAttempt(
  options: ReferenceDataJourneyOptions,
  step: FactoryReferenceDataExport,
  nodeInstanceId: string,
  command: Record<string, JsonValue>,
  directory: ReferenceDataGuestDirectory,
): Promise<ReferenceDataAttemptRecord> {
  const now = options.now ?? Date.now;
  const workerId = randomUUID();
  const request: FactoryRunnerRequest = {
    schemaVersion: "factory.runner.request.v1",
    authority: { ...options.authority, nodeInstanceId },
    runner: { ...options.host.reference, export: step },
    input: { kind: "inline", value: command },
    grants: [],
    resources: {},
    tools: [],
    broker: { attemptToken: `reference-data-${workerId}`, audience: "gateway" },
  };
  const requestIssues = validateFactoryRunnerRequest(request);
  if (!requestIssues.ok) throw new ReferenceDataPackError("reference_data_request_invalid", `The ${step} request is not admissible: ${requestIssues.issues.map(issue => issue.code).join(",")}.`);

  const context: InvocationContext = {
    invocationId: randomUUID(),
    workerId,
    releaseId: options.host.artifactDigest,
    principalId: options.authority.tenantId,
    scopeId: options.authority.projectId,
    token: request.broker.attemptToken,
    deadline: Math.min(options.authority.deadlineAtMs, now() + executionLimits.timeoutMs - 1_000),
  };
  const start: StartRequest = { workerId, artifactDigest: options.host.artifactDigest, context, limits: executionLimits, devices: [], materials: directory.root };
  const worker = await options.host.runner.start(start, async () => {
    // The guest has no reverse capability in this pack. Every byte moves
    // through the material directory, so a frame here is a defect.
    throw new ReferenceDataPackError("reference_data_unexpected_output", "The reference data guest requested a reverse capability it does not have.");
  });
  let value: unknown;
  try {
    value = await worker.request("extension/invoke", { name: step, input: request, context });
  } finally {
    await worker.close();
  }
  const resultIssues = validateFactoryRunnerResult(value);
  if (!resultIssues.ok) throw new ReferenceDataPackError("reference_data_result_invalid", `The ${step} guest answered with a result the contract refuses: ${resultIssues.issues.map(issue => issue.code).join(",")}.`);
  const result = value as FactoryRunnerResult;
  if (result.status !== "completed") {
    const reason = result.status === "failed" ? `${result.error.code}: ${result.error.message}` : result.status;
    throw new ReferenceDataPackError("reference_data_attempt_failed", `The ${step} attempt did not complete (${reason}).`);
  }

  const produced: Array<{ name: string; digest: string; totalBytes: number }> = [];
  for (const name of await directory.produced()) {
    const path = ReferenceDataGuestDirectory.output(name);
    const measured = await measure(directory, path);
    produced.push({ name: path, digest: measured.digest, totalBytes: measured.totalBytes });
  }
  const reportName = String(command.report);
  const reportEntry = produced.find(entry => entry.name === reportName);
  if (!reportEntry) throw new ReferenceDataPackError("reference_data_report_invalid", `The ${step} guest left no ${reportName}.`);
  if (reportEntry.digest !== result.output.digest || reportEntry.totalBytes !== result.output.encodedBytes) {
    throw new ReferenceDataPackError("reference_data_guest_disagrees", `The ${step} guest reported ${result.output.digest}/${result.output.encodedBytes} for its report and the bytes measure ${reportEntry.digest}/${reportEntry.totalBytes}.`);
  }
  let report: Record<string, JsonValue>;
  try {
    report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await concat(directory.collect(reportName)))) as Record<string, JsonValue>;
  } catch {
    throw new ReferenceDataPackError("reference_data_report_invalid", `The ${step} report is not readable JSON.`);
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new ReferenceDataPackError("reference_data_report_invalid", `The ${step} report is not an object.`);

  return Object.freeze({
    export: step,
    nodeInstanceId,
    requestDigest: digestOf(JSON.stringify(request)),
    result,
    report,
    produced: Object.freeze(produced),
  });
}

async function concat(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const blocks: Uint8Array[] = [];
  let total = 0;
  for await (const block of source) {
    blocks.push(block);
    total += block.byteLength;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    joined.set(block, offset);
    offset += block.byteLength;
  }
  return joined;
}

async function measure(directory: ReferenceDataGuestDirectory, name: string): Promise<{ digest: string; totalBytes: number }> {
  const hasher = new Bun.CryptoHasher("sha256");
  let totalBytes = 0;
  for await (const block of directory.collect(name)) {
    hasher.update(block);
    totalBytes += block.byteLength;
  }
  return { digest: `sha256:${hasher.digest("hex")}`, totalBytes };
}

/** What a guest said about one file it wrote. Every field is re-measured before it is believed. */
interface ReportedFile {
  readonly name: string;
  readonly digest: string;
  readonly encodedBytes: number;
}

function reportedFile(report: Record<string, JsonValue>, key: string, step: string): ReportedFile {
  const entry = report[key];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ReferenceDataPackError("reference_data_report_invalid", `The ${step} report names no ${key}.`);
  const file = entry as Record<string, JsonValue>;
  if (typeof file.name !== "string" || typeof file.digest !== "string" || typeof file.encodedBytes !== "number") throw new ReferenceDataPackError("reference_data_report_invalid", `The ${step} report's ${key} is not {name,digest,encodedBytes}.`);
  return { name: file.name, digest: file.digest, encodedBytes: file.encodedBytes };
}

/** Seals one file the guest wrote, after the HOST has re-measured it. */
async function sealProduced(
  options: ReferenceDataJourneyOptions,
  directory: ReferenceDataGuestDirectory,
  attempt: ReferenceDataAttemptRecord,
  guestName: string,
  objectName: string,
  mediaType: string,
  operation: ReferenceDataOperation,
  expected: { readonly digest: string; readonly encodedBytes: number },
): Promise<ReferenceDataMaterial> {
  const measured = attempt.produced.find(entry => entry.name === guestName);
  if (!measured) throw new ReferenceDataPackError("reference_data_report_invalid", `The ${attempt.export} guest left no ${guestName}.`);
  if (measured.digest !== expected.digest || measured.totalBytes !== expected.encodedBytes) {
    throw new ReferenceDataPackError("reference_data_guest_disagrees", `The ${attempt.export} guest reported ${expected.digest}/${expected.encodedBytes} for ${guestName} and the bytes measure ${measured.digest}/${measured.totalBytes}.`);
  }
  const identity = { ...scopeFor(options, operation), objectName, version: 1 };
  const sealedMaterial = await sealReferenceDataMaterial(options.materials, identity, mediaType, measured.totalBytes, directory.collect(guestName));
  if (sealedMaterial.digest !== measured.digest) throw new ReferenceDataPackError("reference_data_guest_disagrees", `${objectName} sealed as ${sealedMaterial.digest} and measured ${measured.digest}.`);
  return sealedMaterial;
}

/**
 * Runs C10's whole graph for one immutable input.
 *
 * The input is sealed FIRST, before anything expands it, and every later step
 * reads it back out of that durable copy rather than from the caller's stream.
 * That is what makes "correcting the input creates a new snapshot and run"
 * enforceable: the bytes a run was decided against cannot be re-supplied.
 */
export async function runReferenceDataJourney(options: ReferenceDataJourneyOptions, input: () => AsyncIterable<Uint8Array>, sourceVersion: string): Promise<ReferenceDataJourney> {
  const attempts: ReferenceDataAttemptRecord[] = [];
  const measured = await measureStream(input());
  const sealedInput = await sealReferenceDataMaterial(options.materials, { ...scopeFor(options, "source"), objectName: REFERENCE_DATA_INPUT_OBJECT, version: 1 }, REFERENCE_DATA_CSV_MEDIA_TYPE, measured.totalBytes, input());

  const snapshotAttempt = await withDirectory(options, async directory => {
    await directory.stage(ReferenceDataGuestDirectory.input(REFERENCE_DATA_INPUT_OBJECT), readReferenceDataMaterial(options.reader, options.scope, sealedInput));
    return {
      directory,
      attempt: await dispatchReferenceDataAttempt(options, "snapshotCsv", nodeInstance("snapshotCsv"), {
        kind: "snapshotCsv",
        input: ReferenceDataGuestDirectory.input(REFERENCE_DATA_INPUT_OBJECT),
        sourceVersion,
        report: ReferenceDataGuestDirectory.output(REFERENCE_DATA_SNAPSHOT_OBJECT),
      }, directory),
    };
  });
  attempts.push(snapshotAttempt.attempt);
  // The guest hashed the bytes it was actually given. A disagreement with the
  // sealed material means the two are not the same bytes, which is the one
  // thing a snapshot exists to rule out.
  if (snapshotAttempt.attempt.report.digest !== sealedInput.digest || snapshotAttempt.attempt.report.totalBytes !== sealedInput.totalBytes) {
    throw new ReferenceDataPackError("reference_data_guest_disagrees", `The snapshot guest measured ${String(snapshotAttempt.attempt.report.digest)} and the sealed input is ${sealedInput.digest}.`);
  }
  const snapshot = await sealReferenceDataMaterial(
    options.materials,
    { ...scopeFor(options, "source"), objectName: REFERENCE_DATA_SNAPSHOT_OBJECT, version: 1 },
    REFERENCE_DATA_JSON_MEDIA_TYPE,
    snapshotAttempt.attempt.result.status === "completed" ? snapshotAttempt.attempt.result.output.encodedBytes : 0,
    snapshotAttempt.directory.collect(ReferenceDataGuestDirectory.output(REFERENCE_DATA_SNAPSHOT_OBJECT)),
  );
  await snapshotAttempt.directory.dispose();

  const parse = await withDirectory(options, async directory => {
    await directory.stage(ReferenceDataGuestDirectory.input(REFERENCE_DATA_INPUT_OBJECT), readReferenceDataMaterial(options.reader, options.scope, sealedInput));
    return {
      directory,
      attempt: await dispatchReferenceDataAttempt(options, "parseCsv", nodeInstance("parseCsv"), {
        kind: "parseCsv",
        input: ReferenceDataGuestDirectory.input(REFERENCE_DATA_INPUT_OBJECT),
        outputPrefix: `${ReferenceDataGuestDirectory.output("")}`,
        snapshotDigest: sealedInput.digest,
        report: ReferenceDataGuestDirectory.output(REFERENCE_DATA_PARTITIONS_OBJECT),
      }, directory),
    };
  });
  attempts.push(parse.attempt);
  const declared = parse.attempt.report.partitions;
  if (!Array.isArray(declared) || declared.length === 0 || declared.length > REFERENCE_DATA_LIMITS.maxPartitions) {
    throw new ReferenceDataPackError("reference_data_report_invalid", `The parse step declared ${Array.isArray(declared) ? declared.length : 0} partition(s).`);
  }
  const partitionMaterials: ReferenceDataMaterial[] = [];
  const declaredRows: number[] = [];
  for (const [index, entry] of declared.entries()) {
    const partition = entry as Record<string, JsonValue>;
    if (partition.index !== index || typeof partition.rowCount !== "number" || typeof partition.name !== "string" || typeof partition.digest !== "string" || typeof partition.encodedBytes !== "number") {
      throw new ReferenceDataPackError("reference_data_report_invalid", `Partition ${index} is not the declared shape.`);
    }
    declaredRows.push(partition.rowCount);
    partitionMaterials.push(
      await sealProduced(options, parse.directory, parse.attempt, partition.name, `partition-${String(index).padStart(5, "0")}.csv`, REFERENCE_DATA_CSV_MEDIA_TYPE, "partitions", {
        digest: partition.digest,
        encodedBytes: partition.encodedBytes,
      }),
    );
  }
  await parse.directory.dispose();

  const partitions: ReferenceDataPartitionRecord[] = [];
  for (const [index, partitionMaterial] of partitionMaterials.entries()) {
    const staged = ReferenceDataGuestDirectory.input(`partition-${String(index).padStart(5, "0")}.csv`);
    const transform = await withDirectory(options, async directory => {
      await directory.stage(staged, readReferenceDataMaterial(options.reader, options.scope, partitionMaterial));
      return {
        directory,
        attempt: await dispatchReferenceDataAttempt(options, "transformPartition", nodeInstance("transformPartition", index), {
          kind: "transformPartition",
          input: staged,
          output: ReferenceDataGuestDirectory.output(referenceDataPartitionName(index)),
          partitionIndex: index,
          firstRowIndex: declaredRows.slice(0, index).reduce((sum, count) => sum + count, 0),
          partitionDigest: partitionMaterial.digest,
          report: ReferenceDataGuestDirectory.output(`part-${String(index).padStart(5, "0")}.summary.json`),
        }, directory),
      };
    });
    attempts.push(transform.attempt);
    const parquet = await sealProduced(options, transform.directory, transform.attempt, ReferenceDataGuestDirectory.output(referenceDataPartitionName(index)), referenceDataPartitionName(index), REFERENCE_DATA_PARQUET_MEDIA_TYPE, "export", reportedFile(transform.attempt.report, "file", "transformPartition"));
    const summaryName = `part-${String(index).padStart(5, "0")}.summary.json`;
    const summary = await sealReferenceDataMaterial(
      options.materials,
      { ...scopeFor(options, "partitions"), objectName: summaryName, version: 1 },
      REFERENCE_DATA_JSON_MEDIA_TYPE,
      transform.attempt.result.status === "completed" ? transform.attempt.result.output.encodedBytes : 0,
      transform.directory.collect(ReferenceDataGuestDirectory.output(summaryName)),
    );
    await transform.directory.dispose();
    partitions.push(Object.freeze({ index, partition: partitionMaterial, parquet, summary, rowCount: declaredRows[index] as number }));
  }

  const reduce = await withDirectory(options, async directory => {
    const reports: string[] = [];
    for (const record of partitions) {
      const name = ReferenceDataGuestDirectory.input(record.summary.objectName);
      await directory.stage(name, readReferenceDataMaterial(options.reader, options.scope, record.summary));
      reports.push(name);
    }
    return {
      directory,
      attempt: await dispatchReferenceDataAttempt(options, "orderedReduce", nodeInstance("orderedReduce"), {
        kind: "orderedReduce",
        reports,
        snapshotDigest: sealedInput.digest,
        snapshotBytes: sealedInput.totalBytes,
        output: ReferenceDataGuestDirectory.output(REFERENCE_DATA_MANIFEST_NAME),
        report: ReferenceDataGuestDirectory.output(REFERENCE_DATA_DATASET_OBJECT),
      }, directory),
    };
  });
  attempts.push(reduce.attempt);
  const manifest = await sealProduced(options, reduce.directory, reduce.attempt, ReferenceDataGuestDirectory.output(REFERENCE_DATA_MANIFEST_NAME), REFERENCE_DATA_MANIFEST_NAME, REFERENCE_DATA_MANIFEST_MEDIA_TYPE, "export", reportedFile(reduce.attempt.report, "file", "orderedReduce"));
  const dataset = await sealReferenceDataMaterial(
    options.materials,
    { ...scopeFor(options, "export"), objectName: REFERENCE_DATA_DATASET_OBJECT, version: 1 },
    REFERENCE_DATA_JSON_MEDIA_TYPE,
    reduce.attempt.result.status === "completed" ? reduce.attempt.result.output.encodedBytes : 0,
    reduce.directory.collect(ReferenceDataGuestDirectory.output(REFERENCE_DATA_DATASET_OBJECT)),
  );
  await reduce.directory.dispose();

  return Object.freeze({ input: sealedInput, snapshot, partitions: Object.freeze(partitions), manifest, dataset, attempts: Object.freeze(attempts) });
}

/** The scope one step seals and reads under. */
function scopeFor(options: ReferenceDataJourneyOptions, operation: ReferenceDataOperation): FactoryMaterialScope {
  return { ...options.scope, operationId: referenceDataOperationId(options.scope.operationId, operation) };
}

async function withDirectory<Result extends { directory: ReferenceDataGuestDirectory }>(options: ReferenceDataJourneyOptions, run: (directory: ReferenceDataGuestDirectory) => Promise<Result>): Promise<Result> {
  const directory = await ReferenceDataGuestDirectory.create(options.workRoot);
  try {
    return await run(directory);
  } catch (error) {
    await directory.dispose();
    throw error;
  }
}

async function measureStream(source: AsyncIterable<Uint8Array>): Promise<{ totalBytes: number }> {
  let totalBytes = 0;
  for await (const block of source) totalBytes += block.byteLength;
  return { totalBytes };
}

/** Every export the compiled definition binds, for a caller that wants to check its own wiring. */
export const REFERENCE_DATA_STEPS: readonly FactoryReferenceDataExport[] = FACTORY_REFERENCE_DATA_EXPORTS;
