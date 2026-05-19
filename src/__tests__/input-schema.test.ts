import { test, expect, describe, mock, beforeEach } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { parseArgs } from "../cli";
import type { InputField, InputSchema } from "../types";

// ── Agent schema shape tests ────────────────────────────────────────

describe("agent input schemas", () => {
  describe("summarizer", () => {
    test("has correct schema fields", async () => {
      const agent = (await import("../agents/summarizer.agent")).default;
      const schema = agent.inputSchema!;

      expect(Object.keys(schema)).toEqual(["text", "file", "provider", "model"]);

      expect(schema.text).toMatchObject({ type: "text", label: "Text", required: true });
      expect(schema.file).toMatchObject({ type: "file-path", label: "File" });
      expect((schema.file as InputField).required).toBeUndefined();

      expect(schema.provider).toMatchObject({
        type: "select",
        label: "Provider",
        options: ["anthropic", "google", "openai"],
        default: "anthropic",
      });

      expect(schema.model).toMatchObject({ type: "string", label: "Model" });
      expect((schema.model as InputField).required).toBeUndefined();
    });
  });

  describe("shell-runner", () => {
    test("has correct schema fields", async () => {
      const agent = (await import("../agents/shell-runner.agent")).default;
      const schema = agent.inputSchema!;

      expect(Object.keys(schema)).toEqual(["command", "cwd"]);

      expect(schema.command).toMatchObject({
        type: "string",
        label: "Command",
        required: true,
      });

      expect(schema.cwd).toMatchObject({ type: "file-path", label: "Working Directory" });
      expect((schema.cwd as InputField).required).toBeUndefined();
    });
  });
});

// ── parseArgs input tests ───────────────────────────────────────────

describe("parseArgs input handling", () => {
  test("input is undefined when --input is not provided", () => {
    const parsed = parseArgs(["run", "shell-runner"]);
    expect(parsed.input).toBeUndefined();
  });

  test("input is parsed when --input is provided", () => {
    const parsed = parseArgs(["run", "shell-runner", "--input", '{"command":"ls"}']);
    expect(parsed.input).toEqual({ command: "ls" });
  });
});

// ── promptForInput tests ────────────────────────────────────────────

