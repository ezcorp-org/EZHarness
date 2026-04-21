import { test, expect, describe } from "bun:test";
import summarizerAgent from "../agents/summarizer.agent";
import type { AgentContext, InputField } from "../types";

// ── Helpers ──────────────────────────────────────────────────────────

interface MockLlm {
  lastMessages?: unknown[];
  lastOptions?: Record<string, unknown>;
  responseText?: string;
}

function makeCtx(
  input: Record<string, unknown>,
  llmMock: MockLlm = {},
  fileContent: string = "file content",
  overrides: Partial<AgentContext> = {},
): AgentContext {
  const logs: string[] = [];
  return {
    input,
    llm: {
      async complete(messages: unknown[], options: Record<string, unknown>) {
        llmMock.lastMessages = messages as unknown[];
        llmMock.lastOptions = options;
        return { text: llmMock.responseText ?? "A concise summary." };
      },
    },
    shell: {
      async run() { return { stdout: "", stderr: "", exitCode: 0 }; },
    },
    file: {
      async read(_path: string) { return fileContent; },
      async write() {},
      async exists() { return true; },
    },
    log(message: string) { logs.push(message); },
    signal: new AbortController().signal,
    async run() { return { success: true, output: null }; },
    ...overrides,
  };
}

// ── Agent Definition Structure ────────────────────────────────────────

describe("summarizer agent definition", () => {
  test("has correct name", () => {
    expect(summarizerAgent.name).toBe("summarizer");
  });

  test("has a description", () => {
    expect(typeof summarizerAgent.description).toBe("string");
    expect(summarizerAgent.description.length).toBeGreaterThan(0);
  });

  test("declares llm and file capabilities", () => {
    expect(summarizerAgent.capabilities).toContain("llm");
    expect(summarizerAgent.capabilities).toContain("file");
  });

  test("capabilities is an array", () => {
    expect(Array.isArray(summarizerAgent.capabilities)).toBe(true);
  });

  test("has an execute function", () => {
    expect(typeof summarizerAgent.execute).toBe("function");
  });

  test("has inputSchema defined", () => {
    expect(summarizerAgent.inputSchema).toBeDefined();
  });
});

// ── Input Schema ──────────────────────────────────────────────────────

describe("summarizer inputSchema", () => {
  test("text field is required and type text", () => {
    const schema = summarizerAgent.inputSchema!;
    expect(schema.text).toBeDefined();
    expect(schema.text.type).toBe("text");
    expect(schema.text.required).toBe(true);
  });

  test("file field is optional and type file-path", () => {
    const schema = summarizerAgent.inputSchema!;
    expect(schema.file).toBeDefined();
    expect(schema.file.type).toBe("file-path");
    expect((schema.file as InputField).required).toBeUndefined();
  });

  test("provider field is a select with anthropic/google/openai options", () => {
    const schema = summarizerAgent.inputSchema!;
    expect(schema.provider).toBeDefined();
    expect(schema.provider.type).toBe("select");
    expect(schema.provider.options).toContain("anthropic");
    expect(schema.provider.options).toContain("google");
    expect(schema.provider.options).toContain("openai");
  });

  test("provider field defaults to anthropic", () => {
    expect(summarizerAgent.inputSchema!.provider.default).toBe("anthropic");
  });

  test("model field is type string", () => {
    const schema = summarizerAgent.inputSchema!;
    expect(schema.model).toBeDefined();
    expect(schema.model.type).toBe("string");
  });

  test("all fields have labels", () => {
    const schema = summarizerAgent.inputSchema!;
    for (const [key, field] of Object.entries(schema)) {
      expect(field.label, `field "${key}" should have a label`).toBeTruthy();
    }
  });
});

// ── Execute: validation ───────────────────────────────────────────────

describe("summarizer execute — input validation", () => {
  test("returns error when neither text nor file is provided", async () => {
    const ctx = makeCtx({});
    const result = await summarizerAgent.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.output).toBeNull();
    expect(result.error).toMatch(/text|file/i);
  });
});

// ── Execute: text input path ──────────────────────────────────────────

describe("summarizer execute — text input", () => {
  test("passes provided text directly to LLM", async () => {
    const llm: MockLlm = {};
    const ctx = makeCtx({ text: "Hello world, please summarize me." }, llm);

    const result = await summarizerAgent.execute(ctx);

    expect(result.success).toBe(true);
    const messages = llm.lastMessages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("Hello world, please summarize me.");
  });

  test("includes system prompt in LLM options", async () => {
    const llm: MockLlm = {};
    const ctx = makeCtx({ text: "Some text." }, llm);

    await summarizerAgent.execute(ctx);

    expect(llm.lastOptions?.system).toBeTruthy();
    expect(String(llm.lastOptions!.system)).toMatch(/summariz/i);
  });

  test("returns summary in output.summary", async () => {
    const llm: MockLlm = { responseText: "The text is about greetings." };
    const ctx = makeCtx({ text: "Hello world." }, llm);

    const result = await summarizerAgent.execute(ctx);

    expect(result.success).toBe(true);
    expect((result.output as any).summary).toBe("The text is about greetings.");
  });

  test("does not call ctx.file.read when text is provided", async () => {
    let fileReadCalled = false;
    const ctx = makeCtx({ text: "Direct text." }, {}, "", {
      file: {
        async read() { fileReadCalled = true; return ""; },
        async write() {},
        async exists() { return false; },
      },
      llm: {
        async complete() { return { text: "summary" }; },
      },
    });

    await summarizerAgent.execute(ctx);

    expect(fileReadCalled).toBe(false);
  });
});

