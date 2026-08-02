/**
 * `write_file` — the compare-and-swap precondition, the path guard, and
 * invariant E on the 4MB content cap.
 */
import { describe, expect, test } from "bun:test";

import { PROJECT_ROOT, makeFakeFs, payloadOf } from "../../__tests__/fake-fs";
import { IF_MATCH_ABSENT, createWriteFile } from "./write-file";
import { MAX_TOOL_OUTPUT_BYTES, MAX_WRITE_BYTES, sha256Hex } from "./shared";

const p = (rel: string): string => `${PROJECT_ROOT}/${rel}`;

/** The host cap the step output must stay under. Restated, not imported —
 *  `src/runtime/workflow-step-output.ts` is unreachable from the sandbox. */
const MAX_STEP_OUTPUT_BYTES = 256 * 1024;

describe("write_file — writing", () => {
  test("writes the file and describes it", async () => {
    const { deps, store, mkdirs } = makeFakeFs({});
    const outcome = await createWriteFile(deps)({ path: "docs/out.md", content: "hello" });

    expect(payloadOf(outcome)).toEqual({
      path: "docs/out.md",
      bytes: 5,
      sha256: await sha256Hex("hello"),
    });
    expect(store.get(p("docs/out.md"))).toBe("hello");
    expect(mkdirs).toEqual([p("docs")]);
  });

  test("content at exactly the 4MB cap is written", async () => {
    const { deps } = makeFakeFs({});
    const atCap = "a".repeat(MAX_WRITE_BYTES);
    const outcome = await createWriteFile(deps)({ path: "big.bin", content: atCap });
    expect(payloadOf(outcome).bytes).toBe(MAX_WRITE_BYTES);
  });

  test("a host write failure surfaces as an error, not a silent success", async () => {
    const { deps } = makeFakeFs({}, { unwritableFiles: [p("ro.md")] });
    const outcome = await createWriteFile(deps)({ path: "ro.md", content: "x" });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("failed");
  });
});

describe("write_file — invariant E", () => {
  test("REJECTS content over 4MB rather than truncating it", async () => {
    const { deps, store } = makeFakeFs({});
    const outcome = await createWriteFile(deps)({
      path: "big.bin",
      content: "a".repeat(MAX_WRITE_BYTES + 1),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("over-cap");
    // Nothing partial landed. A truncating implementation would have
    // written 4MB here and reported success.
    expect(store.has(p("big.bin"))).toBe(false);
  });

  test.each([
    ["an absolute path", "/etc/passwd"],
    ["a traversal", "../../etc/passwd"],
  ])("rejects %s", async (_label, path) => {
    const { deps, store } = makeFakeFs({});
    const outcome = await createWriteFile(deps)({ path, content: "x" });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("invalid-path");
    expect(store.size).toBe(0);
  });

  test("rejects a missing path", async () => {
    const { deps } = makeFakeFs({});
    const outcome = await createWriteFile(deps)({ content: "x" });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("invalid-input");
  });
});

describe("write_file — the ifMatch precondition", () => {
  test("no ifMatch means a blind write, which still succeeds", async () => {
    const { deps, store } = makeFakeFs({ [p("a.md")]: "old" });
    const outcome = await createWriteFile(deps)({ path: "a.md", content: "new" });
    expect(outcome.ok).toBe(true);
    expect(store.get(p("a.md"))).toBe("new");
  });

  test("a matching sha256 lets the write through", async () => {
    const { deps, store } = makeFakeFs({ [p("a.md")]: "old" });
    const outcome = await createWriteFile(deps)({
      path: "a.md",
      content: "new",
      ifMatch: await sha256Hex("old"),
    });
    expect(outcome.ok).toBe(true);
    expect(store.get(p("a.md"))).toBe("new");
  });

  test("a stale sha256 REFUSES the write — a lost update is not a success", async () => {
    // The scenario: a pipeline read the file, an LLM step took minutes,
    // and someone edited it meanwhile. Overwriting silently reverts their
    // work and reports success.
    const { deps, store } = makeFakeFs({ [p("a.md")]: "edited by a human" });
    const outcome = await createWriteFile(deps)({
      path: "a.md",
      content: "pipeline output",
      ifMatch: await sha256Hex("what the pipeline read"),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("precondition-failed");
    expect(store.get(p("a.md"))).toBe("edited by a human");
  });

  test("a sha256 ifMatch on a missing file is refused", async () => {
    const { deps } = makeFakeFs({});
    const outcome = await createWriteFile(deps)({
      path: "a.md",
      content: "x",
      ifMatch: await sha256Hex("anything"),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("precondition-failed");
  });

  test(`ifMatch "${IF_MATCH_ABSENT}" creates a new file`, async () => {
    const { deps, store } = makeFakeFs({});
    const outcome = await createWriteFile(deps)({
      path: "new.md",
      content: "x",
      ifMatch: IF_MATCH_ABSENT,
    });
    expect(outcome.ok).toBe(true);
    expect(store.get(p("new.md"))).toBe("x");
  });

  test(`ifMatch "${IF_MATCH_ABSENT}" refuses to clobber an existing file`, async () => {
    const { deps, store } = makeFakeFs({ [p("new.md")]: "already here" });
    const outcome = await createWriteFile(deps)({
      path: "new.md",
      content: "x",
      ifMatch: IF_MATCH_ABSENT,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("precondition-failed");
    expect(store.get(p("new.md"))).toBe("already here");
  });

  test("a malformed ifMatch is REJECTED, never treated as 'no precondition'", async () => {
    // The dangerous alternative: a typo'd hash falls through to a blind
    // overwrite, and the guard the author thought they had is gone.
    const { deps, store } = makeFakeFs({ [p("a.md")]: "old" });
    const outcome = await createWriteFile(deps)({
      path: "a.md",
      content: "new",
      ifMatch: "NOTAHASH",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("invalid-input");
    expect(store.get(p("a.md"))).toBe("old");
  });

  test("an uppercase-hex ifMatch is rejected — one canonical form only", async () => {
    const { deps } = makeFakeFs({ [p("a.md")]: "old" });
    const outcome = await createWriteFile(deps)({
      path: "a.md",
      content: "new",
      ifMatch: (await sha256Hex("old")).toUpperCase(),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("invalid-input");
  });

  test("the returned sha256 is directly usable as the next call's ifMatch", async () => {
    const { deps } = makeFakeFs({});
    const first = await createWriteFile(deps)({ path: "a.md", content: "one" });
    const second = await createWriteFile(deps)({
      path: "a.md",
      content: "two",
      ifMatch: payloadOf(first).sha256 as string,
    });
    expect(second.ok).toBe(true);
  });
});

describe("write_file — the resume-failure guard", () => {
  test("a 4MB write still produces a tiny step output", async () => {
    // This is why the 4MB cap is safe here and 200KB is the ceiling for
    // `read_files`: the OUTPUT is `{path, bytes, sha256}` regardless.
    const { deps } = makeFakeFs({});
    const outcome = await createWriteFile(deps)({
      path: "big.bin",
      content: "a".repeat(MAX_WRITE_BYTES),
    });

    expect(outcome.ok).toBe(true);
    const stored = { success: true, output: JSON.parse(outcome.text) };
    expect(new TextEncoder().encode(JSON.stringify(stored)).length).toBeLessThan(
      MAX_STEP_OUTPUT_BYTES,
    );
    expect(new TextEncoder().encode(outcome.text).length).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_BYTES,
    );
  });
});
