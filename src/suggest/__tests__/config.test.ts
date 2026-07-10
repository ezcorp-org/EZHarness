import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  mockRealSettings,
} from "../../__tests__/helpers/test-pglite";

mockDbConnection();
mockRealSettings();

const {
  getSuggestConfig,
  isSuggestEnabledForProject,
  projectSuggestKey,
  DEFAULT_SUGGEST_MODEL,
  SUGGEST_ENABLED_KEY,
  SUGGEST_MODEL_KEY,
  SUGGEST_URL_KEY,
} = await import("../config");
const { upsertSetting } = await import("../../db/queries/settings");

describe("getSuggestConfig", () => {
  beforeEach(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  test("defaults: enabled, no baseUrl, CPU-default model", async () => {
    const cfg = await getSuggestConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.baseUrl).toBeNull();
    expect(cfg.model).toBe(DEFAULT_SUGGEST_MODEL);
    expect(cfg.timeoutMs).toBeGreaterThan(0);
  });

  test("env vars supply url + model when settings absent", async () => {
    const cfg = await getSuggestConfig({
      EZCORP_SUGGEST_OLLAMA_URL: " http://localhost:11434 ",
      EZCORP_SUGGEST_MODEL: "qwen3:4b",
    });
    expect(cfg.baseUrl).toBe("http://localhost:11434");
    expect(cfg.model).toBe("qwen3:4b");
  });

  test("settings win over env vars", async () => {
    await upsertSetting(SUGGEST_URL_KEY, "http://gpu-box:11434");
    await upsertSetting(SUGGEST_MODEL_KEY, "lfm2.5:1.2b");
    const cfg = await getSuggestConfig({
      EZCORP_SUGGEST_OLLAMA_URL: "http://env:11434",
      EZCORP_SUGGEST_MODEL: "env-model",
    });
    expect(cfg.baseUrl).toBe("http://gpu-box:11434");
    expect(cfg.model).toBe("lfm2.5:1.2b");
  });

  test("blank/non-string setting values fall through to env", async () => {
    await upsertSetting(SUGGEST_URL_KEY, "   ");
    await upsertSetting(SUGGEST_MODEL_KEY, 42);
    const cfg = await getSuggestConfig({ EZCORP_SUGGEST_OLLAMA_URL: "http://env:11434" });
    expect(cfg.baseUrl).toBe("http://env:11434");
    expect(cfg.model).toBe(DEFAULT_SUGGEST_MODEL);
  });

  test("suggest:enabled=false disables; any non-true value disables; absence enables", async () => {
    await upsertSetting(SUGGEST_ENABLED_KEY, false);
    expect((await getSuggestConfig({})).enabled).toBe(false);
    await upsertSetting(SUGGEST_ENABLED_KEY, "yes");
    expect((await getSuggestConfig({})).enabled).toBe(false);
    await upsertSetting(SUGGEST_ENABLED_KEY, true);
    expect((await getSuggestConfig({})).enabled).toBe(true);
  });
});

describe("isSuggestEnabledForProject", () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  test("key follows the project:<id>: settings convention", () => {
    expect(projectSuggestKey("proj-1")).toBe("project:proj-1:suggest:enabled");
  });

  test("default ON: no row → enabled; null projectId (no project context) → enabled", async () => {
    expect(await isSuggestEnabledForProject("proj-1")).toBe(true);
    expect(await isSuggestEnabledForProject(null)).toBe(true);
  });

  test("explicit false disables ONLY that project", async () => {
    await upsertSetting(projectSuggestKey("proj-1"), false);
    expect(await isSuggestEnabledForProject("proj-1")).toBe(false);
    expect(await isSuggestEnabledForProject("proj-2")).toBe(true);
  });

  test("true re-enables; non-boolean values disable (mirror the global read)", async () => {
    await upsertSetting(projectSuggestKey("proj-1"), true);
    expect(await isSuggestEnabledForProject("proj-1")).toBe(true);
    await upsertSetting(projectSuggestKey("proj-1"), "yes");
    expect(await isSuggestEnabledForProject("proj-1")).toBe(false);
  });
});
