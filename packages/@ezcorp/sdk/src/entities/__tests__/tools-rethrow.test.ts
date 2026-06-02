// tools-rethrow.test.ts — covers the defensive rethrow branches in
// the generated create/update handlers (tools.ts lines 323-324 / 386-387).
//
// The handlers wrap `assertRecord` in a try/catch that maps an
// `EntityValidationError` to a VALIDATION_FAILED tool error and RETHROWS
// any other error (it would then be caught by the outer try/catch and
// surfaced as a generic "<tool> failed: ..."). In production `assertRecord`
// only ever throws `EntityValidationError`, so the rethrow is defensive —
// we exercise it by mock-replacing the validate module to throw a plain
// Error, proving the non-validation path is handled (not swallowed).
//
// `mock.module` leaks across files in a single bun process, so the mock
// is scoped tight and restored in afterAll. The replacement keeps
// `validateRecord` intact (soft-read paths still work) and only diverts
// `assertRecord`.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import type { ToolCallResult } from "../../types";
import type { EntityDeclaration } from "../types";
import type { EntityStoreLike } from "../storage";

const DECL: EntityDeclaration = {
  type: "post-type",
  label: "Post Type",
  pluralLabel: "Post Types",
  schema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      systemPrompt: { type: "string", minLength: 1 },
    },
    required: ["name", "systemPrompt"],
    additionalProperties: false,
  },
};

function makeStore(seed: Record<string, unknown> = {}): EntityStoreLike {
  const data = new Map<string, unknown>(Object.entries(seed));
  return {
    async get<T = unknown>(key: string) {
      const exists = data.has(key);
      return { exists, value: exists ? (data.get(key) as T) : (null as T | null) };
    },
    async set<T = unknown>(key: string, value: T) {
      data.set(key, value);
      return { ok: true };
    },
    async delete(key: string) {
      return { deleted: data.delete(key) };
    },
  };
}

// Build handlers AFTER the validate module is mocked so the diverted
// `assertRecord` is captured by tools.ts's import binding.
let buildEntityToolHandlers: typeof import("../tools").buildEntityToolHandlers;

beforeAll(async () => {
  const realValidate = await import("../validate");
  mock.module("../validate", () => ({
    ...realValidate,
    assertRecord: () => {
      // NOT an EntityValidationError — forces the rethrow branch.
      throw new Error("non-validation boom");
    },
  }));
  ({ buildEntityToolHandlers } = await import("../tools"));
});

afterAll(() => {
  // Restore the genuine module so later files in the shard see real
  // validation. mock.restore() clears module mocks registered here.
  mock.restore();
});

describe("create handler — rethrow of non-validation errors", () => {
  test("a non-EntityValidationError from assertRecord surfaces as a generic failure", async () => {
    const { create } = buildEntityToolHandlers(DECL, makeStore());
    const res: ToolCallResult = await create({
      slug: "weekly",
      data: { name: "Weekly", systemPrompt: "x" },
    });
    expect(res.isError).toBe(true);
    // Rethrown → caught by outer try/catch → "<tool> failed: <message>".
    expect(res.content[0]?.text).toContain("non-validation boom");
    // NOT the VALIDATION_FAILED code path.
    expect((res as ToolCallResult & { code?: string }).code).not.toBe(
      "VALIDATION_FAILED",
    );
  });
});

describe("update handler — rethrow of non-validation errors", () => {
  test("a non-EntityValidationError from assertRecord surfaces as a generic failure", async () => {
    const store = makeStore({
      "__entity-index:post-type": ["weekly"],
      "__entity:post-type:weekly": { name: "Weekly", systemPrompt: "x" },
    });
    const { update } = buildEntityToolHandlers(DECL, store);
    const res: ToolCallResult = await update({
      slug: "weekly",
      patch: { name: "New" },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("non-validation boom");
    expect((res as ToolCallResult & { code?: string }).code).not.toBe(
      "VALIDATION_FAILED",
    );
  });
});
