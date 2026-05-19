import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeContentHash } from "../runtime/audit/cache";
import type { FeatureFile } from "../db/schema";

let projectRoot: string;

beforeAll(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "audit-cache-"));
});

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function writeFixture(rel: string, content: string): void {
  const abs = join(projectRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function file(relpath: string): FeatureFile {
  return { featureId: "f1", relpath, source: "scan", addedAt: new Date() };
}

describe("computeContentHash", () => {
  test("same files + same content → same hash", async () => {
    writeFixture("a.ts", "export const a = 1;");
    writeFixture("b.ts", "export const b = 2;");
    const h1 = await computeContentHash([file("a.ts"), file("b.ts")], projectRoot);
    const h2 = await computeContentHash([file("a.ts"), file("b.ts")], projectRoot);
    expect(h1).toBe(h2);
  });

  test("file order does not affect hash (sorted internally)", async () => {
    writeFixture("c.ts", "1");
    writeFixture("d.ts", "2");
    const h1 = await computeContentHash([file("c.ts"), file("d.ts")], projectRoot);
    const h2 = await computeContentHash([file("d.ts"), file("c.ts")], projectRoot);
    expect(h1).toBe(h2);
  });

  test("changed file content → different hash", async () => {
    writeFixture("e.ts", "v1");
    const before = await computeContentHash([file("e.ts")], projectRoot);
    writeFixture("e.ts", "v2");
    const after = await computeContentHash([file("e.ts")], projectRoot);
    expect(before).not.toBe(after);
  });

  test("added file → different hash", async () => {
    writeFixture("g.ts", "g");
    const before = await computeContentHash([file("g.ts")], projectRoot);
    writeFixture("h.ts", "h");
    const after = await computeContentHash([file("g.ts"), file("h.ts")], projectRoot);
    expect(before).not.toBe(after);
  });

  test("missing file is encoded so absent ≠ present-but-empty", async () => {
    const hMissing = await computeContentHash([file("never-existed.ts")], projectRoot);
    writeFixture("now-exists.ts", "");
    const hPresent = await computeContentHash([file("now-exists.ts")], projectRoot);
    expect(hMissing).not.toBe(hPresent);
  });

  test("changes beyond the head-bytes cap do not affect the hash", async () => {
    // The cap is 4 KiB. Write a 5 KiB file; the first 4 KiB stay constant.
    const head = "X".repeat(4_096);
    writeFixture("big.ts", head + "tail-v1");
    const before = await computeContentHash([file("big.ts")], projectRoot);
    appendFileSync(join(projectRoot, "big.ts"), "extra-after-cap");
    const after = await computeContentHash([file("big.ts")], projectRoot);
    expect(before).toBe(after);
  });
});
