/**
 * `emit_artifact` — the traversal-proof destination, invariant E, and the
 * end-to-end proof that the sanitizer boundary holds downstream.
 */
import { describe, expect, test } from "bun:test";

import { PROJECT_ROOT, makeFakeFs, payloadOf } from "../../__tests__/fake-fs";
import { REDACTED } from "../sanitize";
import { artifactDir, createEmitArtifact } from "./emit-artifact";
import { createReadFiles } from "./read-files";
import { MAX_TOOL_OUTPUT_BYTES, MAX_WRITE_BYTES, sha256Hex } from "./shared";

const MAX_STEP_OUTPUT_BYTES = 256 * 1024;

describe("emit_artifact — the destination", () => {
  test("writes under .ezcorp/extension-data/ez-factory/artifacts/<runId>/<name>", async () => {
    const { deps, store, mkdirs } = makeFakeFs({});
    const outcome = await createEmitArtifact(deps)({
      runId: "run-42",
      name: "report.md",
      content: "body",
    });

    const expected = ".ezcorp/extension-data/ez-factory/artifacts/run-42/report.md";
    expect(payloadOf(outcome)).toEqual({
      path: expected,
      bytes: 4,
      sha256: await sha256Hex("body"),
    });
    expect(store.get(`${PROJECT_ROOT}/${expected}`)).toBe("body");
    expect(mkdirs).toEqual([`${PROJECT_ROOT}/${artifactDir("run-42")}`]);
  });

  test("artifactDir names the same layout the tool writes to", () => {
    expect(artifactDir("r1")).toBe(".ezcorp/extension-data/ez-factory/artifacts/r1");
  });
});

describe("emit_artifact — traversal is unrepresentable, not merely rejected", () => {
  test.each([
    ["a parent-dir traversal in name", "../../../etc/passwd"],
    ["a bare ..", ".."],
    ["a nested path in name", "sub/evil.md"],
    ["a backslash separator", "sub\\evil.md"],
    ["an absolute path", "/etc/passwd"],
    ["a dotfile", ".bashrc"],
  ])("rejects %s and writes nothing", async (_label, name) => {
    const { deps, store, mkdirs } = makeFakeFs({});
    const outcome = await createEmitArtifact(deps)({ runId: "r1", name, content: "x" });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("invalid-name");
    expect(store.size).toBe(0);
    expect(mkdirs).toEqual([]);
  });

  test("a traversal in runId is rejected too — it is as untrusted as name", async () => {
    const { deps, store } = makeFakeFs({});
    const outcome = await createEmitArtifact(deps)({
      runId: "../../../tmp",
      name: "x.md",
      content: "x",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("invalid-name");
    expect(store.size).toBe(0);
  });

  test("the written path always starts with the artifacts prefix", async () => {
    // The positive half of the traversal claim: whatever legal slug is
    // supplied, the destination stays inside the artifacts subtree.
    const { deps } = makeFakeFs({});
    const outcome = await createEmitArtifact(deps)({
      runId: "a.b-c_1",
      name: "x.y-z_2.md",
      content: "x",
    });
    expect(payloadOf(outcome).path).toBe(
      ".ezcorp/extension-data/ez-factory/artifacts/a.b-c_1/x.y-z_2.md",
    );
  });
});

describe("emit_artifact — invariant E", () => {
  test("REJECTS content over 4MB rather than truncating it", async () => {
    const { deps, store } = makeFakeFs({});
    const outcome = await createEmitArtifact(deps)({
      runId: "r1",
      name: "big.bin",
      content: "a".repeat(MAX_WRITE_BYTES + 1),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("over-cap");
    expect(store.size).toBe(0);
  });

  test("rejects a missing runId", async () => {
    const { deps } = makeFakeFs({});
    const outcome = await createEmitArtifact(deps)({ name: "x.md", content: "x" });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("invalid-input");
  });

  test("rejects a non-object input", async () => {
    const { deps } = makeFakeFs({});
    const outcome = await createEmitArtifact(deps)("nope");
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("invalid-input");
  });
});

describe("the sanitizer boundary holds all the way to disk", () => {
  test("a secret in a source file is already [REDACTED] when emit_artifact writes it", async () => {
    // The whole invariant, end to end, with nothing stubbed between the
    // two tools: `read_files` sanitizes on the way OUT, so every
    // downstream consumer — including this one, which deliberately does
    // NOT sanitize — can never see the original.
    const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
    const { deps, store } = makeFakeFs({
      [`${PROJECT_ROOT}/src/config.md`]: `api_key = ${secret}`,
    });

    const readOut = await createReadFiles(deps)({ globs: ["**/*.md"] });
    const files = payloadOf(readOut).files as Array<{ content: string }>;
    expect(files).toHaveLength(1);
    const contentFromRead = files[0]?.content ?? "";

    const emitOut = await createEmitArtifact(deps)({
      runId: "r1",
      name: "summary.md",
      content: contentFromRead,
    });
    expect(emitOut.ok).toBe(true);

    const written = store.get(
      `${PROJECT_ROOT}/.ezcorp/extension-data/ez-factory/artifacts/r1/summary.md`,
    );
    expect(written).toBeDefined();
    expect(written).not.toContain(secret);
    expect(written).toContain(REDACTED);
  });
});

describe("emit_artifact — the resume-failure guard", () => {
  test("a 4MB artifact still produces a tiny step output", async () => {
    const { deps } = makeFakeFs({});
    const outcome = await createEmitArtifact(deps)({
      runId: "r1",
      name: "big.bin",
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
