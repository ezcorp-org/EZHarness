import { expect, test } from "bun:test";
import type { InvocationContext } from "@ezcorp/extension-contract";
import { FACTORY_GUEST_BROKER_METHOD, FACTORY_GUEST_TOOL_METHOD, FactoryGuestFrameError, factoryGuestFrameInput } from "./guest-frames";

const context: InvocationContext = { invocationId: "factory_invocation", workerId: "factory_worker", releaseId: "a".repeat(64), principalId: "tenant-frames", scopeId: "project-frames", token: "minted-token", deadline: 4_102_444_800_000 };

function code(call: () => unknown): string {
  try { call(); } catch (error) { return error instanceof FactoryGuestFrameError ? error.code : `unexpected:${String(error)}`; }
  return "accepted";
}

test("a frame carrying the exact started context is accepted and yields its input", () => {
  expect(factoryGuestFrameInput(FACTORY_GUEST_BROKER_METHOD, { context, input: { kind: "model" } }, context)).toEqual({ kind: "model" });
  expect(factoryGuestFrameInput(FACTORY_GUEST_TOOL_METHOD, { context, input: null }, context, FACTORY_GUEST_TOOL_METHOD)).toBeNull();
});

test("only the allowed reverse method is answered", () => {
  expect(code(() => factoryGuestFrameInput(FACTORY_GUEST_TOOL_METHOD, { context, input: {} }, context))).toBe("frame_method_denied");
  expect(code(() => factoryGuestFrameInput("extension/invoke", { context, input: {} }, context))).toBe("frame_method_denied");
});

test("a frame that is not a JSON object, or has no input, is invalid", () => {
  expect(code(() => factoryGuestFrameInput(FACTORY_GUEST_BROKER_METHOD, null, context))).toBe("frame_invalid");
  expect(code(() => factoryGuestFrameInput(FACTORY_GUEST_BROKER_METHOD, "frame", context))).toBe("frame_invalid");
  expect(code(() => factoryGuestFrameInput(FACTORY_GUEST_BROKER_METHOD, [context], context))).toBe("frame_invalid");
  expect(code(() => factoryGuestFrameInput(FACTORY_GUEST_BROKER_METHOD, { context }, context))).toBe("frame_invalid");
  expect(code(() => factoryGuestFrameInput(FACTORY_GUEST_BROKER_METHOD, { context, input: undefined }, context))).toBe("frame_invalid");
});

test("a frame bound to another worker, invocation, token, or deadline is denied", () => {
  for (const drift of [{ workerId: "other" }, { invocationId: "other" }, { token: "other" }, { deadline: context.deadline + 1 }, { scopeId: "other-project" }, { principalId: "other-tenant" }]) {
    expect(code(() => factoryGuestFrameInput(FACTORY_GUEST_BROKER_METHOD, { context: { ...context, ...drift }, input: {} }, context))).toBe("frame_unbound");
  }
});

test("an absent or unserializable context is denied rather than canonicalized", () => {
  expect(code(() => factoryGuestFrameInput(FACTORY_GUEST_BROKER_METHOD, { input: {} }, context))).toBe("frame_unbound");
  expect(code(() => factoryGuestFrameInput(FACTORY_GUEST_BROKER_METHOD, { context: () => context, input: {} }, context))).toBe("frame_unbound");
  expect(code(() => factoryGuestFrameInput(FACTORY_GUEST_BROKER_METHOD, { context: { ...context, extra: 1n }, input: {} }, context))).toBe("frame_unbound");
});
