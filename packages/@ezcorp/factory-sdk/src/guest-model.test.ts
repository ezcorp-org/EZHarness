import { describe, expect, test } from "bun:test";
import { canonicalizeJson, sha256Hex } from "./canonical";
import { FACTORY_GUEST_UNPINNED_MODEL, factoryGuestModelTask, factoryGuestOperationId, FactoryGuestTaskError } from "./guest-model";
import type { FactoryModelPin, FactoryRunnerRequest, JsonValue } from "./types";
import { validateFactoryRunnerResult } from "./validation";

const digest = `sha256:${"a".repeat(64)}`;
const pin: FactoryModelPin = { provider: "openai", model: "gpt-6-luna", configuration: {}, configurationDigest: digest, policy: {}, policyDigest: digest };
const usage = { kind: "measured", inputTokens: 40, outputTokens: 9, computeMs: 12, costMicros: "77" } as const;
const receipt = "e".repeat(64);
const material = (name: string) => ({ artifactId: `material-${name.replaceAll("/", "-")}`, digest, encodedBytes: 10 });

// `null` is an attempt with no pin; an optional parameter would silently take the default pin.
function request(model: FactoryModelPin | null = pin): FactoryRunnerRequest {
  return {
    schemaVersion: "factory.runner.request.v1",
    authority: { attemptId: "a", tenantId: "t", projectId: "p", runId: "run", nodeInstanceId: "generate-private-candidate", candidateGeneration: 0, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, deadlineAtMs: 1, nextOperationIndex: 3 },
    runner: { package: "@ezcorp/reference-code", manifestName: "reference-code", version: "1.0.0", digest, export: "generateCandidate" },
    input: { kind: "inline", value: {} },
    grants: [], resources: {}, ...(model ? { model } : {}), tools: [],
    broker: { attemptToken: "token", audience: "aud" },
  } as FactoryRunnerRequest;
}

/** A broker that answers the model request one way and every staging frame as the host would. */
function broker(model: (payload: Record<string, unknown>) => unknown) {
  const frames: Record<string, unknown>[] = [];
  const call = async (payload: JsonValue): Promise<unknown> => {
    const frame = payload as Record<string, unknown>;
    frames.push(frame);
    const identity = { operationId: frame.operationId, operationIndex: frame.operationIndex, objectName: frame.objectName, version: frame.version };
    switch (frame.schemaVersion) {
      case "factory.guest-model-request.v1": return model(frame);
      case "factory.guest-material-begin.v1": return { schemaVersion: "factory.guest-material-response.v1", ...identity, status: "begun", totalBytes: frame.totalBytes, chunkCount: frame.chunkCount };
      case "factory.guest-material-chunk.v1": return { schemaVersion: "factory.guest-material-response.v1", ...identity, status: "stored", index: frame.index, digest: frame.digest };
      case "factory.guest-material-seal.v1": return { schemaVersion: "factory.guest-material-response.v1", ...identity, status: "sealed", material: material(String(frame.objectName)) };
      default: return { schemaVersion: "factory.guest-material-response.v1", ...identity, status: "output", output: { artifactId: "output", digest: `sha256:${"f".repeat(64)}`, encodedBytes: 5 }, resultDigest: "f".repeat(64) };
    }
  };
  return { call, frames };
}

const completed = (frame: Record<string, unknown>) => ({ schemaVersion: "factory.guest-model-response.v1", status: "completed", operationId: frame.operationId, text: "the answer", providerReceiptDigest: receipt, usage });
const messages = [{ role: "user" as const, text: "hello" }];

