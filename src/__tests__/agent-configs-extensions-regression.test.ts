/**
 * Regression test: agent_configs.extensions (top-level) must persist.
 *
 * The DB query previously hardcoded `extensions: []` on create and never
 * updated it, even though the runtime reads `agent.extensions` at invocation
 * time to wire extension tools into the conversation
 * (src/runtime/mention-wiring.ts:91). The user-visible symptom: you'd attach
 * extensions in the UI, save, reload — and see no extensions attached.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { createAgentConfig, getAgentConfig, updateAgentConfig } from "../db/queries/agent-configs";

beforeAll(async () => { await setupTestDb(); });
afterAll(async () => { await closeTestDb(); });

describe("agent_configs.extensions — top-level field persistence (regression)", () => {
  test("createAgentConfig persists provided extensions list", async () => {
    const cfg = await createAgentConfig({
      name: "ext-create-1",
      description: "",
      prompt: "P",
      extensions: ["ext-1", "ext-2"],
    } as any);
    expect(cfg.extensions).toEqual(["ext-1", "ext-2"]);

    const fetched = await getAgentConfig(cfg.id);
    expect(fetched?.extensions).toEqual(["ext-1", "ext-2"]);
  });

  test("createAgentConfig without extensions defaults to empty array", async () => {
    const cfg = await createAgentConfig({
      name: "ext-create-empty",
      description: "",
      prompt: "P",
    });
    expect(cfg.extensions).toEqual([]);
  });

  test("updateAgentConfig persists new extensions list", async () => {
    const cfg = await createAgentConfig({
      name: "ext-update-1",
      description: "",
      prompt: "P",
    });
    expect(cfg.extensions).toEqual([]);

    const updated = await updateAgentConfig(cfg.id, {
      extensions: ["ext-a", "ext-b", "ext-c"],
    } as any);
    expect(updated?.extensions).toEqual(["ext-a", "ext-b", "ext-c"]);

    const refetched = await getAgentConfig(cfg.id);
    expect(refetched?.extensions).toEqual(["ext-a", "ext-b", "ext-c"]);
  });

  test("updateAgentConfig can clear extensions by passing []", async () => {
    const cfg = await createAgentConfig({
      name: "ext-clear",
      description: "",
      prompt: "P",
      extensions: ["ext-1"],
    } as any);
    expect(cfg.extensions).toEqual(["ext-1"]);

    const updated = await updateAgentConfig(cfg.id, { extensions: [] } as any);
    expect(updated?.extensions).toEqual([]);
  });

  test("updateAgentConfig leaves extensions untouched when not in payload", async () => {
    const cfg = await createAgentConfig({
      name: "ext-preserve",
      description: "",
      prompt: "P",
      extensions: ["ext-keep"],
    } as any);

    const updated = await updateAgentConfig(cfg.id, { description: "new desc" });
    expect(updated?.extensions).toEqual(["ext-keep"]);
    expect(updated?.description).toBe("new desc");
  });
});
