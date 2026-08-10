import { test, expect, describe, mock } from "bun:test";
import { configToAgent } from "../runtime/config-to-agent";
import type { AgentConfig, AgentContext } from "../types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "A test agent",
    capabilities: ["llm"],
    prompt: "You are a helpful assistant.",
    ...overrides,
  };
}

function makeMockCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    input: {},
    llm: {
      complete: mock(async () => ({ text: "mock response" })),
    },
    shell: { run: mock(async () => ({ stdout: "", stderr: "", exitCode: 0 })) },
    file: {
      read: mock(async () => ""),
      write: mock(async () => {}),
      exists: mock(async () => false),
    },
    log: mock(() => {}),
    signal: new AbortController().signal,
    run: mock(async () => ({ success: true, output: null })),
    ...overrides,
  };
}

describe("configToAgent", () => {
  test("creates AgentDefinition with correct metadata", () => {
    const config = makeConfig();
    const agent = configToAgent(config);

    expect(agent.name).toBe("test-agent");
    expect(agent.description).toBe("A test agent");
    expect(agent.capabilities).toEqual(["llm"]);
    expect(typeof agent.execute).toBe("function");
  });

  test("execute calls llm.complete with prompt as system", async () => {
    const config = makeConfig({ prompt: "Summarize this." });
    const agent = configToAgent(config);
    const ctx = makeMockCtx({ input: { text: "hello world" } });

    const result = await agent.execute(ctx);

    expect(result.success).toBe(true);
    expect(result.output).toBe("mock response");
    expect(ctx.llm.complete).toHaveBeenCalledTimes(1);

    const [messages, opts] = (ctx.llm.complete as any).mock.calls[0];
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("hello world");
    expect(opts.system).toBe("Summarize this.");
  });

  test("outputFormat json parses response", async () => {
    const config = makeConfig({ outputFormat: "json" });
    const agent = configToAgent(config);
    const ctx = makeMockCtx();
    (ctx.llm.complete as any).mockImplementation(async () => ({
      text: '{"key": "value"}',
    }));

    const result = await agent.execute(ctx);

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ key: "value" });
  });

  test("outputFormat json returns error on invalid JSON", async () => {
    const config = makeConfig({ outputFormat: "json" });
    const agent = configToAgent(config);
    const ctx = makeMockCtx();
    (ctx.llm.complete as any).mockImplementation(async () => ({
      text: "not valid json",
    }));

    const result = await agent.execute(ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to parse");
  });

  test("passes provider/model/temperature/maxTokens to llm options", async () => {
    const config = makeConfig({
      provider: "openai",
      model: "gpt-4",
      temperature: 0.5,
      maxTokens: 100,
    });
    const agent = configToAgent(config);
    const ctx = makeMockCtx();

    await agent.execute(ctx);

    const [, opts] = (ctx.llm.complete as any).mock.calls[0];
    expect(opts.provider).toBe("openai");
    expect(opts.model).toBe("gpt-4");
    expect(opts.temperature).toBe(0.5);
    expect(opts.maxTokens).toBe(100);
  });

  test("serializes all input fields into user message", async () => {
    const config = makeConfig();
    const agent = configToAgent(config);
    const ctx = makeMockCtx({
      input: { name: "Alice", count: 3, nested: { a: 1 } },
    });

    await agent.execute(ctx);

    const [messages] = (ctx.llm.complete as any).mock.calls[0];
    expect(messages[0].content).toContain("name: Alice");
    expect(messages[0].content).toContain("count: 3");
    expect(messages[0].content).toContain("nested:");
  });
});

/**
 * Why the ez-factory prompts specify an OBJECT WITH NAMED KEYS.
 *
 * A workflow gates a downstream step on `$steps.<verify>.output.valid`.
 * These four cases are the whole reason that guard was unfireable, and
 * they are asserted here — against `configToAgent` itself — rather than
 * only against the prompt text, because the prompt is steering and this
 * is the mechanism it steers away from.
 */
describe("what `$steps.<name>.output.valid` actually resolves to", () => {
  async function outputFor(text: string, outputFormat?: "text" | "json") {
    const agent = configToAgent(makeConfig(outputFormat ? { outputFormat } : {}));
    const ctx = makeMockCtx();
    (
      ctx.llm.complete as unknown as { mockImplementation: (f: () => unknown) => void }
    ).mockImplementation(async () => ({ text }));
    return agent.execute(ctx);
  }

  test("text mode leaves output a STRING — `.valid` is undefined, the guard never fires", async () => {
    const result = await outputFor('{"valid": true}');
    expect(result.success).toBe(true);
    expect(typeof result.output).toBe("string");
    expect((result.output as unknown as { valid?: boolean }).valid).toBeUndefined();
  });

  test("json mode + a bare `true` parses fine and `.valid` is STILL undefined", async () => {
    // The trap the contract exists to close. `JSON.parse("true")` succeeds,
    // so this does NOT fail closed — it succeeds with an unreadable answer.
    const result = await outputFor("true", "json");
    expect(result.success).toBe(true);
    expect(result.output).toBe(true);
    expect((result.output as unknown as { valid?: boolean }).valid).toBeUndefined();
  });

  test("json mode + a named-key OBJECT is the only shape that resolves", async () => {
    const result = await outputFor('{"valid": false, "errors": []}', "json");
    expect(result.success).toBe(true);
    expect((result.output as { valid: boolean }).valid).toBe(false);
  });

  test("a fenced reply FAILS CLOSED — prose where a verdict was expected fails the run", async () => {
    // The good half of the risk profile: a verification step that answers
    // in prose terminalizes the run rather than reading as "no objection".
    const result = await outputFor('```json\n{"valid": true}\n```', "json");
    expect(result.success).toBe(false);
    expect(result.output).toBeNull();
    expect(result.error).toContain("Failed to parse");
  });
});

