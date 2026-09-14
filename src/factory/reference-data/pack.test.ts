import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReverseRpc, Runner, RunnerExecution, StartRequest } from "@ezcorp/extension-contract";
import type { FactoryRunnerAuthority, JsonValue, RunnerReference } from "@ezcorp/factory-sdk";
import type { FactoryMaterialScope, FactoryScopedArtifactReader } from "../artifact-materials";
import { ReferenceDataGuestDirectory } from "./materials";
import { dispatchReferenceDataAttempt, ReferenceDataPackError, REFERENCE_DATA_STEPS, type ReferenceDataJourneyOptions } from "./pack";

/**
 * How one attempt is dispatched, and what happens when the guest does not hold
 * up its end.
 *
 * The whole journey against a real guest is proved by
 * `journey.integration.test.ts`. These cases drive the seam with a guest double
 * so every refusal has a case: a request the contract would not admit, a result
 * it would not admit, a result that did not complete, a report that is not
 * there, a report whose bytes do not match what the guest said, and a guest
 * that asks for a reverse capability it does not have.
 */

const SCOPE: FactoryMaterialScope = { tenantId: "tenant", projectId: "project", runId: "run", attemptId: "attempt", operationId: "operation" };
const REFERENCE: RunnerReference = { package: "@ezcorp/reference-data", manifestName: "reference-data", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, export: "snapshotCsv" };
const AUTHORITY: Omit<FactoryRunnerAuthority, "nodeInstanceId"> = {
  attemptId: "attempt", tenantId: "tenant", projectId: "project", runId: "run", candidateGeneration: 0, attemptNumber: 1,
  grantRevision: 1, reservationGeneration: 1, executionEpoch: 6, cancellationEpoch: 0, deadlineAtMs: 4_000_000_000_000, nextOperationIndex: 0,
};

const reader: FactoryScopedArtifactReader = {
  async read(): Promise<Uint8Array> {
    throw new Error("unused");
  },
  async readChunk(): Promise<Uint8Array> {
    throw new Error("unused");
  },
};

const materials = {
  async begin(): Promise<never> {
    throw new Error("unused");
  },
  async writeChunk(): Promise<never> {
    throw new Error("unused");
  },
  async seal(): Promise<never> {
    throw new Error("unused");
  },
} as unknown as ReferenceDataJourneyOptions["materials"];

function digestOf(bytes: Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
}

/** A guest double. `answer` decides what the framed invoke returns. */
function host(answer: (request: unknown) => unknown, options: { reverse?: boolean } = {}) {
  const starts: StartRequest[] = [];
  let closed = 0;
  const runner: Pick<Runner, "start"> = {
    async start(input: StartRequest, reverseRpc: ReverseRpc): Promise<RunnerExecution> {
      starts.push(input);
      if (options.reverse) await reverseRpc("factory.broker", { context: input.context, input: {} }).catch((error: unknown) => { throw error; });
      return {
        workerId: input.workerId,
        async request(_method: string, params: unknown) {
          return answer(params);
        },
        async close() {
          closed += 1;
        },
        onNotification: () => () => {},
      };
    },
  };
  return { runner, starts, closed: () => closed };
}

function optionsFor(runner: Pick<Runner, "start">, workRoot: string): ReferenceDataJourneyOptions {
  return { host: { runner, artifactDigest: "f".repeat(64), reference: REFERENCE }, materials, reader, scope: SCOPE, authority: AUTHORITY, workRoot };
}

function completed(report: Uint8Array): JsonValue {
  return {
    schemaVersion: "factory.runner.result.v1",
    status: "completed",
    journalCursor: -1,
    operations: [],
    resultDigest: digestOf(report).slice("sha256:".length),
    output: { artifactId: "report.json", digest: digestOf(report), encodedBytes: report.byteLength },
    usage: { kind: "measured", inputTokens: 0, outputTokens: 0, computeMs: 1, costMicros: "0" },
    workspaceCheckpoint: { artifactId: "report.json.checkpoint", digest: digestOf(report), encodedBytes: report.byteLength, journalCursor: -1 },
  } as unknown as JsonValue;
}

async function withDirectory<Result>(run: (directory: ReferenceDataGuestDirectory, workRoot: string) => Promise<Result>): Promise<Result> {
  const workRoot = await mkdtemp(join(tmpdir(), "refdata-pack-"));
  const directory = await ReferenceDataGuestDirectory.create(workRoot);
  try {
    return await run(directory, workRoot);
  } finally {
    await directory.dispose();
    await rm(workRoot, { recursive: true, force: true });
  }
}

