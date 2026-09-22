import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { SNAPSHOT_LIMITS, SnapshotValidationError, validateSnapshot, type SnapshotFileInput } from "./snapshot";

function file(path: string, data = "hello", mode: "100644" | "100755" = "100644"): SnapshotFileInput {
  const bytes = Buffer.from(data);
  return { path, mode, data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}

function rejects(entry: SnapshotFileInput, code: SnapshotValidationError["code"]): void {
  try { validateSnapshot([entry]); throw new Error("Snapshot should have been rejected"); }
  catch (error) { expect(error).toBeInstanceOf(SnapshotValidationError); expect((error as SnapshotValidationError).code).toBe(code); }
}

describe("personal PR snapshot validation", () => {
  test("sorts files and binds bytes, mode and paths into one digest", () => {
    const first = validateSnapshot([file("b.txt"), file("a.sh", "run", "100755")]);
    expect(first.files.map(item => item.path)).toEqual(["a.sh", "b.txt"]);
    expect(first.totalBytes).toBe(8);
    expect(first.digest).toBe(validateSnapshot([file("a.sh", "run", "100755"), file("b.txt")]).digest);
    expect(first.digest).not.toBe(validateSnapshot([file("a.sh", "run!", "100755"), file("b.txt")]).digest);
    expect(first.digest).not.toBe(validateSnapshot([file("a.sh", "run", "100644"), file("b.txt")]).digest);
    expect(first.digest).not.toBe(validateSnapshot([file("a2.sh", "run", "100755"), file("b.txt")]).digest);
  });

  test("rejects unsafe and colliding paths", () => {
    for (const path of ["", "/abs", "../up", "x/../up", "x/./a", "x//a", "x\\a", "x/.git/config", ".ezcorp/data", "x/\0a", "x/\na", "e\u0301.txt", "a".repeat(SNAPSHOT_LIMITS.pathBytes + 1)]) rejects(file(path), "invalid_path");
    expect(() => validateSnapshot([file("A.txt"), file("a.txt")])).toThrow(SnapshotValidationError);
    expect(() => validateSnapshot([file("foo"), file("foo-a"), file("foo/bar")])).toThrow(SnapshotValidationError);
  });

  test("rejects tampered bytes, malformed base64, and unsupported modes", () => {
    rejects({ ...file("a"), data: "eA==" }, "invalid_content");
    rejects({ ...file("a"), data: "a" }, "invalid_content");
    rejects({ ...file("a"), mode: "120000" as "100644" }, "invalid_content");
    rejects({ ...file("a"), extra: "metadata" } as SnapshotFileInput, "invalid_content");
    rejects({ ...file("a"), data: "A".repeat(Math.ceil(SNAPSHOT_LIMITS.fileBytes / 3) * 4 + 5) }, "invalid_content");
  });

  test("enforces file count and total bytes", () => {
    expect(() => validateSnapshot(Array.from({ length: SNAPSHOT_LIMITS.files + 1 }, (_, index) => file(String(index))))).toThrow(SnapshotValidationError);
    const big = file("a", "a".repeat(SNAPSHOT_LIMITS.fileBytes));
    expect(() => validateSnapshot([big, ...Array.from({ length: 128 }, (_, index) => ({ ...big, path: String(index) }))])).toThrow(SnapshotValidationError);
    expect(validateSnapshot([]).files).toEqual([]);
  });
});
