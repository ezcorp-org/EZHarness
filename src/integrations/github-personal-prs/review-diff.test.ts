import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { buildReviewDiff, ReviewDiffError } from "./review-diff";
import { validateSnapshot, type SnapshotFileInput } from "./snapshot";

function file(path: string, data: Uint8Array | string, mode: "100644" | "100755" = "100644"): SnapshotFileInput {
  const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  return { path, mode, data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}

describe("frozen PR review diff", () => {
  test("shows exact added, modified, deleted text and mode changes", async () => {
    const base = validateSnapshot([file("changed.txt", "old\n"), file("deleted.txt", "gone\n"), file("mode.sh", "run\n")]);
    const next = validateSnapshot([file("changed.txt", "new\n"), file("added.txt", "here\n"), file("mode.sh", "run\n", "100755")]);
    const review = await buildReviewDiff(base, next);
    expect(review.map(item => [item.path, item.status])).toEqual([["added.txt", "added"], ["changed.txt", "modified"], ["deleted.txt", "deleted"], ["mode.sh", "modified"]]);
    expect(review[0]!.patch).toContain("+here");
    expect(review[1]!.patch).toContain("-old");
    expect(review[1]!.patch).toContain("+new");
    expect(review[2]!.patch).toContain("-gone");
    expect(review[3]!.patch).toContain("100644 → 100755");
    expect(review[3]!.beforeSha256).toBe(review[3]!.afterSha256);
    expect(review.map(item => [item.additions, item.deletions])).toEqual([[1, 0], [1, 1], [0, 1], [0, 0]]);
  });

  test("counts changed lines rather than unchanged context", async () => {
    const base = validateSnapshot([file("readme.txt", "one\ntwo\nthree\nfour\nfive\n")]);
    const next = validateSnapshot([file("readme.txt", "one\ntwo\nchanged\nfour\nfive\n")]);
    const [review] = await buildReviewDiff(base, next);
    expect(review).toMatchObject({ additions: 1, deletions: 1 });
  });

  test("includes exact bounded binary bytes and hashes", async () => {
    const base = validateSnapshot([file("icon.bin", Uint8Array.of(0, 1))]);
    const next = validateSnapshot([file("icon.bin", Uint8Array.of(0, 2))]);
    const [review] = await buildReviewDiff(base, next);
    expect(review!.binary).toBe(true);
    expect(review!.beforeBase64).toBe("AAE=");
    expect(review!.afterBase64).toBe("AAI=");
    expect(review!.beforeSha256).not.toBe(review!.afterSha256);
  });

  test("blocks changed binary content above review limit", async () => {
    const base = validateSnapshot([file("big.bin", new Uint8Array(40 * 1024))]);
    const next = validateSnapshot([file("big.bin", new Uint8Array(40 * 1024).fill(1))]);
    await expect(buildReviewDiff(base, next)).rejects.toBeInstanceOf(ReviewDiffError);
  });
});
