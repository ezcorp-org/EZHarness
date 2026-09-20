import { test, expect, describe, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// Test isEmbeddingReady
describe("isEmbeddingReady", () => {
  test("returns false when extractor not initialized", async () => {
    // Reset module state
    const { resetEmbeddingProvider, isEmbeddingReady } = await import("../memory/embeddings");
    resetEmbeddingProvider();
    expect(isEmbeddingReady()).toBe(false);
  });

  test("exports isEmbeddingReady function", async () => {
    const mod = await import("../memory/embeddings");
    expect(typeof mod.isEmbeddingReady).toBe("function");
  });
});

// The extension runner mode on the DETAIL surface only — the bare liveness
// probe stays a single `status` field (asserted below in "public response
// has only status field").
describe("health endpoint — extension runner mode", () => {
  const dbUp = () => mock.module("../db/connection", () => ({
    getPglite: () => ({ query: mock(() => ({ rows: [{ "?column?": 1 }] })) }),
    getDb: () => ({}),
    initDb: mock(() => Promise.resolve()),
  }));

  test("detail reports the isolated runner by default", async () => {
    dbUp();
    const { buildHealthResponse } = await import("../health");
    const detail = await buildHealthResponse(true);
    expect(detail.extensions).toEqual({ runner: "isolated" });
  });

  test("an incoherent mode env reads as invalid — health answers rather than throws", async () => {
    const previous = process.env.EZCORP_EXTENSION_RUNNER;
    process.env.EZCORP_EXTENSION_RUNNER = "bogus";
    try {
      dbUp();
      const { buildHealthResponse } = await import("../health");
      expect((await buildHealthResponse(true)).extensions).toEqual({ runner: "invalid" });
    } finally {
      if (previous === undefined) delete process.env.EZCORP_EXTENSION_RUNNER; else process.env.EZCORP_EXTENSION_RUNNER = previous;
    }
  });
});

// Test health endpoint logic
describe("health endpoint logic", () => {
  test("returns healthy status when DB is up", async () => {
    // Mock getPglite to return a working connection
    const mockPg = { query: mock(() => ({ rows: [{ "?column?": 1 }] })) };
    mock.module("../db/connection", () => ({
      getPglite: () => mockPg,
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(false);
    expect(result.status).toBe("healthy");
  });

  test("returns degraded when DB is down", async () => {
    mock.module("../db/connection", () => ({
      getPglite: () => null,
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(false);
    expect(result.status).toBe("degraded");
  });

  test("public response has only status field", async () => {
    const mockPg = { query: mock(() => ({ rows: [{ "?column?": 1 }] })) };
    mock.module("../db/connection", () => ({
      getPglite: () => mockPg,
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(false);
    expect(Object.keys(result)).toEqual(["status"]);
  });

  test("detail response includes subsystem breakdown", async () => {
    const mockPg = { query: mock(() => ({ rows: [{ "?column?": 1 }] })) };
    mock.module("../db/connection", () => ({
      getPglite: () => mockPg,
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));
    mock.module("../memory/embeddings", () => ({
      isEmbeddingReady: () => true,
    }));
    mock.module("../db/queries/settings", () => ({
      getAllSettings: mock(() => Promise.resolve({ "provider:apiKey:anthropic": "sk-test" })),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(true);
    expect(result.status).toBeDefined();
    expect(result.db).toBeDefined();
    expect(result.embeddings).toBeDefined();
    expect(result.providers).toBeDefined();
  });

  test("detail response shows embedding not_initialized", async () => {
    const mockPg = { query: mock(() => ({ rows: [{ "?column?": 1 }] })) };
    mock.module("../db/connection", () => ({
      getPglite: () => mockPg,
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));
    mock.module("../memory/embeddings", () => ({
      isEmbeddingReady: () => false,
    }));
    mock.module("../db/queries/settings", () => ({
      getAllSettings: mock(() => Promise.resolve({})),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(true);
    expect((result.embeddings as { status: string }).status).toBe("not_initialized");
  });
});