describe("factoryGuestModelTask (W4H-28 P1)", () => {
  test("one call, its journal-shaped operation, and the output built from the answer", async () => {
    const { call, frames } = broker(completed);
    const result = await factoryGuestModelTask({ request: request(), call, messages, maxOutputTokens: 100, outputName: "result.json", output: async answer => ({ said: answer.text, tokens: answer.usage.outputTokens }) });
    expect(validateFactoryRunnerResult(result).ok).toBe(true);
    expect(frames.filter(frame => frame.schemaVersion === "factory.guest-model-request.v1")).toEqual([{ schemaVersion: "factory.guest-model-request.v1", operationId: "run:generate-private-candidate:0:3", operationIndex: 3, model: pin, messages, maxOutputTokens: 100 }]);
    expect(result).toMatchObject({ status: "completed", journalCursor: 3, usage, resultDigest: "f".repeat(64) });
    const [operation] = result.operations as Record<string, unknown>[];
    expect(operation).toMatchObject({ operationId: "run:generate-private-candidate:0:3", kind: "model", state: "completed", providerReceiptDigest: receipt, usage });
    expect(operation?.requestDigest).toBe(sha256Hex(canonicalizeJson({ model: pin, messages, maxOutputTokens: 100 } as unknown as JsonValue)));
    expect(operation?.workspaceCheckpoint).toEqual({ ...material("workspace/operation-3.json"), journalCursor: 3 });
  });

  test("a task's own refusal after the answer fails by name and still mirrors the call", async () => {
    const { call } = broker(completed);
    const result = await factoryGuestModelTask({ request: request(), call, messages, maxOutputTokens: 100, outputName: "result.json", output: async () => { throw new FactoryGuestTaskError("reference_code_answer_invalid", "not JSON"); } });
    expect(validateFactoryRunnerResult(result).ok).toBe(true);
    expect(result).toMatchObject({ status: "failed", journalCursor: 3, usage, error: { code: "reference_code_answer_invalid", message: "not JSON", retryable: false } });
    expect(result.operations).toHaveLength(1);
  });

  test("any other error is not a task refusal and propagates", async () => {
    const { call } = broker(completed);
    await expect(factoryGuestModelTask({ request: request(), call, messages, maxOutputTokens: 100, outputName: "result.json", output: async () => { throw new Error("bug"); } })).rejects.toThrow("bug");
  });

  test("a refusal before the claim leaves no row; a claimed failure copies the settled operation", async () => {
    const before = await factoryGuestModelTask({ request: request(null), call: broker(frame => ({ schemaVersion: "factory.guest-model-response.v1", status: "refused", operationId: frame.operationId, refusal: { code: "model_pin_mismatch", message: "no pin" } })).call, messages, maxOutputTokens: 100, outputName: "r", output: async () => null });
    expect(before).toMatchObject({ status: "failed", journalCursor: 2, operations: [], error: { code: "model_pin_mismatch" }, usage: { kind: "measured", inputTokens: 0 } });
    const settled = { operationId: "run:generate-private-candidate:0:3", operationIndex: 3, kind: "model", state: "failed", requestDigest: "1".repeat(64), resultDigest: "2".repeat(64), usage };
    const claimed = await factoryGuestModelTask({ request: request(), call: broker(frame => ({ schemaVersion: "factory.guest-model-response.v1", status: "refused", operationId: frame.operationId, refusal: { code: "provider_unavailable", message: "down" }, operation: settled })).call, messages, maxOutputTokens: 100, outputName: "r", output: async () => null });
    expect(claimed).toMatchObject({ status: "failed", journalCursor: 3, operations: [settled], usage });
    const unmeasured = await factoryGuestModelTask({ request: request(), call: broker(frame => ({ schemaVersion: "factory.guest-model-response.v1", status: "refused", operationId: frame.operationId, refusal: { code: "provider_unavailable", message: "down" }, operation: { ...settled, usage: undefined } })).call, messages, maxOutputTokens: 100, outputName: "r", output: async () => null });
    expect(unmeasured).not.toHaveProperty("usage");
  });

  test("an attempt with no pin asks with the named unpinned model, so the broker refuses it", async () => {
    const { call, frames } = broker(frame => ({ schemaVersion: "factory.guest-model-response.v1", status: "refused", operationId: frame.operationId, refusal: { code: "model_pin_mismatch", message: "no pin" } }));
    await factoryGuestModelTask({ request: request(null), call, messages, maxOutputTokens: 1, outputName: "r", output: async () => null });
    expect(frames[0]?.model).toEqual(FACTORY_GUEST_UNPINNED_MODEL);
    expect(factoryGuestOperationId(request(), 0)).toBe("run:generate-private-candidate:0:0");
  });

  test("a checkpoint the host will not recover stops the task loudly", async () => {
    const answers = (status: string) => broker(completed).call;
    const begunRefused = async (payload: JsonValue) => ((payload as Record<string, unknown>).schemaVersion === "factory.guest-material-begin.v1" ? { status: "refused" } : answers("ok")(payload));
    await expect(factoryGuestModelTask({ request: request(), call: begunRefused, messages, maxOutputTokens: 1, outputName: "r", output: async () => null })).rejects.toThrow("the checkpoint could not be recovered");
    const sealRefused = async (payload: JsonValue) => ((payload as Record<string, unknown>).schemaVersion === "factory.guest-material-seal.v1" ? { status: "refused" } : answers("ok")(payload));
    await expect(factoryGuestModelTask({ request: request(), call: sealRefused, messages, maxOutputTokens: 1, outputName: "r", output: async () => null })).rejects.toThrow("the checkpoint could not be recovered");
  });
});
