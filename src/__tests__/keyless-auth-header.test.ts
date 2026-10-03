import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import { KEYLESS_TOKEN, authCallOptions, withKeylessAuth } from "../providers/credentials";

/**
 * The keyless placeholder must never reach the wire as a bearer token.
 *
 * ## The bug
 *
 * With no key saved, Kilo's credential is the placeholder `no-key-needed`,
 * which pi-ai forwarded as `Authorization: Bearer no-key-needed`. Kilo's
 * gateway used to ignore that on free models; it now rejects it. Measured side
 * by side, same free model, same minute:
 *
 *   no Authorization header        → 200
 *   Bearer no-key-needed           → 401 INVALID_TOKEN
 *
 * so every keyless Kilo turn failed with "Your authentication token is
 * invalid", and the chat showed "Kilo is unavailable right now".
 *
 * ## Why this is not a tautology
 *
 * The wire tests do not inspect the helper's return value — they drive the
 * REAL pi-ai client (and so the real OpenAI SDK) at a local HTTP server and
 * read the Authorization header that server actually received, for both
 * paths the app uses: options headers (direct calls) and model headers (the
 * chat Agent). They also require a REAL key to still arrive, so a fix that
 * simply dropped auth everywhere fails. The source scan then holds every
 * direct call site to the helper, since a single missed site is exactly how
 * this returns.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");

let server: ReturnType<typeof Bun.serve>;
let received: (string | null)[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      received.push(req.headers.get("authorization"));
      // Minimal OpenAI-compatible streamed chat completion.
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const body = chunk({ role: "assistant", content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
});
afterAll(() => server.stop(true));

function localModel(): Model<Api> {
  return {
    id: "m",
    name: "m",
    api: "openai-completions",
    provider: "kilo",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8000,
    maxTokens: 100,
  } as Model<Api>;
}

async function authSent(model: Model<Api>, options: Record<string, unknown>): Promise<string | null> {
  received = [];
  await complete(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, options);
  expect(received).toHaveLength(1);
  return received[0] ?? null;
}

describe("on the wire — what a server actually receives", () => {
  test("direct calls: the keyless placeholder sends NO Authorization header", async () => {
    expect(await authSent(localModel(), authCallOptions(KEYLESS_TOKEN))).toBeNull();
  });

  test("direct calls: a real key is still sent as a bearer", async () => {
    expect(await authSent(localModel(), authCallOptions("sk-real-key"))).toBe("Bearer sk-real-key");
  });

  test("POSITIVE CONTROL: the raw placeholder, as the app used to send it, IS sent", async () => {
    // Proves the server really sees the header when nothing suppresses it,
    // so the null above is the fix working and not a server that drops auth.
    expect(await authSent(localModel(), { apiKey: KEYLESS_TOKEN })).toBe(`Bearer ${KEYLESS_TOKEN}`);
  });

  test("chat Agent path: a keyless model sends no Authorization, a keyed one does", async () => {
    expect(await authSent(withKeylessAuth(localModel(), KEYLESS_TOKEN), { apiKey: KEYLESS_TOKEN })).toBeNull();
    expect(await authSent(withKeylessAuth(localModel(), "sk-real-key"), { apiKey: "sk-real-key" })).toBe(
      "Bearer sk-real-key",
    );
  });
});

describe("the helpers never touch a real key", () => {
  test("authCallOptions passes a real key through unchanged, with no header override", () => {
    expect(authCallOptions("sk-abc")).toEqual({ apiKey: "sk-abc" });
  });

  test("withKeylessAuth returns the same model for a real key and keeps existing headers otherwise", () => {
    const model = { ...localModel(), headers: { "X-Title": "EZCorp" } };
    expect(withKeylessAuth(model, "sk-abc")).toBe(model);
    const keyless = withKeylessAuth(model, KEYLESS_TOKEN) as { headers: Record<string, string | null> };
    expect(keyless.headers["X-Title"]).toBe("EZCorp");
    expect(keyless.headers.Authorization).toBeNull();
    // The input model is not mutated — it may be shared across turns.
    expect((model.headers as Record<string, unknown>).Authorization).toBeUndefined();
  });
});

describe("every call site goes through the rule", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(path);
      return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
    });
  }

  // Sites that hand a raw token onward to OUR OWN wrapper rather than to
  // pi-ai. Each is allowed only because the wrapper it feeds applies the rule,
  // and that is asserted below — an exception without that proof fails.
  const PASS_THROUGH: Record<string, { consumer: string; applies: string }> = {
    "src/runtime/goal-host.ts": { consumer: "src/lib/pi-complete.ts", applies: "authCallOptions(opts.apiKey)" },
    "src/runtime/stream-chat/context-summarize.ts": {
      consumer: "src/runtime/stream-chat/context-summarize.ts",
      applies: "authCallOptions(apiKey)",
    },
  };

  test("no source hands a raw credential token to pi-ai as apiKey", () => {
    // `apiKey: cred.token` and friends bypass the keyless rule. Each such site
    // must spread authCallOptions(token) instead. Comment lines are ignored:
    // prose that names the old pattern is not a call.
    const offenders = sourceFiles(join(REPO_ROOT, "src"))
      .filter((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .some((line) => !/^\s*(\*|\/\/)/.test(line) && /apiKey:\s*[\w.]+\.token\b/.test(line)),
      )
      .map((file) => file.slice(REPO_ROOT.length + 1))
      .filter((file) => !(file in PASS_THROUGH));
    expect(offenders).toEqual([]);
  });

  test.each(Object.entries(PASS_THROUGH))("pass-through %s reaches the rule downstream", (_site, { consumer, applies }) => {
    expect(readFileSync(join(REPO_ROOT, consumer), "utf8")).toContain(applies);
  });

  test("the chat Agent's model carries the rule", () => {
    const agent = readFileSync(join(REPO_ROOT, "src/runtime/stream-chat/build-pi-agent.ts"), "utf8");
    expect(agent).toMatch(/withKeylessAuth\(\s*resolveModelForCredential\(/);
  });
});
