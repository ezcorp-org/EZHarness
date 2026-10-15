import { describe, expect, test } from "bun:test";
import { validateFactoryGuestModelResponse } from "./index";

/**
 * W03f: a provider refusal names its class and may carry its settled operation.
 *
 * A guest's failed result must mirror its journaled operations exactly, and
 * only the host knows the settled code and usage, so a provider refusal hands
 * the settled operation back. These cases pin what a guest may receive.
 */

const operationId = "run-1:infer:0:0";
const hex = (digit: string) => digit.repeat(64);
const settled = {
  operationId, operationIndex: 0, kind: "model", state: "failed", requestDigest: hex("a"), resultDigest: hex("b"),
  usage: { kind: "measured", inputTokens: 0, outputTokens: 0, computeMs: 12, costMicros: "0" },
} as const;
const refusal = (code: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: "factory.guest-model-response.v1", status: "refused", operationId, refusal: { code, message: "the provider answered with an error" }, ...extra,
});

describe("a refused model response", () => {
  test("names each provider class, with or without its settled operation", () => {
    for (const code of ["provider_unavailable", "provider_auth_failed", "provider_rate_limited"]) {
      expect(validateFactoryGuestModelResponse(refusal(code))).toEqual({ ok: true });
      expect(validateFactoryGuestModelResponse(refusal(code, { operation: settled }))).toEqual({ ok: true });
    }
    expect(validateFactoryGuestModelResponse(refusal("provider_rate_limited", { operation: { ...settled, providerReceiptDigest: hex("c"), usage: { kind: "measured", inputTokens: 9, outputTokens: 2, computeMs: 40, costMicros: "31" } } }))).toEqual({ ok: true });
  });

  test("refuses a code outside the union", () => {
    expect(validateFactoryGuestModelResponse(refusal("provider_quota_exceeded"))).toMatchObject({ ok: false, issues: [{ code: "GUEST_MODEL_SCHEMA" }] });
  });

  test("carries an operation only on a provider refusal, for its own model operation", () => {
    for (const [code, operation] of [
      ["model_pin_mismatch", settled],
      ["operation_settled", settled],
      ["provider_unavailable", { ...settled, operationId: "run-1:infer:0:1", operationIndex: 1 }],
      ["provider_unavailable", { ...settled, kind: "tool" }],
    ] as const) {
      expect(validateFactoryGuestModelResponse(refusal(code, { operation }))).toMatchObject({ ok: false, issues: [{ code: "GUEST_MODEL_OPERATION", path: ["operation"] }] });
    }
  });

  test("refuses a settled operation whose identity, digest or usage is malformed", () => {
    expect(validateFactoryGuestModelResponse(refusal("provider_unavailable", { operation: { ...settled, resultDigest: `sha256:${hex("b")}` } }))).toMatchObject({ ok: false, issues: [{ code: "RUNNER_OPERATION" }] });
    expect(validateFactoryGuestModelResponse(refusal("provider_unavailable", { operation: { ...settled, usage: { ...settled.usage, costMicros: "-1" } } }))).toMatchObject({ ok: false, issues: [{ code: "RUNNER_USAGE" }] });
    expect(validateFactoryGuestModelResponse(refusal("provider_unavailable", { operation: { ...settled, state: "completed" } }))).toMatchObject({ ok: false, issues: [{ code: "GUEST_MODEL_SCHEMA" }] });
  });

  test("still needs a bounded message", () => {
    expect(validateFactoryGuestModelResponse({ ...refusal("provider_unavailable"), refusal: { code: "provider_unavailable", message: "" } })).toMatchObject({ ok: false, issues: [{ code: "GUEST_MODEL_REFUSAL" }] });
  });
});