describe("promptForInput", () => {
  let answers: string[];
  let stdoutWrites: string[];
  const originalStdoutWrite = process.stdout.write;

  function makeRl() {
    return {
      question: mock(async (_prompt: string) => {
        return answers.shift() ?? "";
      }),
      close: mock(() => {}),
    };
  }

  // We mock createInterface at the module level
  let rlInstance: ReturnType<typeof makeRl>;

  mock.module("node:readline/promises", () => ({
    createInterface: () => {
      rlInstance = makeRl();
      return rlInstance;
    },
  }));

  beforeEach(() => {
    answers = [];
    stdoutWrites = [];
    process.stdout.write = mock((...args: unknown[]) => {
      stdoutWrites.push(String(args[0]));
      return true;
    }) as typeof process.stdout.write;
  });

  // Restore stdout after all tests in this describe
  afterAll(() => {
  restoreModuleMocks();
    process.stdout.write = originalStdoutWrite;
  });

  async function prompt(schema: InputSchema) {
    // Re-import to use mocked readline
    const { promptForInput } = await import("../ui/prompt");
    return promptForInput(schema);
  }

  test("string field returns user input", async () => {
    answers = ["hello world"];
    const result = await prompt({
      name: { type: "string", label: "Name" },
    });
    expect(result.name).toBe("hello world");
  });

  test("string field with default returns default on empty input", async () => {
    answers = [""];
    const result = await prompt({
      name: { type: "string", label: "Name", default: "fallback" },
    });
    expect(result.name).toBe("fallback");
  });

  test("text field collects multi-line input", async () => {
    answers = ["line one", "line two", ""];
    const result = await prompt({
      body: { type: "text", label: "Body" },
    });
    expect(result.body).toBe("line one\nline two");
  });

  test("text field with default on empty", async () => {
    answers = [""];
    const result = await prompt({
      body: { type: "text", label: "Body", default: "default text" },
    });
    expect(result.body).toBe("default text");
  });

  test("number field parses numeric input", async () => {
    answers = ["42"];
    const result = await prompt({
      count: { type: "number", label: "Count" },
    });
    expect(result.count).toBe(42);
  });

  test("number field returns default on empty input", async () => {
    answers = [""];
    const result = await prompt({
      count: { type: "number", label: "Count", default: 10 },
    });
    expect(result.count).toBe(10);
  });

  test("boolean field returns true for 'y'", async () => {
    answers = ["y"];
    const result = await prompt({
      flag: { type: "boolean", label: "Enable" },
    });
    expect(result.flag).toBe(true);
  });

  test("boolean field returns false for 'n'", async () => {
    answers = ["n"];
    const result = await prompt({
      flag: { type: "boolean", label: "Enable" },
    });
    expect(result.flag).toBe(false);
  });

  test("boolean field returns default on empty", async () => {
    answers = [""];
    const result = await prompt({
      flag: { type: "boolean", label: "Enable", default: true },
    });
    expect(result.flag).toBe(true);
  });

  test("select field by number", async () => {
    answers = ["2"];
    const result = await prompt({
      provider: { type: "select", label: "Provider", options: ["a", "b", "c"] },
    });
    expect(result.provider).toBe("b");
  });

  test("select field by name", async () => {
    answers = ["anthropic"];
    const result = await prompt({
      provider: { type: "select", label: "Provider", options: ["anthropic", "google"] },
    });
    expect(result.provider).toBe("anthropic");
  });

  test("select field returns default on empty", async () => {
    answers = [""];
    const result = await prompt({
      provider: { type: "select", label: "Provider", options: ["anthropic", "google"], default: "google" },
    });
    expect(result.provider).toBe("google");
  });

  test("file-path field works like string", async () => {
    answers = ["/tmp/test.txt"];
    const result = await prompt({
      path: { type: "file-path", label: "File" },
    });
    expect(result.path).toBe("/tmp/test.txt");
  });

  test("custom type falls back to string prompt", async () => {
    answers = ["custom-value"];
    const result = await prompt({
      widget: { type: "custom", label: "Widget", component: "MyWidget" },
    });
    expect(result.widget).toBe("custom-value");
  });

  test("required marker appears in prompt", async () => {
    answers = ["val"];
    await prompt({
      name: { type: "string", label: "Name", required: true },
    });
    // The question call should contain "(required)" — it goes through rl.question
    const questionCalls = rlInstance.question.mock.calls;
    const allQuestions = questionCalls.map((c: unknown[]) => String(c[0])).join("");
    expect(allQuestions).toContain("(required)");
  });

  test("required string field re-prompts on empty input", async () => {
    answers = ["", "valid"];
    const result = await prompt({
      name: { type: "string", label: "Name", required: true },
    });
    expect(result.name).toBe("valid");
    expect(stdoutWrites).toContain("This field is required. Please enter a value.\n");
  });

  test("required boolean field re-prompts on empty input", async () => {
    answers = ["", "y"];
    const result = await prompt({
      flag: { type: "boolean", label: "Enable", required: true },
    });
    expect(result.flag).toBe(true);
    expect(stdoutWrites).toContain("This field is required. Please enter y or n.\n");
  });

  test("required select field re-prompts on invalid input", async () => {
    answers = ["invalid", "1"];
    const result = await prompt({
      choice: { type: "select", label: "Choice", options: ["a", "b"], required: true },
    });
    expect(result.choice).toBe("a");
    expect(stdoutWrites).toContain("Please select a valid option.\n");
  });

  test("required text field re-prompts on empty input", async () => {
    answers = ["", "actual content", ""];
    const result = await prompt({
      body: { type: "text", label: "Body", required: true },
    });
    expect(result.body).toBe("actual content");
    expect(stdoutWrites).toContain("This field is required. Please enter a value.\n");
  });

  test("text field with empty input returns default", async () => {
    answers = [""];
    const result = await prompt({
      body: { type: "text", label: "Body", default: "default text" },
    });
    expect(result.body).toBe("default text");
  });

  test("EOF returns partial results", async () => {
    let callCount = 0;
    // Override the mock to throw on second call (simulating EOF)
    mock.module("node:readline/promises", () => ({
      createInterface: () => {
        const inst = makeRl();
        inst.question = mock(async (_prompt: string) => {
          callCount++;
          if (callCount === 1) return "first-value";
          throw new Error("readline was closed");
        });
        rlInstance = inst;
        return inst;
      },
    }));

    const result = await prompt({
      a: { type: "string", label: "A" },
      b: { type: "string", label: "B" },
    });
    expect(result.a).toBe("first-value");
    expect(result.b).toBeUndefined();

    // Restore original mock
    mock.module("node:readline/promises", () => ({
      createInterface: () => {
        rlInstance = makeRl();
        return rlInstance;
      },
    }));
  });

  test("number 0 returns 0 (not skipped as falsy)", async () => {
    answers = ["0"];
    const result = await prompt({
      count: { type: "number", label: "Count" },
    });
    expect(result.count).toBe(0);
  });

  test("negative number returns negative value", async () => {
    answers = ["-5"];
    const result = await prompt({
      count: { type: "number", label: "Count" },
    });
    expect(result.count).toBe(-5);
  });

  test("float number returns float value", async () => {
    answers = ["3.14"];
    const result = await prompt({
      count: { type: "number", label: "Count" },
    });
    expect(result.count).toBe(3.14);
  });

  test("boolean 'yes' returns true", async () => {
    answers = ["yes"];
    const result = await prompt({
      flag: { type: "boolean", label: "Enable" },
    });
    expect(result.flag).toBe(true);
  });

  test("boolean 'YES' returns true (case insensitive)", async () => {
    answers = ["YES"];
    const result = await prompt({
      flag: { type: "boolean", label: "Enable" },
    });
    expect(result.flag).toBe(true);
  });

  test("boolean 'no' returns false", async () => {
    answers = ["no"];
    const result = await prompt({
      flag: { type: "boolean", label: "Enable" },
    });
    expect(result.flag).toBe(false);
  });

  test("select out-of-range on non-required returns raw string", async () => {
    answers = ["99"];
    const result = await prompt({
      choice: { type: "select", label: "Choice", options: ["a", "b", "c"] },
    });
    expect(result.choice).toBe("99");
  });

  test("multiple required fields both get values", async () => {
    answers = ["Alice", "Bob"];
    const result = await prompt({
      first: { type: "string", label: "First", required: true },
      last: { type: "string", label: "Last", required: true },
    });
    expect(result.first).toBe("Alice");
    expect(result.last).toBe("Bob");
  });

  test("mixed required/optional — empty optional is omitted", async () => {
    answers = ["Alice", ""];
    const result = await prompt({
      first: { type: "string", label: "First", required: true },
      nick: { type: "string", label: "Nickname" },
    });
    expect(result.first).toBe("Alice");
    expect(result).not.toHaveProperty("nick");
  });

  test("description is shown in stdout", async () => {
    answers = ["val"];
    await prompt({
      name: { type: "string", label: "Name", description: "Enter your full name" },
    });
    expect(stdoutWrites.some((s) => s.includes("Enter your full name"))).toBe(true);
  });

  test("default value appears in prompt text", async () => {
    answers = [""];
    await prompt({
      name: { type: "string", label: "Name", default: "defaultVal" },
    });
    const questionCalls = rlInstance.question.mock.calls;
    const allQuestions = questionCalls.map((c: unknown[]) => String(c[0])).join("");
    expect(allQuestions).toContain("[defaultVal]");
  });

  test("empty schema returns empty object", async () => {
    const result = await prompt({});
    expect(result).toEqual({});
  });

  test("required number re-prompts on empty then accepts valid input", async () => {
    answers = ["", "42"];
    const result = await prompt({
      count: { type: "number", label: "Count", required: true },
    });
    expect(result.count).toBe(42);
    expect(stdoutWrites).toContain("Please enter a valid number.\n");
  });
});

// Need afterAll at module level for import
import { afterAll } from "bun:test";
