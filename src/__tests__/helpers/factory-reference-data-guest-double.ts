import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReverseRpc, Runner, RunnerExecution, StartRequest } from "@ezcorp/extension-contract";
import type { FactoryRunnerRequest, JsonValue } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../../db/migrations/types";
import type { FactoryReferenceDataExport } from "../../factory/reference-data/guest";
import type { ReferenceDataJourneyOptions } from "../../factory/reference-data/pack";
import { referenceDataMaterialsWorld } from "./factory-reference-data-world";

/**
 * A stand-in for the pinned PyArrow guest, for suites that must run where the
 * data image is absent (every hosted coverage shard).
 *
 * It honours the same file protocol as the real guest: it reads the inputs the
 * host staged in the flat material directory, writes its outputs and its report
 * beside them as a separate user would (mode 0644), and answers the framed
 * invoke with a C02 result whose output is the report. It does not write real
 * Parquet; a transform output is the partition's CSV between `PAR1` markers,
 * which is enough for the host, because the host only measures and seals it.
 * `src/factory/reference-data/journey.integration.test.ts` runs the real guest.
 */

const encoder = new TextEncoder();

export function referenceDataDigest(bytes: Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
}

/** A completed C02 result whose output is exactly `report`. */
export function completedReferenceDataResult(report: Uint8Array): JsonValue {
  return {
    schemaVersion: "factory.runner.result.v1",
    status: "completed",
    journalCursor: -1,
    operations: [],
    resultDigest: referenceDataDigest(report).slice("sha256:".length),
    output: { artifactId: "report.json", digest: referenceDataDigest(report), encodedBytes: report.byteLength },
    usage: { kind: "measured", inputTokens: 0, outputTokens: 0, computeMs: 1, costMicros: "0" },
    workspaceCheckpoint: { artifactId: "report.json.checkpoint", digest: referenceDataDigest(report), encodedBytes: report.byteLength, journalCursor: -1 },
  } as unknown as JsonValue;
}

/** One step as the guest saw it: its command, and the directory it wrote into. */
export interface ReferenceDataGuestStep {
  readonly step: FactoryReferenceDataExport;
  readonly command: Record<string, JsonValue>;
  readonly root: string;
}

export interface ReferenceDataGuestDoubleOptions {
  /** Rows per partition the parse step cuts. */
  readonly rowsPerPartition?: number;
  /**
   * Runs after the honest outputs are written and before the guest answers.
   * A test corrupts a file, rewrites a report, or throws (a guest that dies
   * mid-invocation) here.
   */
  readonly after?: (step: ReferenceDataGuestStep) => Promise<void> | void;
}

/**
 * Writes a file as the guest would: straight into the flat material directory,
 * not through `stage`, which records a name as the host's input and therefore
 * excludes it from `produced()`.
 */
export async function referenceDataGuestWrite(root: string, name: string, bytes: Uint8Array): Promise<{ name: string; digest: string; encodedBytes: number }> {
  await writeFile(join(root, name), bytes);
  await chmod(join(root, name), 0o644);
  return { name, digest: referenceDataDigest(bytes), encodedBytes: bytes.byteLength };
}

/** Rewrites one step's report, keeping the C02 result's claim about it consistent with what the guest answers. */
export async function referenceDataRewriteReport(step: ReferenceDataGuestStep, edit: (report: Record<string, JsonValue>) => JsonValue): Promise<void> {
  const name = String(step.command.report);
  const report = JSON.parse(await readFile(join(step.root, name), "utf8")) as Record<string, JsonValue>;
  await referenceDataGuestWrite(step.root, name, encoder.encode(JSON.stringify(edit(report))));
}