const command = (report: string) => ({ kind: "snapshotCsv", input: "in/source.csv", sourceVersion: "v1", report }) as unknown as Record<string, JsonValue>;

test("a completed attempt carries its own material directory and returns the report the guest wrote", async () => {
  await withDirectory(async (directory, workRoot) => {
    const report = new TextEncoder().encode(JSON.stringify({ digest: `sha256:${"1".repeat(64)}`, totalBytes: 7 }));
    await directory.stage(ReferenceDataGuestDirectory.output("report.json"), (async function* () { yield report; })());
    const world = host(() => completed(report));
    const attempt = await dispatchReferenceDataAttempt(optionsFor(world.runner, workRoot), "snapshotCsv", "node-a", command(ReferenceDataGuestDirectory.output("report.json")), directory);
    expect(attempt.export).toBe("snapshotCsv");
    expect(attempt.nodeInstanceId).toBe("node-a");
    expect(attempt.report).toEqual({ digest: `sha256:${"1".repeat(64)}`, totalBytes: 7 });
    expect(attempt.produced.map(entry => entry.name)).toEqual([ReferenceDataGuestDirectory.output("report.json")]);
    expect(attempt.requestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The attempt really was given its own directory, read-write, and nothing else.
    expect(world.starts[0]?.materials).toBe(directory.root);
    expect(world.starts[0]?.devices).toEqual([]);
    expect(world.closed()).toBe(1);
  });
});

test("a request the shared contract would not admit never reaches a guest", async () => {
  await withDirectory(async (directory, workRoot) => {
    const world = host(() => completed(new Uint8Array([1])));
    const options = { ...optionsFor(world.runner, workRoot), authority: { ...AUTHORITY, nextOperationIndex: 5 } };
    await expect(dispatchReferenceDataAttempt(options, "snapshotCsv", "node-a", command("out/report.json"), directory)).rejects.toMatchObject({ code: "reference_data_request_invalid" });
    expect(world.starts).toEqual([]);
  });
});

test("a result the shared contract would not admit is refused before anything reads it", async () => {
  await withDirectory(async (directory, workRoot) => {
    const world = host(() => ({ schemaVersion: "factory.runner.result.v1", status: "completed" }));
    await expect(dispatchReferenceDataAttempt(optionsFor(world.runner, workRoot), "snapshotCsv", "node-a", command("out/report.json"), directory)).rejects.toMatchObject({ code: "reference_data_result_invalid" });
    expect(world.closed()).toBe(1);
  });
});

test("an attempt that did not complete carries the guest's own reason", async () => {
  await withDirectory(async (directory, workRoot) => {
    const failed = {
      schemaVersion: "factory.runner.result.v1", status: "failed", journalCursor: -1, operations: [],
      resultDigest: "a".repeat(64), error: { code: "amount_overflow", message: "line 2", retryable: false },
    };
    const world = host(() => failed);
    const failure = await dispatchReferenceDataAttempt(optionsFor(world.runner, workRoot), "snapshotCsv", "node-a", command("out/report.json"), directory).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "reference_data_attempt_failed" });
    expect((failure as Error).message).toContain("amount_overflow");
  });
});

test("a report the guest did not write, or wrote differently than it said, is refused", async () => {
  await withDirectory(async (directory, workRoot) => {
    const claimed = new TextEncoder().encode(JSON.stringify({ a: 1 }));
    const absent = host(() => completed(claimed));
    await expect(dispatchReferenceDataAttempt(optionsFor(absent.runner, workRoot), "snapshotCsv", "node-a", command("out/report.json"), directory)).rejects.toMatchObject({ code: "reference_data_report_invalid" });

    // Different bytes than the guest reported.
    await directory.stage(ReferenceDataGuestDirectory.output("report.json"), (async function* () { yield new TextEncoder().encode(JSON.stringify({ a: 2 })); })());
    const lying = host(() => completed(claimed));
    await expect(dispatchReferenceDataAttempt(optionsFor(lying.runner, workRoot), "snapshotCsv", "node-a", command("out/report.json"), directory)).rejects.toMatchObject({ code: "reference_data_guest_disagrees" });
  });
});

test("a report that is not readable JSON, or not an object, is refused", async () => {
  for (const payload of ["{not json", "[1,2,3]", "\"text\""]) {
    await withDirectory(async (directory, workRoot) => {
      const bytes = new TextEncoder().encode(payload);
      await directory.stage(ReferenceDataGuestDirectory.output("report.json"), (async function* () { yield bytes; })());
      const world = host(() => completed(bytes));
      await expect(dispatchReferenceDataAttempt(optionsFor(world.runner, workRoot), "snapshotCsv", "node-a", command("out/report.json"), directory)).rejects.toMatchObject({ code: "reference_data_report_invalid" });
    });
  }
});

