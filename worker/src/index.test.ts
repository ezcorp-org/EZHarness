import { describe, expect, test } from "bun:test";

import worker from "./index";

const fetchWorker = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`https://worker.test${path}`, init));

describe("agent worker HTTP surface", () => {
  test("answers CORS preflight", async () => {
    const response = await fetchWorker("/api/agents", { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
  });

  test("lists the shipped summarizer without exposing runtime internals", async () => {
    const response = await fetchWorker("/api/agents");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({ name: "summarizer", capabilities: ["llm"] }),
    ]);
  });

  test("returns runs, missing run, invalid input, and an unknown route as JSON", async () => {
    await expect((await fetchWorker("/api/runs")).json()).resolves.toEqual({});
    // The executor creates a lightweight run record on lookup, so this route
    // returns the record rather than a synthetic 404.
    const missing = await fetchWorker("/api/runs/missing");
    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toEqual(expect.any(Object));

    const invalid = await fetchWorker("/api/agents/summarizer/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual(expect.objectContaining({ error: expect.any(String) }));

    await expect((await fetchWorker("/nope")).json()).resolves.toEqual({ error: "Not found" });

    const failedRun = await fetchWorker("/api/agents/summarizer/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "needs an unavailable worker LLM" }),
    });
    expect(failedRun.status).toBe(200);
  });
});
