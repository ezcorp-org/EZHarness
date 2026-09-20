import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeNativeTool } from "../runtime/sandbox/native-tool-runner";
import { NATIVE_TOOL_ARTIFACT, NATIVE_TOOL_INPUT_BYTES, NATIVE_TOOL_OUTPUT_BYTES, decodeNativeToolResult, encodeNativeToolRequest } from "../runtime/sandbox/native-tool-protocol";
import { createSandboxWorkspaceDispatcher } from "../runtime/workspace/dispatcher";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "native-workspace-tools-")); await writeFile(join(root, "marker.txt"), "NATIVE_MARKER\n"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const target = { kind: "sandbox" as const, projectId: "project", bindingId: "binding", revision: 1 };
const run = async (name: string, params: unknown) => decodeNativeToolResult(await executeNativeTool(root, encodeNativeToolRequest(name, params)));

describe("native workspace helper", () => {
  test("uses all seven existing native tools and preserves file edit semantics", async () => {
    expect((await run("readFile", { path: "marker.txt" })).content[0]?.text).toContain("NATIVE_MARKER");
    expect((await run("listFiles", { path: ".", pattern: "*.txt" })).content[0]?.text).toContain("marker.txt");
    expect((await run("readDirectory", { path: "." })).content[0]?.text).toContain("marker.txt");
    expect((await run("glob", { pattern: "*.txt" })).content[0]?.text).toContain("marker.txt");
    expect((await run("grep", { pattern: "NATIVE_MARKER" })).content[0]?.text).toContain("NATIVE_MARKER");
    const edit = await run("editFile", { path: "marker.txt", old_string: "NATIVE_MARKER", new_string: "EDITED" });
    expect(edit.details).toMatchObject({ oldContent: "NATIVE_MARKER\n", newContent: "EDITED\n" });
    expect((await run("shell", { command: "cat marker.txt", timeout: 1000 })).content[0]?.text).toContain("EDITED");
    expect(await Bun.file(join(root, "marker.txt")).text()).toBe("EDITED\n");
  });

  test("denies invalid, unknown and oversized requests without changing files", async () => {
    for (const encoded of ["invalid", Buffer.from("null").toString("base64url"), encodeNativeToolRequest("unknown", {}), encodeNativeToolRequest("editFile", {}), "a".repeat(NATIVE_TOOL_INPUT_BYTES * 2)]) {
      expect(decodeNativeToolResult(await executeNativeTool(root, encoded)).details.isError).toBeTrue();
    }
    expect(await Bun.file(join(root, "marker.txt")).text()).toBe("NATIVE_MARKER\n");
    expect(() => encodeNativeToolRequest("editFile", { new_string: "x".repeat(NATIVE_TOOL_INPUT_BYTES) })).toThrow("limit");
  });

  test("bounds escaped output while reporting truncation", async () => {
    await writeFile(join(root, "large.txt"), "\u0000".repeat(NATIVE_TOOL_OUTPUT_BYTES));
    const encoded = await executeNativeTool(root, encodeNativeToolRequest("readFile", { path: "large.txt" }));
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(NATIVE_TOOL_OUTPUT_BYTES);
    expect(decodeNativeToolResult(encoded).details).toMatchObject({ truncated: true, isError: false });
    expect(decodeNativeToolResult(encoded).content[0]?.text).toContain("output truncated");
  });
});

describe("workspace process dispatcher", () => {
  test("passes fixed helper argv, saved identity and cancellation to the controller", async () => {
    const controller = new AbortController();
    const calls: unknown[] = [];
    const dispatch = createSandboxWorkspaceDispatcher(async (workspace, request, signal) => {
      calls.push({ workspace, request, signal });
      return { stdout: await executeNativeTool(root, request.argv[2]!), exitCode: 0 };
    });
    expect((await dispatch(target, "readFile", { path: "marker.txt" }, controller.signal)).content[0]?.text).toContain("NATIVE_MARKER");
    expect(calls).toEqual([{ workspace: target, request: { argv: ["/usr/local/bin/bun", NATIVE_TOOL_ARTIFACT, encodeNativeToolRequest("readFile", { path: "marker.txt" })], timeoutMs: 120000 }, signal: controller.signal }]);
    await dispatch(target, "shell", { command: "true", timeout: 99999999 });
    expect(calls[1]).toMatchObject({ request: { timeoutMs: 600000 } });
  });

  test("does not dispatch cancelled requests or treat failed, malformed or oversized output as success", async () => {
    let calls = 0;
    const controller = new AbortController(); controller.abort();
    const dispatch = createSandboxWorkspaceDispatcher(async () => { calls++; throw new Error("host-private-path"); });
    expect((await dispatch(target, "shell", {}, controller.signal)).details).toMatchObject({ isError: true });
    expect(calls).toBe(0);
    expect((await dispatch(target, "shell", {})).content[0]?.text).not.toContain("host-private-path");
    expect(calls).toBe(1);
    for (const output of [{ stdout: "", exitCode: 1 }, { stdout: "{}", exitCode: 0 }, { stdout: "x".repeat(NATIVE_TOOL_OUTPUT_BYTES + 1), exitCode: 0 }]) {
      expect((await createSandboxWorkspaceDispatcher(async () => output)(target, "readFile", {})).details).toMatchObject({ isError: true });
    }
  });
});
