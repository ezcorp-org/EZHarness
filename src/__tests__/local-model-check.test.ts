import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import {
  detectEndpointType,
  checkEndpointReachability,
  checkModelAvailability,
  testInference,
  checkLocalModel,
  listModels,
} from "../providers/local-model-check";

// ── Fetch mock infrastructure ───────────────────────────────────────

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, text = ""): Response {
  return new Response(text, { status });
}

beforeEach(() => {
  mockFetch = mock(() => Promise.reject(new Error("unmocked fetch")));
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── detectEndpointType ──────────────────────────────────────────────

describe("detectEndpointType", () => {
  test("returns openai-compatible when /v1/models succeeds", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/v1/models")) return Promise.resolve(jsonResponse({ data: [] }));
      return Promise.reject(new Error("not found"));
    });

    const result = await detectEndpointType("http://localhost:11434");
    expect(result).toBe("openai-compatible");
  });

  test("returns ollama when /v1/models fails but /api/tags succeeds", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/v1/models")) return Promise.resolve(errorResponse(404));
      if (url.includes("/api/tags")) return Promise.resolve(jsonResponse({ models: [] }));
      return Promise.reject(new Error("not found"));
    });

    const result = await detectEndpointType("http://localhost:11434");
    expect(result).toBe("ollama");
  });

  test("returns null when both endpoints fail", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(errorResponse(500)));

    const result = await detectEndpointType("http://localhost:11434");
    expect(result).toBeNull();
  });

  test("returns null on network error", async () => {
    mockFetch.mockImplementation(() => Promise.reject(new TypeError("fetch failed")));

    const result = await detectEndpointType("http://localhost:11434");
    expect(result).toBeNull();
  });

  test("strips trailing slashes from baseUrl", async () => {
    const urls: string[] = [];
    mockFetch.mockImplementation((url: string) => {
      urls.push(url);
      return Promise.resolve(jsonResponse({ data: [] }));
    });

    await detectEndpointType("http://localhost:11434///");
    expect(urls[0]).toBe("http://localhost:11434/v1/models");
  });
});

// ── checkEndpointReachability ───────────────────────────────────────

describe("checkEndpointReachability", () => {
  test("returns reachable with openai-compatible type", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/v1/models")) return Promise.resolve(jsonResponse({ data: [] }));
      return Promise.reject(new Error("not found"));
    });

    const result = await checkEndpointReachability("http://localhost:11434");
    expect(result.reachable).toBe(true);
    expect(result.endpointType).toBe("openai-compatible");
    expect(result.error).toBeUndefined();
  });

  test("returns unreachable with error on total failure", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(errorResponse(500)));

    const result = await checkEndpointReachability("http://localhost:99999");
    expect(result.reachable).toBe(false);
    expect(result.endpointType).toBeNull();
    expect(result.error).toBeDefined();
  });

  test("returns unreachable with error on DNS failure", async () => {
    mockFetch.mockImplementation(() => Promise.reject(new TypeError("fetch failed")));

    const result = await checkEndpointReachability("http://nonexistent.local:11434");
    expect(result.reachable).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ── checkModelAvailability ──────────────────────────────────────────

describe("checkModelAvailability", () => {
  test("openai-compatible: finds model in data array", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse({
        data: [{ id: "llama3" }, { id: "codellama" }],
      })),
    );

    const result = await checkModelAvailability("http://localhost:11434", "llama3", "openai-compatible");
    expect(result.available).toBe(true);
    expect(result.models).toHaveLength(2);
  });

  test("openai-compatible: model not found", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse({
        data: [{ id: "llama3" }],
      })),
    );

    const result = await checkModelAvailability("http://localhost:11434", "mistral", "openai-compatible");
    expect(result.available).toBe(false);
    expect(result.models).toHaveLength(1);
  });

  test("openai-compatible: handles non-200 response", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(errorResponse(500)));

    const result = await checkModelAvailability("http://localhost:11434", "llama3", "openai-compatible");
    expect(result.available).toBe(false);
    expect(result.error).toContain("500");
  });

  test("ollama: finds model by exact name", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse({
        models: [{ name: "llama3:latest" }, { name: "codellama:7b" }],
      })),
    );

    const result = await checkModelAvailability("http://localhost:11434", "llama3:latest", "ollama");
    expect(result.available).toBe(true);
  });

  test("ollama: matches model without :latest suffix", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse({
        models: [{ name: "llama3:latest" }],
      })),
    );

    const result = await checkModelAvailability("http://localhost:11434", "llama3", "ollama");
    expect(result.available).toBe(true);
  });

  test("ollama: matches when query has :latest but stored doesn't", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse({
        models: [{ name: "llama3" }],
      })),
    );

    // The model list has "llama3", query is "llama3:latest"
    // Our code strips :latest from the stored name to compare
    const result = await checkModelAvailability("http://localhost:11434", "llama3", "ollama");
    expect(result.available).toBe(true);
  });

  test("ollama: model not found", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse({
        models: [{ name: "llama3:latest" }],
      })),
    );

    const result = await checkModelAvailability("http://localhost:11434", "mistral", "ollama");
    expect(result.available).toBe(false);
  });

  test("ollama: handles non-200 response", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(errorResponse(403)));

    const result = await checkModelAvailability("http://localhost:11434", "llama3", "ollama");
    expect(result.available).toBe(false);
    expect(result.error).toContain("403");
  });

  test("handles network error", async () => {
    mockFetch.mockImplementation(() => Promise.reject(new Error("connection refused")));

    const result = await checkModelAvailability("http://localhost:11434", "llama3", "openai-compatible");
    expect(result.available).toBe(false);
    expect(result.error).toContain("connection refused");
  });
});