test("a guest that asks for a reverse capability it does not have is refused", async () => {
  await withDirectory(async (directory, workRoot) => {
    const world = host(() => completed(new Uint8Array([1])), { reverse: true });
    await expect(dispatchReferenceDataAttempt(optionsFor(world.runner, workRoot), "snapshotCsv", "node-a", command("out/report.json"), directory)).rejects.toMatchObject({ code: "reference_data_unexpected_output" });
  });
});

test("the node instance of every step is deterministic, so two runs name the same nodes", async () => {
  await withDirectory(async (directory, workRoot) => {
    const report = new TextEncoder().encode("{}");
    await directory.stage(ReferenceDataGuestDirectory.output("report.json"), (async function* () { yield report; })());
    const world = host(() => completed(report));
    const first = await dispatchReferenceDataAttempt(optionsFor(world.runner, workRoot), "snapshotCsv", "reference-data:snapshotCsv", command(ReferenceDataGuestDirectory.output("report.json")), directory);
    expect(first.nodeInstanceId).toBe("reference-data:snapshotCsv");
    expect(first.requestDigest).toMatch(/^sha256:/);
  });
});

test("a guest that dies mid-invocation closes its worker and fails the attempt", async () => {
  await withDirectory(async (directory, workRoot) => {
    const world = host(() => {
      throw new Error("worker exited before response");
    });
    await expect(dispatchReferenceDataAttempt(optionsFor(world.runner, workRoot), "snapshotCsv", "node-a", command("out/report.json"), directory)).rejects.toThrow("worker exited");
    // The worker is closed on the failure path too, so a dead guest does not
    // leave a container behind for the next attempt to collide with.
    expect(world.closed()).toBe(1);
  });
});

test("a runner that refuses to start surfaces its own refusal rather than a report error", async () => {
  await withDirectory(async (directory, workRoot) => {
    const runner: Pick<Runner, "start"> = {
      async start(): Promise<RunnerExecution> {
        throw new Error("runner_busy");
      },
    };
    await expect(dispatchReferenceDataAttempt(optionsFor(runner, workRoot), "snapshotCsv", "node-a", command("out/report.json"), directory)).rejects.toThrow("runner_busy");
  });
});

test("the invocation deadline never outlives the attempt's own authority", async () => {
  await withDirectory(async (directory, workRoot) => {
    const report = new TextEncoder().encode("{}");
    await directory.stage(ReferenceDataGuestDirectory.output("report.json"), (async function* () { yield report; })());
    const near = Date.now() + 5_000;
    const world = host(() => completed(report));
    const options = { ...optionsFor(world.runner, workRoot), authority: { ...AUTHORITY, deadlineAtMs: near } };
    await dispatchReferenceDataAttempt(options, "snapshotCsv", "node-a", command(ReferenceDataGuestDirectory.output("report.json")), directory);
    // The guest is never given longer than the attempt itself holds.
    expect(world.starts[0]?.context.deadline).toBeLessThanOrEqual(near);
    const far = host(() => completed(report));
    const generous = { ...optionsFor(far.runner, workRoot), authority: { ...AUTHORITY, deadlineAtMs: Date.now() + 86_400_000 } };
    const directory2 = await ReferenceDataGuestDirectory.create(workRoot);
    try {
      await directory2.stage(ReferenceDataGuestDirectory.output("report.json"), (async function* () { yield report; })());
      await dispatchReferenceDataAttempt(generous, "snapshotCsv", "node-a", command(ReferenceDataGuestDirectory.output("report.json")), directory2);
      // And never longer than one execution's own ceiling either.
      expect(far.starts[0]?.context.deadline).toBeLessThan(Date.now() + 86_400_000);
    } finally {
      await directory2.dispose();
    }
  });
});

test("the pack names exactly the four exports the compiled definition binds", () => {
  expect(REFERENCE_DATA_STEPS).toEqual(["snapshotCsv", "parseCsv", "transformPartition", "orderedReduce"]);
  const error = new ReferenceDataPackError("reference_data_report_invalid", "x");
  expect(error.name).toBe("ReferenceDataPackError");
  expect(error).toBeInstanceOf(Error);
  expect(randomUUID().length).toBe(36);
});