// ── Execute: file input path ──────────────────────────────────────────

describe("summarizer execute — file input", () => {
  test("reads file content and passes it to LLM", async () => {
    const llm: MockLlm = {};
    const ctx = makeCtx({ file: "/tmp/notes.txt" }, llm, "Notes from the meeting.");

    const result = await summarizerAgent.execute(ctx);

    expect(result.success).toBe(true);
    const messages = llm.lastMessages as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toBe("Notes from the meeting.");
  });

  test("prefers text over file when both are provided", async () => {
    const llm: MockLlm = {};
    let fileReadCalled = false;
    const ctx = makeCtx({ text: "Inline text.", file: "/tmp/notes.txt" }, llm, "File content.", {
      file: {
        async read() { fileReadCalled = true; return "File content."; },
        async write() {},
        async exists() { return true; },
      },
      llm: {
        async complete(messages: unknown[], options: Record<string, unknown>) {
          llm.lastMessages = messages as unknown[];
          llm.lastOptions = options;
          return { text: "summary" };
        },
      },
    });

    await summarizerAgent.execute(ctx);

    expect(fileReadCalled).toBe(false);
    const messages = llm.lastMessages as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toBe("Inline text.");
  });
});

// ── Execute: provider/model forwarding ───────────────────────────────

describe("summarizer execute — provider and model options", () => {
  test("forwards provider to LLM options when specified", async () => {
    const llm: MockLlm = {};
    const ctx = makeCtx({ text: "Summarize this.", provider: "google" }, llm);

    await summarizerAgent.execute(ctx);

    expect(llm.lastOptions?.provider).toBe("google");
  });

  test("forwards model to LLM options when specified", async () => {
    const llm: MockLlm = {};
    const ctx = makeCtx({ text: "Summarize this.", model: "gemini-pro" }, llm);

    await summarizerAgent.execute(ctx);

    expect(llm.lastOptions?.model).toBe("gemini-pro");
  });

  test("does not include provider key in LLM options when not specified", async () => {
    const llm: MockLlm = {};
    const ctx = makeCtx({ text: "Summarize this." }, llm);

    await summarizerAgent.execute(ctx);

    // provider spread is conditional on truthiness — undefined/empty provider should not inject key
    const hasProvider = "provider" in (llm.lastOptions ?? {}) && llm.lastOptions?.provider;
    expect(hasProvider).toBeFalsy();
  });

  test("does not include model key in LLM options when not specified", async () => {
    const llm: MockLlm = {};
    const ctx = makeCtx({ text: "Summarize this." }, llm);

    await summarizerAgent.execute(ctx);

    const hasModel = "model" in (llm.lastOptions ?? {}) && llm.lastOptions?.model;
    expect(hasModel).toBeFalsy();
  });
});

// ── Execute: logging ──────────────────────────────────────────────────

describe("summarizer execute — logging", () => {
  test("logs when using text input", async () => {
    const logged: string[] = [];
    const ctx = makeCtx({ text: "Some text." }, {}, "", {
      log(msg: string) { logged.push(msg); },
      llm: { async complete() { return { text: "summary" }; } },
    });

    await summarizerAgent.execute(ctx);

    expect(logged.length).toBeGreaterThan(0);
    expect(logged.some((m) => /text/i.test(m))).toBe(true);
  });

  test("logs file path when reading from file", async () => {
    const logged: string[] = [];
    const ctx = makeCtx({ file: "/tmp/report.txt" }, {}, "report content", {
      log(msg: string) { logged.push(msg); },
      file: {
        async read() { return "report content"; },
        async write() {},
        async exists() { return true; },
      },
      llm: { async complete() { return { text: "summary" }; } },
    });

    await summarizerAgent.execute(ctx);

    expect(logged.some((m) => m.includes("/tmp/report.txt"))).toBe(true);
  });

  test("logs completion message after LLM responds", async () => {
    const logged: string[] = [];
    const ctx = makeCtx({ text: "Some text." }, {}, "", {
      log(msg: string) { logged.push(msg); },
      llm: { async complete() { return { text: "done" }; } },
    });

    await summarizerAgent.execute(ctx);

    expect(logged.some((m) => /complet|done|summary/i.test(m))).toBe(true);
  });
});
