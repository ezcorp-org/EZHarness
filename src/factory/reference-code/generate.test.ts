import { describe, expect, test } from "bun:test";
import { fakeReferenceCodeBroker, failingReferenceCodeBroker } from "../../__tests__/helpers/reference-code-broker-fake";
import { REFERENCE_CODE_ACCEPTED_SLUGIFY, referenceCodeLaunchRepository, REFERENCE_CODE_FIXTURE_REQUEST } from "./fixtures";
import {
  generateReferenceCodeCandidate,
  referenceCodeSystemPrompt,
  REFERENCE_CODE_GENERATOR_TOOLS,
  REFERENCE_CODE_MAX_AGENT_ITERATIONS,
  REFERENCE_CODE_MAX_WRITE_BYTES,
  type ReferenceCodeGenerateInput,
} from "./generate";
import { sealReferenceCodeSnapshot } from "./snapshot";

const BASE = "a".repeat(39) + "1";
const MODEL = { provider: "anthropic", model: "claude-haiku-4-5-20251001" };
const decoder = new TextDecoder();

const snapshot = sealReferenceCodeSnapshot({
  baseSha: BASE,
  treeSha: "b".repeat(39) + "2",
  entries: referenceCodeLaunchRepository().map(file => ({ path: file.path, mode: file.mode as string, content: file.content })),
});

function input(broker: ReferenceCodeGenerateInput["broker"], overrides: Partial<ReferenceCodeGenerateInput> = {}): ReferenceCodeGenerateInput {
  return {
    snapshot,
    issue: REFERENCE_CODE_FIXTURE_REQUEST.issue,
    allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
    protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
    remediation: "",
    candidateGeneration: 0,
    broker,
    attemptToken: "attempt-token",
    model: MODEL,
    ...overrides,
  };
}

const writeAccepted = { id: "call-1", name: "write_file", arguments: { path: "src/slugify.ts", content: REFERENCE_CODE_ACCEPTED_SLUGIFY } };
const finish = { id: "call-2", name: "finish", arguments: { summary: "Implemented slugify." } };

describe("the bounded generator agent", () => {
  test("writes the requested file, stops when the agent finishes, and returns a complete tree", async () => {
    const broker = fakeReferenceCodeBroker([
      { toolCalls: [writeAccepted], usage: { input: 900, output: 120 } },
      { toolCalls: [finish], usage: { input: 40, output: 8 } },
    ]);
    const generation = await generateReferenceCodeCandidate(input(broker));
    expect(generation.stopReason).toBe("model-finished");
    expect(generation.iterations).toBe(2);
    expect(generation.files).toHaveLength(snapshot.files.length);
    expect(decoder.decode(generation.files.find(file => file.path === "src/slugify.ts")!.content)).toBe(REFERENCE_CODE_ACCEPTED_SLUGIFY);
    expect(generation.usage).toEqual({ inputTokens: 940, outputTokens: 128 });
    expect(generation.filesDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(generation.model).toEqual(MODEL);
  });

  test("stops when the model answers with no tool call at all", async () => {
    const generation = await generateReferenceCodeCandidate(input(fakeReferenceCodeBroker([{ text: "Nothing to change." }])));
    expect(generation.stopReason).toBe("model-finished");
    expect(generation.iterations).toBe(1);
    expect(generation.filesDigest).toBe(snapshot.digest);
  });

  test("stops at the twelve-iteration bound and keeps the tree it produced", async () => {
    const broker = fakeReferenceCodeBroker([{ toolCalls: [{ id: "loop", name: "read_file", arguments: { path: "src/slugify.ts" } }] }]);
    const generation = await generateReferenceCodeCandidate(input(broker));
    expect(REFERENCE_CODE_MAX_AGENT_ITERATIONS).toBe(12);
    expect(generation.iterations).toBe(12);
    expect(generation.stopReason).toBe("iteration-bound");
    expect(broker.requests).toHaveLength(12);
    expect(generation.toolCalls).toHaveLength(12);
  });

  test("honours a tighter caller bound and refuses a bound below one", async () => {
    const broker = fakeReferenceCodeBroker([{ toolCalls: [{ id: "loop", name: "read_file", arguments: { path: "src/slugify.ts" } }] }]);
    const generation = await generateReferenceCodeCandidate(input(broker, { maxIterations: 3 }));
    expect(generation.iterations).toBe(3);
    expect(() => generateReferenceCodeCandidate(input(broker, { maxIterations: 0 }))).toThrow(/at least one iteration/);
  });

  test("records a model error rather than presenting a tree as finished", async () => {
    const generation = await generateReferenceCodeCandidate(input(fakeReferenceCodeBroker([{ stopReason: "error", errorMessage: "overloaded" }])));
    expect(generation.stopReason).toBe("model-error");
    expect(generation.errorMessage).toBe("overloaded");
    expect(generation.iterations).toBe(1);
  });

  test("lets a transport failure reach the caller instead of inventing a candidate", async () => {
    await expect(generateReferenceCodeCandidate(input(failingReferenceCodeBroker("provider unreachable"))))
      .rejects.toThrow("provider unreachable");
  });

  test("stops when its deadline is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(generateReferenceCodeCandidate(input(fakeReferenceCodeBroker([{ text: "x" }]), { signal: controller.signal }))).rejects.toThrow();
  });
});