/**
 * The json-mode failure must stay LEGIBLE.
 *
 * The tokens are already spent by the time `JSON.parse` throws, so the
 * response text is the only evidence anyone will ever get about WHY a run
 * terminalized. A bare `catch` that returns one fixed sentence makes "the
 * model returned prose", "the model returned a fenced code block" and "the
 * model returned nothing at all" indistinguishable after the fact — three
 * different bugs (bad prompt / bad output-format contract / dead provider)
 * with three different fixes, collapsed into one unactionable string.
 *
 * These tests pin the DIAGNOSTIC content only. The verdict is unchanged:
 * every one of these still fails closed (see the fenced-reply invariant
 * above) — this file is deliberately asserting `success === false` in each
 * case so a future "just parse the fence" change has to face that test.
 */
describe("json-mode parse failure preserves the evidence", () => {
  async function errorFor(text: string): Promise<string> {
    const agent = configToAgent(makeConfig({ outputFormat: "json" }));
    const ctx = makeMockCtx();
    (
      ctx.llm.complete as unknown as { mockImplementation: (f: () => unknown) => void }
    ).mockImplementation(async () => ({ text }));
    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.output).toBeNull();
    return String(result.error);
  }

  test("an EMPTY response is named as empty and carries no snippet to mislead", async () => {
    const error = await errorFor("");
    expect(error).toContain("Failed to parse");
    expect(error).toContain("empty");
    expect(error).toContain("0 chars");
  });

  test("a whitespace-only response counts as empty, not as prose", async () => {
    const error = await errorFor("   \n\t  ");
    expect(error).toContain("empty");
    // The raw length is still reported — "empty" here means "no content",
    // not "zero bytes", and conflating them hides a whitespace-spewing model.
    expect(error).toContain("7 chars");
  });

  test("a FENCED code block is named as fenced — the fix is the prompt, not the provider", async () => {
    const error = await errorFor('```json\n{"valid": true}\n```');
    expect(error).toContain("fenced");
    // The evidence itself survives, so an operator can see the fence.
    expect(error).toContain("```json");
  });

  test("PROSE is named as prose and quoted back", async () => {
    const error = await errorFor("I'm sorry, I can't help with that request.");
    expect(error).toContain("prose");
    expect(error).toContain("I'm sorry, I can't help");
  });

  test("a JSON-SHAPED but broken reply is named as malformed, not as prose", async () => {
    // "the model tried and fumbled the syntax" and "the model answered in
    // English" have different fixes (bigger model vs. better prompt).
    const error = await errorFor('{"valid": tru}');
    expect(error).toContain("malformed JSON");
    expect(error).not.toContain("prose");
  });

  test("the three shapes produce three DIFFERENT errors (the whole point)", async () => {
    const empty = await errorFor("");
    const fenced = await errorFor('```json\n{"ok":1}\n```');
    const prose = await errorFor("no thanks");
    expect(new Set([empty, fenced, prose]).size).toBe(3);
  });

  test("the underlying JSON.parse message is preserved, not swallowed", async () => {
    const error = await errorFor("{unquoted: 1}");
    // Whatever the engine calls it, the parser's own complaint is in there.
    expect(error.toLowerCase()).toContain("json");
    expect(error.length).toBeGreaterThan("Failed to parse LLM response as JSON".length);
  });

  test("a huge response is TRUNCATED — evidence, not a log bomb", async () => {
    const huge = `x${"y".repeat(50_000)}`;
    const error = await errorFor(huge);
    expect(error.length).toBeLessThan(1_000);
    expect(error).toContain("50001 chars");
    expect(error).toContain("truncated");
  });

  test("a non-string `text` still RETURNS a failure — it must never throw out of execute", async () => {
    // `AgentContext.llm` is `any`, so a worker stub or an extension-supplied
    // llm can hand back `{ text: undefined }`. `JSON.parse` copes (it
    // stringifies, then throws) and the diagnostic must too — a TypeError
    // escaping `execute` would be a worse regression than the anonymous
    // error this whole change exists to remove.
    const agent = configToAgent(makeConfig({ outputFormat: "json" }));
    const ctx = makeMockCtx();
    (
      ctx.llm.complete as unknown as { mockImplementation: (f: () => unknown) => void }
    ).mockImplementation(async () => ({ text: undefined }));

    const result = await agent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to parse");
    expect(result.error).toContain("empty");
  });

  test("a response at/below the snippet limit is quoted whole, untruncated", async () => {
    const short = `"unterminated`;
    const error = await errorFor(short);
    expect(error).toContain(short);
    expect(error).not.toContain("truncated");
  });
});
