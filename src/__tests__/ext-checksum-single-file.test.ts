/**
 * Tests for src/extensions/checksum.ts — single-file `computeChecksum`
 * and `verifyChecksum`. Package-level helpers (computePackageChecksums,
 * verifyPackageChecksums) are already covered by extension-checksum.test.ts;
 * this file closes the gap on the per-file helpers used by installer +
 * registry integrity checks.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeChecksum, verifyChecksum } from "../extensions/checksum";

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ext-checksum-file-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** SHA-256("") — the canonical empty-string digest. Hard-coded so the
 *  test asserts against a known constant, not the implementation. */
const SHA256_EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** SHA-256("hello") — another well-known fixture. */
const SHA256_HELLO =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe("computeChecksum", () => {
  test("returns SHA-256 hex of empty file", async () => {
    const p = join(tempDir, "empty.bin");
    await writeFile(p, "");
    const hash = await computeChecksum(p);
    expect(hash).toBe(SHA256_EMPTY);
  });

  test('returns SHA-256 hex of "hello"', async () => {
    const p = join(tempDir, "hello.txt");
    await writeFile(p, "hello");
    const hash = await computeChecksum(p);
    expect(hash).toBe(SHA256_HELLO);
  });

  test("different contents produce different hashes", async () => {
    const a = join(tempDir, "a.txt");
    const b = join(tempDir, "b.txt");
    await writeFile(a, "contents A");
    await writeFile(b, "contents B");
    const ha = await computeChecksum(a);
    const hb = await computeChecksum(b);
    expect(ha).not.toBe(hb);
  });

  test("identical contents in different files produce identical hashes", async () => {
    const a = join(tempDir, "dup-a.txt");
    const b = join(tempDir, "dup-b.txt");
    await writeFile(a, "same payload");
    await writeFile(b, "same payload");
    const ha = await computeChecksum(a);
    const hb = await computeChecksum(b);
    expect(ha).toBe(hb);
  });

  test("returns 64-char lowercase hex string", async () => {
    const p = join(tempDir, "fmt.txt");
    await writeFile(p, "format check");
    const hash = await computeChecksum(p);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("handles binary bytes (not just utf-8)", async () => {
    const p = join(tempDir, "bin.bin");
    // Bytes including null + high-bit — exercise the arrayBuffer path.
    await writeFile(p, Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x01]));
    const hash = await computeChecksum(p);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // Deterministic: same bytes, same hash, across calls.
    const again = await computeChecksum(p);
    expect(again).toBe(hash);
  });
});

describe("verifyChecksum", () => {
  test("returns true when hash matches", async () => {
    const p = join(tempDir, "verify-ok.txt");
    await writeFile(p, "fixture");
    const hash = await computeChecksum(p);
    expect(await verifyChecksum(p, hash)).toBe(true);
  });

  test("returns false when expected hash is wrong", async () => {
    const p = join(tempDir, "verify-bad.txt");
    await writeFile(p, "fixture");
    const wrong = "0".repeat(64);
    expect(await verifyChecksum(p, wrong)).toBe(false);
  });

  test("returns false after file contents change (tamper detection)", async () => {
    const p = join(tempDir, "tamper.txt");
    await writeFile(p, "original");
    const hash = await computeChecksum(p);
    // Simulate on-disk tampering.
    await writeFile(p, "modified");
    expect(await verifyChecksum(p, hash)).toBe(false);
  });

  test("verifyChecksum against empty-file canonical hash", async () => {
    const p = join(tempDir, "verify-empty.bin");
    await writeFile(p, "");
    expect(await verifyChecksum(p, SHA256_EMPTY)).toBe(true);
  });
});
