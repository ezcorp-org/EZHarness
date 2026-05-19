import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { validatePath, validateTimeout } from "../runtime/tools/validate";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { resolve } from "path";
import { tmpdir } from "os";

// ── validatePath ──

describe("validatePath", () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await mkdtemp(resolve(tmpdir(), "validate-path-test-"));
    await mkdir(resolve(projectPath, "sub"), { recursive: true });
  });

  afterAll(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  test("resolves a simple relative path within the project", () => {
    expect(validatePath(projectPath, "file.txt")).toBe(resolve(projectPath, "file.txt"));
  });

  test("resolves nested subdirectory paths", () => {
    expect(validatePath(projectPath, "sub/inner.txt")).toBe(resolve(projectPath, "sub/inner.txt"));
  });

  test('resolves "." to the project root', () => {
    expect(validatePath(projectPath, ".")).toBe(projectPath);
  });

  test("rejects simple ../ parent traversal", () => {
    expect(() => validatePath(projectPath, "../escape.txt")).toThrow("Path traversal detected");
  });

  test("rejects sneaky traversal that starts with a valid prefix", () => {
    expect(() => validatePath(projectPath, "sub/../../etc/passwd")).toThrow("Path traversal detected");
  });

  test("rejects absolute paths outside the project", () => {
    expect(() => validatePath(projectPath, "/etc/passwd")).toThrow("Path traversal detected");
  });
});

// ── validateTimeout ──

describe("validateTimeout", () => {
  test("returns the 120000 ms default when timeout is undefined", () => {
    expect(validateTimeout(undefined)).toBe(120000);
  });

  test("returns the default when timeout is null", () => {
    // Runtime callers pass params: any, so null is a realistic input.
    expect(validateTimeout(null as unknown as undefined)).toBe(120000);
  });

  test("passes a reasonable value through unchanged", () => {
    expect(validateTimeout(5000)).toBe(5000);
  });

  test("clamps values below the 1000 ms floor", () => {
    expect(validateTimeout(0)).toBe(1000);
    expect(validateTimeout(500)).toBe(1000);
    expect(validateTimeout(-9999)).toBe(1000);
  });

  test("clamps values above the 600000 ms default max", () => {
    expect(validateTimeout(600_001)).toBe(600_000);
    expect(validateTimeout(Number.MAX_SAFE_INTEGER)).toBe(600_000);
  });

  test("honours a custom max and still applies the floor", () => {
    expect(validateTimeout(10_000, 5_000)).toBe(5_000);
    expect(validateTimeout(3_000, 5_000)).toBe(3_000);
    expect(validateTimeout(100, 5_000)).toBe(1000);
  });
});
