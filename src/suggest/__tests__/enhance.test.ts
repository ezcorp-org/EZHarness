import { test, expect, describe, beforeEach } from "bun:test";
import {
  isEnhanceAvailable,
  resetEnhanceProbe,
  enhancePrompt,
  parseEnhanceResponse,
  ENHANCE_PROBE_TTL_MS,
} from "../enhance";

const CFG = { baseUrl: "http://localhost:11434/", model: "qwen3:1.7b", timeoutMs: 5000 };

function completionResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

beforeEach(() => {
  resetEnhanceProbe();
});

describe("isEnhanceAvailable", () => {
  test("reachable /v1/models → true; result is TTL-cached", async () => {
    let calls = 0;
    const fetchFn = (async (url: RequestInfo | URL) => {
      calls++;
      expect(String(url)).toBe("http://localhost:11434/v1/models");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    expect(await isEnhanceAvailable(CFG.baseUrl, { fetchFn, nowFn: () => 1000 })).toBe(true);
    expect(await isEnhanceAvailable(CFG.baseUrl, { fetchFn, nowFn: () => 2000 })).toBe(true);
    expect(calls).toBe(1);
  });

  test("failure is ALSO cached, and re-probes after the TTL", async () => {
    let calls = 0;
    let status = 500;
    const fetchFn = (async () => {
      calls++;
      return new Response("", { status });
    }) as unknown as typeof fetch;

    expect(await isEnhanceAvailable(CFG.baseUrl, { fetchFn, nowFn: () => 0 })).toBe(false);
    expect(await isEnhanceAvailable(CFG.baseUrl, { fetchFn, nowFn: () => 10 })).toBe(false);
    expect(calls).toBe(1);
    status = 200;
    expect(
      await isEnhanceAvailable(CFG.baseUrl, { fetchFn, nowFn: () => ENHANCE_PROBE_TTL_MS + 1 }),
    ).toBe(true);
    expect(calls).toBe(2);
  });

  test("network error → false", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await isEnhanceAvailable(CFG.baseUrl, { fetchFn, nowFn: () => 0 })).toBe(false);
  });
});

describe("parseEnhanceResponse", () => {
  test("plain JSON object parses", () => {
    expect(parseEnhanceResponse('{"enhanced":"Do X","reason":"clearer"}')).toEqual({
      enhanced: "Do X",
      reason: "clearer",
    });
  });

  test("strips <think> blocks and surrounding prose", () => {
    const content = '<think>hmm\nokay</think>Sure! {"enhanced":"Do X","reason":"r"} done.';
    expect(parseEnhanceResponse(content)).toEqual({ enhanced: "Do X", reason: "r" });
  });

  test("no JSON object → null", () => {
    expect(parseEnhanceResponse("I cannot help with that")).toBeNull();
  });

  test("malformed JSON → null", () => {
    expect(parseEnhanceResponse('{"enhanced": oops}')).toBeNull();
  });

  test("empty enhanced → null", () => {
    expect(parseEnhanceResponse('{"enhanced":"  ","reason":"r"}')).toBeNull();
  });

  test("non-string fields tolerated → reason defaults empty, bad enhanced → null", () => {
    expect(parseEnhanceResponse('{"enhanced":"ok","reason":42}')).toEqual({ enhanced: "ok", reason: "" });
    expect(parseEnhanceResponse('{"enhanced":42,"reason":"r"}')).toBeNull();
  });

  test("over-long enhanced → null", () => {
    expect(
      parseEnhanceResponse(JSON.stringify({ enhanced: "x".repeat(5000), reason: "r" })),
    ).toBeNull();
  });
});

describe("enhancePrompt", () => {
  const ctx = {
    modeName: "Plan",
    modeDescription: "Planning mode",
    tools: [{ name: "scan", description: "Scan code" }],
  };

  test("happy path: sends schema-constrained request, parses result", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://localhost:11434/v1/chat/completions");
      body = JSON.parse(String(init?.body));
      return completionResponse('{"enhanced":"Scan src/ for lint errors","reason":"specific"}');
    }) as unknown as typeof fetch;

    const out = await enhancePrompt("check my code", ctx, CFG, { fetchFn });
    expect(out).toEqual({ enhanced: "Scan src/ for lint errors", reason: "specific" });
    expect(body.model).toBe("qwen3:1.7b");
    expect(body.response_format).toBeDefined();
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toContain("/no_think");
    expect(messages[1]!.content).toContain("Active mode: Plan — Planning mode");
    expect(messages[1]!.content).toContain("- scan: Scan code");
    expect(messages[1]!.content).toContain("check my code");
  });

  test("context without mode/tools omits those sections", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return completionResponse('{"enhanced":"e","reason":"r"}');
    }) as unknown as typeof fetch;

    await enhancePrompt("draft", { tools: [] }, CFG, { fetchFn });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[1]!.content).not.toContain("Active mode");
    expect(messages[1]!.content).not.toContain("Available tools");
  });

  test("response_format rejection retries once without the schema", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.response_format) return new Response("unsupported", { status: 400 });
      return completionResponse('{"enhanced":"e","reason":"r"}');
    }) as unknown as typeof fetch;

    const out = await enhancePrompt("draft", ctx, CFG, { fetchFn });
    expect(out).toEqual({ enhanced: "e", reason: "r" });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.response_format).toBeUndefined();
  });

  test("both attempts failing → null", async () => {
    const fetchFn = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await enhancePrompt("draft", ctx, CFG, { fetchFn })).toBeNull();
  });

  test("non-string content → null", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 })) as unknown as typeof fetch;
    expect(await enhancePrompt("draft", ctx, CFG, { fetchFn })).toBeNull();
  });

  test("network error → null", async () => {
    const fetchFn = (async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    expect(await enhancePrompt("draft", ctx, CFG, { fetchFn })).toBeNull();
  });
});
