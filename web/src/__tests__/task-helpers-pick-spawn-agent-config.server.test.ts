/**
 * Helper-level unit tests for `pickSpawnAgentConfig` extracted into
 * `web/src/lib/server/task-helpers.ts`.
 *
 * The helper is a tiny picker that selects exactly five fields off a
 * stored agent-config row before the runtime spawn. The original
 * literal lived inline at start:105-111 and retry:134-140 — pinning
 * the field-selection contract here makes leakage of any extra column
 * (timestamps, owner ids, `apiKeyId`, etc.) into the spawn payload
 * surface as a unit-test failure.
 *
 * Pure function, no mocks needed.
 */

import { describe, expect, test } from "vitest";
import { pickSpawnAgentConfig } from "$lib/server/task-helpers";

describe("pickSpawnAgentConfig — happy path field selection", () => {
  test("returns exactly the five expected fields with their values", () => {
    const stored = {
      id: "cfg-1",
      name: "Researcher",
      prompt: "You are a researcher.",
      model: "claude-opus-4-7",
      provider: "anthropic",
    };

    const out = pickSpawnAgentConfig(stored);

    expect(out).toEqual({
      id: "cfg-1",
      name: "Researcher",
      prompt: "You are a researcher.",
      model: "claude-opus-4-7",
      provider: "anthropic",
    });
  });

  test("drops extra columns from a fuller DB row (no leakage into spawn payload)", () => {
    // Real `getAgentConfig` rows include timestamps, owner ids, API key
    // refs, etc. — none of those should reach the runtime spawn.
    const stored = {
      id: "cfg-1",
      name: "Researcher",
      prompt: "You are a researcher.",
      model: "claude-opus-4-7",
      provider: "anthropic",
      // Extra fields the picker MUST NOT propagate:
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-02-01T00:00:00Z",
      ownerUserId: "user-1",
      apiKeyId: "key-1",
      isPublic: true,
      tags: ["alpha"],
    } as Parameters<typeof pickSpawnAgentConfig>[0] & Record<string, unknown>;

    const out = pickSpawnAgentConfig(stored);

    expect(Object.keys(out).sort()).toEqual(
      ["id", "name", "prompt", "model", "provider"].sort(),
    );
    expect(out).not.toHaveProperty("createdAt");
    expect(out).not.toHaveProperty("updatedAt");
    expect(out).not.toHaveProperty("ownerUserId");
    expect(out).not.toHaveProperty("apiKeyId");
    expect(out).not.toHaveProperty("isPublic");
    expect(out).not.toHaveProperty("tags");
  });
});

describe("pickSpawnAgentConfig — nullability passthrough", () => {
  test("preserves null model and null provider verbatim (does NOT coerce to undefined)", () => {
    // The DB row schema is `string | null` for model/provider; the
    // runtime spawn accepts both. Pin that null is preserved end-to-end.
    const stored = {
      id: "cfg-1",
      name: "Bare",
      prompt: "p",
      model: null,
      provider: null,
    };

    const out = pickSpawnAgentConfig(stored);

    expect(out.model).toBeNull();
    expect(out.provider).toBeNull();
    // Both fields are present on the result (not dropped), just null.
    expect("model" in out).toBe(true);
    expect("provider" in out).toBe(true);
  });

  test("missing model/provider (undefined on input) flow through as undefined", () => {
    const stored: Parameters<typeof pickSpawnAgentConfig>[0] = {
      id: "cfg-1",
      name: "Bare",
      prompt: "p",
      // model + provider intentionally omitted
    };

    const out = pickSpawnAgentConfig(stored);

    expect(out.id).toBe("cfg-1");
    expect(out.name).toBe("Bare");
    expect(out.prompt).toBe("p");
    expect(out.model).toBeUndefined();
    expect(out.provider).toBeUndefined();
  });
});
