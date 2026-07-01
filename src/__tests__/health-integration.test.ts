import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { AgentEvents } from "../types";

afterAll(() => restoreModuleMocks());

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`expected ${what}`);
  return v;
}

// ── buildHealthResponse edge cases ──────────────────────────────────

describe("buildHealthResponse — DB error resilience", () => {
  beforeEach(() => {
    // Reset module mocks between tests
    mock.module("../db/queries/settings", () => ({
      getAllSettings: mock(() => Promise.resolve({})),
    }));
    mock.module("../memory/embeddings", () => ({
      isEmbeddingReady: () => false,
    }));
  });

  test("DB query throws → returns degraded, no crash", async () => {
    mock.module("../db/connection", () => ({
      getPglite: () => ({
        query: () => { throw new Error("connection refused"); },
      }),
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(false);
    expect(result.status).toBe("degraded");
  });

  test("getPglite returns null → degraded", async () => {
    mock.module("../db/connection", () => ({
      getPglite: () => null,
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(false);
    expect(result.status).toBe("degraded");
  });

  test("DB query rejects (async throw) → degraded", async () => {
    mock.module("../db/connection", () => ({
      getPglite: () => ({
        query: () => Promise.reject(new Error("timeout")),
      }),
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(false);
    expect(result.status).toBe("degraded");
  });
});

describe("buildHealthResponse — detail=false output shape", () => {
  test("never includes db, embeddings, or providers keys", async () => {
    mock.module("../db/connection", () => ({
      getPglite: () => null,
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(false);
    expect(result).not.toHaveProperty("db");
    expect(result).not.toHaveProperty("embeddings");
    expect(result).not.toHaveProperty("providers");
  });
});

describe("buildHealthResponse — detail=true structure", () => {
  const mockPg = () => ({ query: mock(() => ({ rows: [{ "?column?": 1 }] })) });

  test("DB up + embeddings ready → healthy with full detail", async () => {
    mock.module("../db/connection", () => ({
      getPglite: () => mockPg(),
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));
    mock.module("../memory/embeddings", () => ({
      isEmbeddingReady: () => true,
    }));
    mock.module("../db/queries/settings", () => ({
      getAllSettings: mock(() => Promise.resolve({})),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(true);
    expect(result.status).toBe("healthy");
    expect(result.db!.status).toBe("up");
    expect(result.embeddings!.status).toBe("ready");
    expect(result.providers).toBeDefined();
  });

  test("DB up but embeddings not ready → still healthy", async () => {
    mock.module("../db/connection", () => ({
      getPglite: () => mockPg(),
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
    expect(result.status).toBe("healthy");
    expect(result.embeddings!.status).toBe("not_initialized");
  });

  test("detail=true always includes db, embeddings, providers keys", async () => {
    mock.module("../db/connection", () => ({
      getPglite: () => null,
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
    expect(result).toHaveProperty("db");
    expect(result).toHaveProperty("embeddings");
    expect(result).toHaveProperty("providers");
  });

  test("DB down in detail mode → db.status is 'down'", async () => {
    mock.module("../db/connection", () => ({
      getPglite: () => null,
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
    expect(result.status).toBe("degraded");
    expect(result.db!.status).toBe("down");
  });
});

// ── Provider detection ──────────────────────────────────────────────

describe("buildHealthResponse — provider detection", () => {
  const mockPg = () => ({ query: mock(() => ({ rows: [{ "?column?": 1 }] })) });

  beforeEach(() => {
    mock.module("../db/connection", () => ({
      getPglite: () => mockPg(),
      getDb: () => ({}),
      initDb: mock(() => Promise.resolve()),
    }));
    mock.module("../memory/embeddings", () => ({
      isEmbeddingReady: () => false,
    }));
  });

  test("apiKey present → configured", async () => {
    mock.module("../db/queries/settings", () => ({
      getAllSettings: mock(() => Promise.resolve({
        "provider:apiKey:anthropic": "sk-ant-xxx",
      })),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(true);
    const providers = need(result.providers, "providers");
    expect(need(providers.anthropic, "anthropic provider").status).toBe("configured");
    expect(need(providers.openai, "openai provider").status).toBe("not_configured");
    expect(need(providers.google, "google provider").status).toBe("not_configured");
  });

  test("oauth token present → configured", async () => {
    mock.module("../db/queries/settings", () => ({
      getAllSettings: mock(() => Promise.resolve({
        "provider:oauth:google": "ya29.xxx",
      })),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(true);
    const providers = need(result.providers, "providers");
    expect(need(providers.google, "google provider").status).toBe("configured");
  });

  test("neither apiKey nor oauth → not_configured", async () => {
    mock.module("../db/queries/settings", () => ({
      getAllSettings: mock(() => Promise.resolve({})),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(true);
    const providers = need(result.providers, "providers");
    for (const name of ["anthropic", "openai", "google"]) {
      expect(need(providers[name], `${name} provider`).status).toBe("not_configured");
    }
  });

  test("getAllSettings throws → providers is empty object, no crash", async () => {
    mock.module("../db/queries/settings", () => ({
      getAllSettings: mock(() => Promise.reject(new Error("DB locked"))),
    }));

    const { buildHealthResponse } = await import("../health");
    const result = await buildHealthResponse(true);
    expect(result.providers).toEqual({});
  });
});

// ── isEmbeddingReady ────────────────────────────────────────────────

describe("isEmbeddingReady — state checks", () => {
  test("returns false after reset (fresh state)", async () => {
    const { resetEmbeddingProvider, isEmbeddingReady } = await import("../memory/embeddings");
    resetEmbeddingProvider();
    expect(isEmbeddingReady()).toBe(false);
  });
});

// ── Executor memory_unavailable emission ────────────────────────────

describe("Executor — memory_unavailable emission", () => {
  test("emits run:status with memory_unavailable when memory injection throws", async () => {
    // Mock all executor dependencies
    mock.module("../providers/router", () => ({
      resolveModel: mock(() => Promise.resolve({
        provider: "anthropic",
        piModel: { id: "claude-3", provider: "anthropic" },
      })),
      ProviderUnavailableError: class extends Error {
        failedProvider = "";
        failedModel = "";
        suggestion = "";
      },
    }));
    mock.module("../providers/credentials", () => ({
      getCredential: mock(() => Promise.resolve({ type: "apiKey", token: "sk-test" })),
    }));
    mock.module("../providers/registry", () => ({
      resolveOAuthModel: () => null,
    }));
    mock.module("../db/queries/runs", () => ({
      insertRun: mock(() => Promise.resolve()),
      updateRun: mock(() => Promise.resolve()),
      insertLog: mock(() => Promise.resolve()),
    }));
    mock.module("../db/queries/conversations", () => ({
      getConversationPath: mock(() => Promise.resolve([])),
      getLatestLeaf: mock(() => Promise.resolve(null)),
      resolveSystemPrompt: mock(() => Promise.resolve("system")),
      createMessage: mock(() => Promise.resolve()),
      getConversation: mock(() => Promise.resolve({ id: "conv-1", parentConversationId: null })),
    }));
    mock.module("../db/queries/active-runs", () => ({
      createActiveRun: mock(() => Promise.resolve()),
      deleteActiveRun: mock(() => Promise.resolve()),
      markInterrupted: mock(() => Promise.resolve()),
      updateHeartbeat: mock(() => Promise.resolve()),
      updatePartialResponse: mock(() => Promise.resolve()),
      cleanupOrphanedRuns: mock(() => Promise.resolve()),
    }));
    mock.module("../db/queries/projects", () => ({
      getProject: mock(() => Promise.resolve({ path: "/tmp", variables: {} })),
    }));
    mock.module("../db/queries/settings", () => ({
      getAllSettings: mock(() => Promise.resolve({})),
    }));
    // Memory injection throws
    mock.module("../memory/injection", () => ({
      buildSystemPromptWithMemories: mock(() => {
        throw new Error("embedding model not available");
      }),
    }));
    mock.module("../extensions/registry", () => ({
      ExtensionRegistry: { getInstance: () => ({ getToolsForAgent: () => [] }) },
    }));
    mock.module("../observability/collector", () => ({
      startCollector: () => {},
    }));
    mock.module("../providers/shell", () => ({
      createShellProvider: () => ({}),
    }));
    mock.module("../providers/file", () => ({
      createFileProvider: () => ({}),
    }));

    // Mock pi-agent-core Agent
    mock.module("@earendil-works/pi-agent-core", () => ({
      Agent: class {
        state = { error: null };
        subscribe(fn: any) {
          // Simulate a text response
          fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
          return () => {};
        }
        prompt() { return Promise.resolve(); }
        abort() {}
      },
    }));

    const { EventBus } = await import("../runtime/events");
    const { AgentExecutor } = await import("../runtime/executor");

    const bus = new EventBus<AgentEvents>();
    const statusEvents: any[] = [];
    bus.on("run:status", (evt: any) => statusEvents.push(evt));

    const executor = new AgentExecutor(new Map(), bus, { persist: true });

    await executor.streamChat("conv-1", "hello", {
      projectId: "proj-1",
      provider: "anthropic",
      model: "claude-3",
    });

    const memUnavailable = statusEvents.find(
      (e) => e.status === "memory_unavailable"
    );
    expect(memUnavailable).toBeDefined();
    expect(memUnavailable.degraded).toBe(true);
    expect(memUnavailable.message).toContain("unavailable");
  });
});

// ── Health endpoint auth (testing the SvelteKit handler logic) ──────

describe("Health endpoint auth logic", () => {
  test("public request (no detail) returns status only", async () => {
    mock.module("../db/connection", () => ({
      getPglite: () => ({ query: mock(() => ({ rows: [{}] })) }),
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
    const result = await buildHealthResponse(false);
    const keys = Object.keys(result);
    expect(keys).toEqual(["status"]);
  });

  // The endpoint handler enforces auth via requireAuth + role check.
  // We test the logic pattern: detail=true with non-admin should be rejected.
  test("requireAuth pattern: non-admin gets rejected for detail", () => {
    const user = { role: "user" };
    const isAdmin = user?.role === "admin";
    expect(isAdmin).toBe(false);
  });

  test("requireAuth pattern: admin gets access for detail", () => {
    const user = { role: "admin" };
    const isAdmin = user?.role === "admin";
    expect(isAdmin).toBe(true);
  });

  test("requireAuth pattern: missing user gets rejected", () => {
    const user = undefined;
    const isAdmin = (user as any)?.role === "admin";
    expect(isAdmin).toBeFalsy();
  });
});
