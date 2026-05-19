/**
 * Coverage for `deriveHandlerContext` (Phase 50.6.1).
 *
 * Pure unit tests — no DB, no fixtures.
 *
 * Spoofing test (the load-bearing one): even when a malicious
 * subprocess injects an `actorExtensionId` into the RPC meta payload,
 * the host's `registeredTool.extensionId` always wins.
 */
import { test, expect, describe } from "bun:test";
import { deriveHandlerContext } from "../handler-context";

describe("deriveHandlerContext — happy paths", () => {
  test("derives all 5 fields when meta is fully populated", () => {
    const ctx = deriveHandlerContext(
      {
        ezOnBehalfOf: "user-1",
        ezConversationId: "conv-1",
        invocationMetadata: { runId: "run-1", parentCallId: "cap-parent-1" },
      },
      { extensionId: "ext-1" },
    );
    expect(ctx).toEqual({
      actorExtensionId: "ext-1",
      onBehalfOf: "user-1",
      conversationId: "conv-1",
      runId: "run-1",
      parentCallId: "cap-parent-1",
    });
  });

  test("conversationId/runId/parentCallId default to null when meta omits them", () => {
    const ctx = deriveHandlerContext(
      { ezOnBehalfOf: "user-1" },
      { extensionId: "ext-1" },
    );
    expect(ctx.conversationId).toBeNull();
    expect(ctx.runId).toBeNull();
    expect(ctx.parentCallId).toBeNull();
  });

  test("invocationMetadata with non-string runId is ignored (defensive)", () => {
    const ctx = deriveHandlerContext(
      {
        ezOnBehalfOf: "user-1",
        invocationMetadata: { runId: 12345, parentCallId: { foo: "x" } },
      },
      { extensionId: "ext-1" },
    );
    expect(ctx.runId).toBeNull();
    expect(ctx.parentCallId).toBeNull();
  });
});

describe("deriveHandlerContext — refuses missing onBehalfOf", () => {
  test("undefined rpcMeta throws", () => {
    expect(() => deriveHandlerContext(undefined, { extensionId: "ext-1" }))
      .toThrow("handler-context: missing onBehalfOf");
  });

  test("rpcMeta without ezOnBehalfOf throws", () => {
    expect(() => deriveHandlerContext({ ezConversationId: "conv-1" }, { extensionId: "ext-1" }))
      .toThrow("handler-context: missing onBehalfOf");
  });

  test("non-string ezOnBehalfOf throws (defensive)", () => {
    expect(() => deriveHandlerContext({ ezOnBehalfOf: 42 }, { extensionId: "ext-1" }))
      .toThrow("handler-context: missing onBehalfOf");
  });

  test("empty-string ezOnBehalfOf throws", () => {
    expect(() => deriveHandlerContext({ ezOnBehalfOf: "" }, { extensionId: "ext-1" }))
      .toThrow("handler-context: missing onBehalfOf");
  });
});

describe("deriveHandlerContext — refuses missing extensionId", () => {
  test("missing registeredTool throws", () => {
    expect(() => deriveHandlerContext(
      { ezOnBehalfOf: "user-1" },
      // @ts-expect-error — intentionally violating the type
      undefined,
    )).toThrow("handler-context: missing registeredTool.extensionId");
  });

  test("registeredTool with empty extensionId throws", () => {
    expect(() => deriveHandlerContext(
      { ezOnBehalfOf: "user-1" },
      { extensionId: "" },
    )).toThrow("handler-context: missing registeredTool.extensionId");
  });
});

describe("deriveHandlerContext — spoofing defense", () => {
  test("subprocess-supplied actorExtensionId in RPC meta is IGNORED — host's registeredTool wins", () => {
    const ctx = deriveHandlerContext(
      {
        ezOnBehalfOf: "user-1",
        // Malicious subprocess tries to claim it's "ext-bank-of-evil".
        actorExtensionId: "ext-bank-of-evil",
        ezActorExtensionId: "ext-bank-of-evil",
      },
      { extensionId: "ext-honest" },
    );
    expect(ctx.actorExtensionId).toBe("ext-honest");
    expect(ctx.actorExtensionId).not.toBe("ext-bank-of-evil");
  });

  test("subprocess can't override onBehalfOf via a different field name", () => {
    // Belt-and-braces: only `ezOnBehalfOf` is read; aliases are ignored.
    const ctx = deriveHandlerContext(
      {
        ezOnBehalfOf: "user-honest",
        userId: "user-spoofed",
        actingUser: "user-spoofed",
      },
      { extensionId: "ext-1" },
    );
    expect(ctx.onBehalfOf).toBe("user-honest");
  });
});
