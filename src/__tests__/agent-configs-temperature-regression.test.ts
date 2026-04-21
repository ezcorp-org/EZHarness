/**
 * Regression test: temperature must accept floats.
 *
 * The DB column was originally INTEGER but the UI / zod schema / API all allow
 * `z.number().min(0).max(2)` — so saving an agent with a normal temperature
 * like 0.5 or 0.7 crashed with PG error 22P02:
 *   "invalid input syntax for type integer: 0.5"
 * This surfaced to users as a 500 on every team/agent save that used a
 * non-integer temperature.
 *
 * The fix is to store temperature as REAL in both `agent_configs` and `modes`.
 * This test locks in the behavior so it can't regress.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { createAgentConfig, getAgentConfig, updateAgentConfig } from "../db/queries/agent-configs";
import { createMode, getMode, updateMode } from "../db/queries/modes";

beforeAll(async () => { await setupTestDb(); });
afterAll(async () => { await closeTestDb(); });

describe("agent_configs.temperature — accepts floats (regression)", () => {
  test("creating with temperature = 0.5 round-trips", async () => {
    const cfg = await createAgentConfig({
      name: "temp-float-1",
      description: "",
      prompt: "P",
      temperature: 0.5,
    });
    expect(cfg.temperature).toBeCloseTo(0.5, 5);
    const fetched = await getAgentConfig(cfg.id);
    expect(fetched?.temperature).toBeCloseTo(0.5, 5);
  });

  test("creating with temperature = 0.7 round-trips", async () => {
    const cfg = await createAgentConfig({
      name: "temp-float-2",
      description: "",
      prompt: "P",
      temperature: 0.7,
    });
    expect(cfg.temperature).toBeCloseTo(0.7, 5);
  });

  test("creating with integer-valued temperature = 1 still works", async () => {
    const cfg = await createAgentConfig({
      name: "temp-int-1",
      description: "",
      prompt: "P",
      temperature: 1,
    });
    expect(cfg.temperature).toBe(1);
  });

  test("updating temperature from null → 0.3 round-trips", async () => {
    const cfg = await createAgentConfig({
      name: "temp-update-1",
      description: "",
      prompt: "P",
    });
    expect(cfg.temperature).toBeNull();

    const updated = await updateAgentConfig(cfg.id, { temperature: 0.3 });
    expect(updated?.temperature).toBeCloseTo(0.3, 5);
  });

  test("temperature = 0 is stored as 0 (not silently dropped)", async () => {
    const cfg = await createAgentConfig({
      name: "temp-zero",
      description: "",
      prompt: "P",
      temperature: 0,
    });
    expect(cfg.temperature).toBe(0);
  });

  test("temperature = 2 (max) round-trips", async () => {
    const cfg = await createAgentConfig({
      name: "temp-max",
      description: "",
      prompt: "P",
      temperature: 2,
    });
    expect(cfg.temperature).toBe(2);
  });

  test("modes.temperature also accepts floats (same bug, same fix)", async () => {
    const m = await createMode({
      name: "Float Mode",
      slug: "float-mode-test",
      systemPromptInstruction: "You are testing.",
      temperature: 0.4,
    });
    expect(m.temperature).toBeCloseTo(0.4, 5);

    const updated = await updateMode(m.id, { temperature: 1.5 });
    expect(updated?.temperature).toBeCloseTo(1.5, 5);

    const fetched = await getMode(m.id);
    expect(fetched?.temperature).toBeCloseTo(1.5, 5);
  });

  test("combined: teamToolScope + float temperature both persist (no 500)", async () => {
    const cfg = await createAgentConfig({
      name: "combined-team",
      description: "",
      prompt: "Coordinate",
      category: "team",
      temperature: 0.2,
      references: {
        agents: [],
        extensions: [],
        teamToolScope: {
          allowedTools: ["read_file"],
          deniedTools: ["bash_execute"],
        },
      },
    });
    expect(cfg.temperature).toBeCloseTo(0.2, 5);
    expect(cfg.references?.teamToolScope?.allowedTools).toEqual(["read_file"]);
    expect(cfg.references?.teamToolScope?.deniedTools).toEqual(["bash_execute"]);

    // Most importantly: a fresh fetch after save (what the UI does on reload)
    // returns both fields intact — the user-visible symptom of the 500 was
    // "we don't see this on agent or teams pages".
    const fetched = await getAgentConfig(cfg.id);
    expect(fetched?.temperature).toBeCloseTo(0.2, 5);
    expect(fetched?.references?.teamToolScope?.allowedTools).toEqual(["read_file"]);
    expect(fetched?.references?.teamToolScope?.deniedTools).toEqual(["bash_execute"]);
  });
});