describe("the generator's three tools", () => {
  test("reads a file it has and refuses one it does not, without ending the loop", async () => {
    const broker = fakeReferenceCodeBroker([
      { toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "src/slugify.ts" } }, { id: "r2", name: "read_file", arguments: { path: "src/absent.ts" } }] },
      { toolCalls: [finish] },
    ]);
    const generation = await generateReferenceCodeCandidate(input(broker));
    expect(generation.toolCalls.map(record => record.outcome)).toEqual(["ok", "refused", "ok"]);
    expect(generation.toolCalls[1]!.detail).toContain("is not in the candidate tree");
    const results = broker.contexts[1]!.messages.filter(message => message.role === "toolResult");
    expect(results[0]!.content[0]).toMatchObject({ text: expect.stringContaining("slugify is not implemented") });
    expect(results[1]!.isError).toBe(true);
  });

  test("creates a new file and preserves an existing file's mode", async () => {
    const executable = sealReferenceCodeSnapshot({
      baseSha: BASE,
      treeSha: "b".repeat(39) + "2",
      entries: referenceCodeLaunchRepository().map(file => ({ path: file.path, mode: file.path === "src/slugify.ts" ? "100755" : (file.mode as string), content: file.content })),
    });
    const broker = fakeReferenceCodeBroker([
      { toolCalls: [writeAccepted, { id: "new", name: "write_file", arguments: { path: "src/extra.ts", content: "export const extra = 1;\n" } }] },
      { toolCalls: [finish] },
    ]);
    const generation = await generateReferenceCodeCandidate(input(broker, { snapshot: executable }));
    expect(generation.files.find(file => file.path === "src/slugify.ts")!.mode).toBe("100755");
    expect(generation.files.find(file => file.path === "src/extra.ts")!.mode).toBe("100644");
    expect(generation.toolCalls.map(record => record.detail)).toEqual([expect.stringContaining("replaced"), expect.stringContaining("created"), "Implemented slugify."]);
  });

  test("does not enforce the request's allowed paths, leaving that to the protected claim", async () => {
    const broker = fakeReferenceCodeBroker([
      { toolCalls: [{ id: "out", name: "write_file", arguments: { path: "tools/release.ts", content: "export const released = true;\n" } }] },
      { toolCalls: [finish] },
    ]);
    const generation = await generateReferenceCodeCandidate(input(broker));
    expect(generation.toolCalls[0]!.outcome).toBe("ok");
    expect(generation.files.some(file => file.path === "tools/release.ts")).toBe(true);
  });

  test("refuses an escaping path, a missing path, a non-string write, and an oversized write", async () => {
    const broker = fakeReferenceCodeBroker([
      {
        toolCalls: [
          { id: "e1", name: "write_file", arguments: { path: "../escape.ts", content: "x" } },
          { id: "e2", name: "write_file", arguments: { content: "x" } },
          { id: "e3", name: "write_file", arguments: { path: "src/a.ts", content: 42 } },
          { id: "e4", name: "write_file", arguments: { path: "src/b.ts", content: "x".repeat(REFERENCE_CODE_MAX_WRITE_BYTES + 1) } },
          { id: "e5", name: "delete_everything", arguments: { path: "src/a.ts" } },
        ],
      },
      { toolCalls: [finish] },
    ]);
    const generation = await generateReferenceCodeCandidate(input(broker));
    expect(generation.toolCalls.slice(0, 5).map(record => record.outcome)).toEqual(["refused", "refused", "refused", "refused", "refused"]);
    expect(generation.toolCalls[0]!.detail).toContain("is not a path this repository can store");
    expect(generation.toolCalls[1]!.detail).toContain("a path is required");
    expect(generation.toolCalls[2]!.detail).toContain("content must be a string");
    expect(generation.toolCalls[3]!.detail).toContain("write limit");
    expect(generation.toolCalls[4]!.detail).toContain("is not a tool this generator offers");
    expect(generation.filesDigest).toBe(snapshot.digest);
  });

  test("tolerates a tool call whose arguments are not an object", async () => {
    const broker = fakeReferenceCodeBroker([
      { toolCalls: [{ id: "bad", name: "read_file", arguments: [] as unknown as Record<string, unknown> }] },
      { toolCalls: [finish] },
    ]);
    const generation = await generateReferenceCodeCandidate(input(broker));
    expect(generation.toolCalls[0]!.outcome).toBe("refused");
  });
});

