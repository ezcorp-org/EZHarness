/**
 * Unit tests for the gated `ezcorp-mock` provider branches in the router
 * and credential resolver. Both must activate ONLY under the test surface,
 * and the router must point at the in-process loopback mock-LLM baseUrl.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// Router/credentials read settings; stub them to empty so resolution is
// deterministic and never touches a DB.
mock.module("../db/queries/settings", () => ({
  getSetting: async () => undefined,
  getAllSettings: async () => ({}),
  upsertSetting: async () => {},
  deleteSetting: async () => false,
  isListingInstalled: async () => false,
}));
mock.module("../providers/encryption", () => ({
  encrypt: (t: string) => t,
  decrypt: (t: string) => t,
  _resetKeyCache: () => {},
}));

const { resolveModel } = await import("../providers/router");
const { getCredential } = await import("../providers/credentials");

const savedE2E = process.env.PI_E2E_REAL;
const savedNodeEnv = process.env.NODE_ENV;

function enableSurface(on: boolean): void {
  if (on) {
    process.env.PI_E2E_REAL = "1";
    delete process.env.NODE_ENV;
  } else {
    delete process.env.PI_E2E_REAL;
  }
}

beforeEach(() => enableSurface(true));
afterEach(() => {
  if (savedE2E === undefined) delete process.env.PI_E2E_REAL; else process.env.PI_E2E_REAL = savedE2E;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
});
afterAll(() => restoreModuleMocks());

describe("resolveModel: ezcorp-mock", () => {
  test("under the surface → custom openai-completions model at loopback mock baseUrl", async () => {
    const r = await resolveModel("ezcorp-mock", "mock:conv-1");
    expect(r.provider).toBe("ezcorp-mock");
    expect(r.model).toBe("mock:conv-1");
    expect(r.piModel.baseUrl).toContain("/api/__test/mock-llm/v1");
    expect(r.piModel.api).toBe("openai-completions");
  });

  test("baseUrl honors PORT", async () => {
    const savedPort = process.env.PORT;
    process.env.PORT = "4321";
    try {
      const r = await resolveModel("ezcorp-mock", "mock:x");
      expect(r.piModel.baseUrl).toContain("127.0.0.1:4321");
    } finally {
      if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort;
    }
  });

  test("surface OFF → does NOT route to the mock baseUrl", async () => {
    enableSurface(false);
    const r = await resolveModel("ezcorp-mock", "mock:conv-1");
    // Falls through to the generic custom-model path (default OpenAI baseUrl).
    expect(r.piModel.baseUrl).not.toContain("/api/__test/mock-llm");
  });
});

describe("getCredential: ezcorp-mock", () => {
  test("under the surface → sentinel non-empty token", async () => {
    const cred = await getCredential("ezcorp-mock");
    expect(cred).toEqual({ type: "apikey", token: "no-key-needed" });
  });

  test("surface OFF → does NOT short-circuit to the sentinel", async () => {
    enableSurface(false);
    // With no OAuth/BYOK/customModels configured, resolution throws rather
    // than returning the mock sentinel.
    let threw = false;
    try {
      await getCredential("ezcorp-mock");
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/No credentials available/);
    }
    expect(threw).toBe(true);
  });
});