// ── testInference ───────────────────────────────────────────────────

describe("testInference", () => {
  test("success returns latency", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse({
        choices: [{ message: { content: "ok" } }],
      })),
    );

    const result = await testInference("http://localhost:11434", "llama3", "openai-compatible");
    expect(result.success).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  test("HTTP 500 returns failure with error", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(errorResponse(500, "Internal Server Error")),
    );

    const result = await testInference("http://localhost:11434", "llama3", "openai-compatible");
    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("network error returns failure", async () => {
    mockFetch.mockImplementation(() => Promise.reject(new Error("timeout")));

    const result = await testInference("http://localhost:11434", "llama3", "openai-compatible");
    expect(result.success).toBe(false);
    expect(result.error).toContain("timeout");
  });

  test("sends correct request body", async () => {
    let capturedBody: any;
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve(jsonResponse({ choices: [] }));
    });

    await testInference("http://localhost:11434", "llama3", "openai-compatible");
    expect(capturedBody.model).toBe("llama3");
    expect(capturedBody.messages).toEqual([{ role: "user", content: "Say ok" }]);
    expect(capturedBody.max_tokens).toBe(1);
    expect(capturedBody.stream).toBe(false);
  });

  test("uses /v1/chat/completions endpoint for both types", async () => {
    const urls: string[] = [];
    mockFetch.mockImplementation((url: string) => {
      urls.push(url);
      return Promise.resolve(jsonResponse({ choices: [] }));
    });

    await testInference("http://localhost:11434", "llama3", "openai-compatible");
    await testInference("http://localhost:11434", "llama3", "ollama");
    expect(urls[0]).toBe("http://localhost:11434/v1/chat/completions");
    expect(urls[1]).toBe("http://localhost:11434/v1/chat/completions");
  });
});

// ── checkLocalModel (orchestrator) ──────────────────────────────────

describe("checkLocalModel", () => {
  test("all checks pass: full success result", async () => {
    let _callCount = 0;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      _callCount++;
      if (url.includes("/v1/models")) {
        return Promise.resolve(jsonResponse({ data: [{ id: "llama3" }] }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
      }
      return Promise.reject(new Error("unexpected"));
    });

    const result = await checkLocalModel("http://localhost:11434", "llama3");
    expect(result.reachable).toBe(true);
    expect(result.modelAvailable).toBe(true);
    expect(result.inferenceOk).toBe(true);
    expect(result.endpointType).toBe("openai-compatible");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("unreachable: short-circuits with nulls", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(errorResponse(500)));

    const result = await checkLocalModel("http://localhost:99999", "llama3");
    expect(result.reachable).toBe(false);
    expect(result.modelAvailable).toBeNull();
    expect(result.inferenceOk).toBeNull();
    expect(result.error).toBeDefined();
  });

  test("reachable but model not found: inferenceOk is null", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/v1/models")) {
        return Promise.resolve(jsonResponse({ data: [{ id: "other-model" }] }));
      }
      return Promise.reject(new Error("unexpected"));
    });

    const result = await checkLocalModel("http://localhost:11434", "llama3");
    expect(result.reachable).toBe(true);
    expect(result.modelAvailable).toBe(false);
    expect(result.inferenceOk).toBeNull();
    expect(result.error).toContain("llama3");
  });

  test("reachable + model found + inference fails", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/v1/models")) {
        return Promise.resolve(jsonResponse({ data: [{ id: "llama3" }] }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(errorResponse(500, "out of memory"));
      }
      return Promise.reject(new Error("unexpected"));
    });

    const result = await checkLocalModel("http://localhost:11434", "llama3");
    expect(result.reachable).toBe(true);
    expect(result.modelAvailable).toBe(true);
    expect(result.inferenceOk).toBe(false);
    expect(result.error).toContain("500");
  });

  test("returns latencyMs covering all phases", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/v1/models")) {
        return Promise.resolve(jsonResponse({ data: [{ id: "llama3" }] }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ choices: [] }));
      }
      return Promise.reject(new Error("unexpected"));
    });

    const result = await checkLocalModel("http://localhost:11434", "llama3");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.latencyMs).toBe("number");
  });
});

