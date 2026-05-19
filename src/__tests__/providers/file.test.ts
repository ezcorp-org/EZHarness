import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { createFileProvider } from "../../providers/file";

const file = createFileProvider();
const tmp = join(tmpdir(), `pi-file-test-${Date.now()}`);

beforeAll(async () => {
  await Bun.write(join(tmp, ".keep"), "");
});

afterAll(async () => {
  const fs = await import("fs/promises");
  await fs.rm(tmp, { recursive: true, force: true });
});

test("write and read a file", async () => {
  const p = join(tmp, "hello.txt");
  await file.write(p, "hello world");
  const content = await file.read(p);
  expect(content).toBe("hello world");
});

test("exists returns true for existing file", async () => {
  const p = join(tmp, "exists.txt");
  await file.write(p, "x");
  expect(await file.exists(p)).toBe(true);
});

test("exists returns false for missing file", async () => {
  expect(await file.exists(join(tmp, "nope.txt"))).toBe(false);
});

test("read non-existent file throws", async () => {
  expect(file.read(join(tmp, "missing.txt"))).rejects.toThrow();
});

describe("empty files", () => {
  test("write and read empty file", async () => {
    const p = join(tmp, "empty.txt");
    await file.write(p, "");
    const content = await file.read(p);
    expect(content).toBe("");
  });

  test("empty file exists", async () => {
    const p = join(tmp, "empty2.txt");
    await file.write(p, "");
    expect(await file.exists(p)).toBe(true);
  });
});

describe("overwriting", () => {
  test("overwrite replaces file content", async () => {
    const p = join(tmp, "overwrite.txt");
    await file.write(p, "original");
    expect(await file.read(p)).toBe("original");
    await file.write(p, "replaced");
    expect(await file.read(p)).toBe("replaced");
  });

  test("overwrite with empty string clears file", async () => {
    const p = join(tmp, "clear.txt");
    await file.write(p, "some content");
    await file.write(p, "");
    expect(await file.read(p)).toBe("");
  });
});

describe("directory edge cases", () => {
  test("write creates intermediate directories", async () => {
    const p = join(tmp, "nested", "deep", "file.txt");
    await file.write(p, "nested content");
    expect(await file.read(p)).toBe("nested content");
  });

  test("exists returns false for directory path", async () => {
    // tmp directory itself exists but is a directory, not a file
    expect(await file.exists(tmp)).toBe(false);
  });
});