async function run(step: FactoryReferenceDataExport, command: Record<string, JsonValue>, root: string, rowsPerPartition: number): Promise<Record<string, JsonValue>> {
  const read = (name: JsonValue | undefined) => readFile(join(root, String(name)));
  switch (step) {
    case "snapshotCsv": {
      const bytes = new Uint8Array(await read(command.input));
      return { digest: referenceDataDigest(bytes), totalBytes: bytes.byteLength, sourceVersion: command.sourceVersion ?? null };
    }
    case "parseCsv": {
      const [header, ...rows] = (await read(command.input)).toString("utf8").split("\n").filter(line => line.length > 0);
      const partitions: JsonValue[] = [];
      for (let index = 0; index * rowsPerPartition < rows.length; index += 1) {
        const slice = rows.slice(index * rowsPerPartition, (index + 1) * rowsPerPartition);
        const file = await referenceDataGuestWrite(root, `${String(command.outputPrefix)}slice-${String(index).padStart(5, "0")}.csv`, encoder.encode(`${header}\n${slice.join("\n")}\n`));
        partitions.push({ index, rowCount: slice.length, ...file });
      }
      return { partitions };
    }
    case "transformPartition": {
      const csv = (await read(command.input)).toString("utf8");
      const file = await referenceDataGuestWrite(root, String(command.output), encoder.encode(`PAR1${csv}PAR1`));
      return { partitionIndex: command.partitionIndex ?? null, firstRowIndex: command.firstRowIndex ?? null, rowCount: csv.trimEnd().split("\n").length - 1, file };
    }
    case "orderedReduce": {
      const reports = command.reports as string[];
      const summaries = await Promise.all(reports.map(async name => JSON.parse((await read(name)).toString("utf8")) as Record<string, JsonValue>));
      const rowCount = summaries.reduce((sum, summary) => sum + Number(summary.rowCount), 0);
      const manifest = encoder.encode(JSON.stringify({ rowCount, partitions: summaries.length, source: { digest: command.snapshotDigest ?? null, totalBytes: command.snapshotBytes ?? null } }));
      return { rowCount, file: await referenceDataGuestWrite(root, String(command.output), manifest) };
    }
  }
}

/**
 * A runner whose every start is one honest guest attempt, plus a count of the
 * workers it started and closed so a suite can prove nothing was left open.
 */
export function referenceDataGuestDouble(options: ReferenceDataGuestDoubleOptions = {}) {
  const steps: ReferenceDataGuestStep[] = [];
  let started = 0;
  let closed = 0;
  const runner: Pick<Runner, "start"> = {
    async start(input: StartRequest, _reverseRpc: ReverseRpc): Promise<RunnerExecution> {
      started += 1;
      const root = String(input.materials);
      return {
        workerId: input.workerId,
        async request(_method: string, params: unknown) {
          const { name, input: request } = params as { name: FactoryReferenceDataExport; input: FactoryRunnerRequest };
          const command = (request.input as { value: Record<string, JsonValue> }).value;
          const report = await run(name, command, root, options.rowsPerPartition ?? 2);
          await referenceDataGuestWrite(root, String(command.report), encoder.encode(JSON.stringify(report)));
          const step = { step: name, command, root };
          steps.push(step);
          await options.after?.(step);
          return completedReferenceDataResult(new Uint8Array(await readFile(join(root, String(command.report)))));
        },
        async close() {
          closed += 1;
        },
        onNotification: () => () => {},
      };
    },
  };
  return { runner, steps, started: () => started, closed: () => closed };
}

/** The caller's input stream, as a journey takes it. */
export async function* referenceDataInput(text: string): AsyncGenerator<Uint8Array> {
  yield encoder.encode(text);
}

/** A fresh W04 world in `db` whose journey options dispatch to a guest double. */
export async function referenceDataDoubleWorld(db: TransactionalDb, track: (directory: string) => void, guest: ReferenceDataGuestDoubleOptions = {}) {
  const base = await referenceDataMaterialsWorld({ db }, track);
  const double = referenceDataGuestDouble(guest);
  const options: ReferenceDataJourneyOptions = {
    host: {
      runner: double.runner,
      artifactDigest: "f".repeat(64),
      reference: { package: "@ezcorp/reference-data", manifestName: "reference-data", version: "1.0.0", digest: `sha256:${"b".repeat(64)}`, export: "snapshotCsv" },
    },
    materials: base.materials, reader: base.reader, scope: base.scope, authority: base.authority, workRoot: base.workRoot,
  };
  return { ...base, options, double };
}