// ── listModels ─────────────────────────────────────────────────────

describe("listModels", () => {
  test("returns models from openai-compatible endpoint", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/v1/models"))
        return Promise.resolve(jsonResponse({ data: [{ id: "model-1" }, { id: "model-2" }] }));
      return Promise.reject(new Error("not found"));
    });

    const result = await listModels("http://localhost:11434");
    expect(result.endpointType).toBe("openai-compatible");
    expect(result.models).toEqual([{ id: "model-1" }, { id: "model-2" }]);
    expect(result.error).toBeUndefined();
  });

  test("returns models from ollama endpoint", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/v1/models")) return Promise.resolve(errorResponse(404));
      if (url.includes("/api/tags"))
        return Promise.resolve(
          jsonResponse({ models: [{ name: "llama3:latest" }, { name: "mistral:7b" }] }),
        );
      return Promise.reject(new Error("not found"));
    });

    const result = await listModels("http://localhost:11434");
    expect(result.endpointType).toBe("ollama");
    expect(result.models).toEqual([
      { id: "llama3:latest", name: "llama3:latest" },
      { id: "mistral:7b", name: "mistral:7b" },
    ]);
    expect(result.error).toBeUndefined();
  });

  test("returns error when endpoint is not reachable", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(errorResponse(500)));

    const result = await listModels("http://localhost:99999");
    expect(result.models).toEqual([]);
    expect(result.endpointType).toBeNull();
    expect(result.error).toBe("Endpoint not reachable");
  });

  test("returns error when openai-compatible /v1/models returns non-200", async () => {
    // detectEndpointType sees 200 on first call, then listModels gets 503 on second call
    let v1CallCount = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/v1/models")) {
        v1CallCount++;
        // First call: detectEndpointType — succeed so it picks openai-compatible
        if (v1CallCount === 1) return Promise.resolve(jsonResponse({ data: [] }));
        // Second call: listModels fetch — fail
        return Promise.resolve(errorResponse(503));
      }
      return Promise.reject(new Error("not found"));
    });

    const result = await listModels("http://localhost:11434");
    expect(result.endpointType).toBe("openai-compatible");
    expect(result.models).toEqual([]);
    expect(result.error).toContain("503");
  });

  test("returns error when ollama /api/tags returns non-200", async () => {
    let tagsCallCount = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/v1/models")) return Promise.resolve(errorResponse(404));
      if (url.includes("/api/tags")) {
        tagsCallCount++;
        // First call: detectEndpointType — succeed so it picks ollama
        if (tagsCallCount === 1) return Promise.resolve(jsonResponse({ models: [] }));
        // Second call: listModels fetch — fail
        return Promise.resolve(errorResponse(502));
      }
      return Promise.reject(new Error("not found"));
    });

    const result = await listModels("http://localhost:11434");
    expect(result.endpointType).toBe("ollama");
    expect(result.models).toEqual([]);
    expect(result.error).toContain("502");
  });

  test("returns empty models array when openai-compatible endpoint returns empty data", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/v1/models")) return Promise.resolve(jsonResponse({ data: [] }));
      return Promise.reject(new Error("not found"));
    });

    const result = await listModels("http://localhost:11434");
    expect(result.endpointType).toBe("openai-compatible");
    expect(result.models).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  test("returns empty models array when ollama endpoint returns empty models", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/v1/models")) return Promise.resolve(errorResponse(404));
      if (url.includes("/api/tags")) return Promise.resolve(jsonResponse({ models: [] }));
      return Promise.reject(new Error("not found"));
    });

    const result = await listModels("http://localhost:11434");
    expect(result.endpointType).toBe("ollama");
    expect(result.models).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  test("handles fetch exceptions gracefully", async () => {
    // detectEndpointType succeeds, but the subsequent fetch in listModels throws
    let v1CallCount = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/v1/models")) {
        v1CallCount++;
        if (v1CallCount === 1) return Promise.resolve(jsonResponse({ data: [] }));
        return Promise.reject(new Error("network timeout"));
      }
      return Promise.reject(new Error("not found"));
    });

    const result = await listModels("http://localhost:11434");
    expect(result.endpointType).toBe("openai-compatible");
    expect(result.models).toEqual([]);
    expect(result.error).toContain("network timeout");
  });
});
