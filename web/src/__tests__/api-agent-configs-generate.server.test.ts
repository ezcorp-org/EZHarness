/**
 * Server-handler unit tests for /api/agent-configs/generate (+server.ts).
 *
 * The handler drives an LLM round-trip via pi-ai's `complete` helper.
 * We mock the LLM module, the provider router, the credential lookup,
 * and mode-query so the test runs end-to-end without hitting the wire
 * or PGlite. Covers the auth gate (401), validation (400), LLM error
 * bubbling (500), and the happy-path with <agent_config> extraction.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("@mariozechner/pi-ai", () => ({
  complete: vi.fn(),
}));

vi.mock("$server/providers/router", () => ({
  resolveModel: vi.fn(),
}));

vi.mock("$server/providers/registry", () => ({
  resolveOAuthModel: vi.fn(() => null),
}));

vi.mock("$server/providers/credentials", () => ({
  getCredential: vi.fn(),
}));

vi.mock("$server/db/queries/modes", () => ({
  getMode: vi.fn(async () => null),
}));

const { complete } = await import("@mariozechner/pi-ai");
const { resolveModel } = await import("$server/providers/router");
const { getCredential } = await import("$server/providers/credentials");
const { POST } = await import(
  "../routes/api/agent-configs/generate/+server.ts"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const href = "http://localhost/api/agent-configs/generate";
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    request: new Request(href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

function resolvedModelStub() {
  return {
    provider: "anthropic",
    piModel: {
      id: "claude-test",
      api: "anthropic-messages",
      provider: "anthropic",
      reasoning: false,
    },
  } as any;
}

describe("POST /api/agent-configs/generate", () => {
  beforeEach(() => {
    vi.mocked(complete).mockReset();
    vi.mocked(resolveModel).mockReset();
    vi.mocked(getCredential).mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await POST(
        makeEvent({
          locals: {},
          body: { messages: [{ role: "user", content: "hi" }] },
        }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects 400 when messages array is empty", async () => {
    const res = await POST(
      makeEvent({ locals: { user }, body: { messages: [] } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Validation failed");
  });

  test("rejects 400 when messages field is missing", async () => {
    const res = await POST(makeEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Validation failed");
  });

  test("rejects 400 when thinkingLevel is not one of the allowed values", async () => {
    const res = await POST(
      makeEvent({
        locals: { user },
        body: {
          messages: [{ role: "user", content: "hi" }],
          thinkingLevel: "super",
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 500 when the LLM call returns an error stopReason", async () => {
    vi.mocked(resolveModel).mockResolvedValue(resolvedModelStub());
    vi.mocked(getCredential).mockResolvedValue({
      type: "api-key",
      token: "sk-...",
    } as any);
    vi.mocked(complete).mockResolvedValue({
      stopReason: "error",
      errorMessage: "nope",
      content: [],
    } as any);

    const res = await POST(
      makeEvent({
        locals: { user },
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("nope");
  });

  test("happy path: returns LLM text + extracted agent_config JSON", async () => {
    vi.mocked(resolveModel).mockResolvedValue(resolvedModelStub());
    vi.mocked(getCredential).mockResolvedValue({
      type: "api-key",
      token: "sk-...",
    } as any);
    vi.mocked(complete).mockResolvedValue({
      stopReason: "stop",
      content: [
        {
          type: "text",
          text:
            'Here is your agent: <agent_config>{"name":"test-agent","prompt":"do things"}</agent_config>',
        },
      ],
    } as any);

    const res = await POST(
      makeEvent({
        locals: { user },
        body: { messages: [{ role: "user", content: "design me an agent" }] },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      text: string;
      config: { name: string; prompt: string } | null;
    };
    expect(body.text).toContain("agent_config");
    expect(body.config).not.toBeNull();
    expect(body.config!.name).toBe("test-agent");
    expect(body.config!.prompt).toBe("do things");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test("happy path without <agent_config> tags returns config=null", async () => {
    vi.mocked(resolveModel).mockResolvedValue(resolvedModelStub());
    vi.mocked(getCredential).mockResolvedValue({
      type: "api-key",
      token: "sk-...",
    } as any);
    vi.mocked(complete).mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "Still gathering requirements..." }],
    } as any);

    const res = await POST(
      makeEvent({
        locals: { user },
        body: { messages: [{ role: "user", content: "hi" }] },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; config: unknown };
    expect(body.text).toBe("Still gathering requirements...");
    expect(body.config).toBeNull();
  });

  test("malformed JSON inside <agent_config>: returns config=null, no 500", async () => {
    // Phase 62 sub-plan 06 — third state for the <agent_config> extraction logic.
    // The regex at +server.ts:40 matches the tags, but JSON.parse must fail
    // inside the try/catch at +server.ts:42-49 and fall through to config=null.
    // This complements the happy-path-with-tags case (line 146) and the
    // happy-path-without-tags case (line 181).
    vi.mocked(resolveModel).mockResolvedValue(resolvedModelStub());
    vi.mocked(getCredential).mockResolvedValue({
      type: "api-key",
      token: "tok",
    } as any);
    vi.mocked(complete).mockResolvedValue({
      stopReason: "stop",
      content: [
        {
          type: "text",
          text:
            "Here is a draft: <agent_config>{ name: not-quoted, prompt }</agent_config> — sorry, malformed.",
        },
      ],
    } as any);

    const res = await POST(
      makeEvent({
        locals: { user },
        body: {
          messages: [{ role: "user", content: "Make me an agent" }],
          provider: "anthropic",
          model: "claude-test",
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      text: string;
      config: Record<string, unknown> | null;
    };
    expect(body.config).toBeNull();
    expect(body.text).toContain("agent_config");
  });
});