describe("what the agent is told", () => {
  test("the system prompt states the allowed paths, the protected assets, and the declared scripts", () => {
    const prompt = referenceCodeSystemPrompt({
      allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
      protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
      scripts: snapshot.scripts,
    });
    expect(prompt).toContain("src/");
    expect(prompt).toContain("test/slugify.protected.test.ts");
    expect(prompt).toContain("tsc --noEmit");
    expect(prompt).toContain("Do not embed credentials");
  });

  test("the first message carries the request and the file listing, and no remediation on generation zero", async () => {
    const broker = fakeReferenceCodeBroker([{ text: "done" }]);
    await generateReferenceCodeCandidate(input(broker));
    const first = broker.contexts[0]!.messages[0]!;
    const text = (first.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain(REFERENCE_CODE_FIXTURE_REQUEST.issue);
    expect(text).toContain("bun.lock");
    expect(text).not.toContain("was rejected");
    expect(broker.contexts[0]!.tools?.map(tool => tool.name)).toEqual([...REFERENCE_CODE_GENERATOR_TOOLS].map(tool => tool.name));
  });

  test("a repair carries the rejection's findings into the next generation's first message", async () => {
    const broker = fakeReferenceCodeBroker([{ text: "done" }]);
    await generateReferenceCodeCandidate(input(broker, { remediation: "declared-tests FAILED: slugify returned Hello-Factory!", candidateGeneration: 1 }));
    const text = ((broker.contexts[0]!.messages[0]!.content) as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("A previous candidate was rejected");
    expect(text).toContain("slugify returned Hello-Factory!");
    expect(broker.requests[0]!.operation.operationId).toContain(":1:1");
  });

  test("the transcript digest identifies the conversation's content, not the moment it ran", async () => {
    const script = [{ toolCalls: [writeAccepted] }, { toolCalls: [finish] }];
    const first = await generateReferenceCodeCandidate(input(fakeReferenceCodeBroker(script)));
    const again = await generateReferenceCodeCandidate(input(fakeReferenceCodeBroker(script)));
    expect(again.transcriptDigest).toBe(first.transcriptDigest);
    const different = await generateReferenceCodeCandidate(input(fakeReferenceCodeBroker([{ text: "nothing" }])));
    expect(different.transcriptDigest).not.toBe(first.transcriptDigest);
  });
});
