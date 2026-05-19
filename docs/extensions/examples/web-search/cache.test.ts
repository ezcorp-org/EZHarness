import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChannel, JsonRpcError } from "@ezcorp/sdk/runtime";
import { DiskCache } from "./cache";

let dir = "";

// ── In-test fs RPC stub ─────────────────────────────────────────────
//
// DiskCache routes through `@ezcorp/sdk/runtime`'s `fsRead` + `fsWrite`
// + `fsMkdir` (Phase 3 host-mediated reverse-RPC). The test stubs
// `getChannel().request` and routes those methods to disk under
// `tmpdir()`. Mirrors the task-stack pattern.

const ORIG_FS_ALLOWED = process.env.EZCORP_FS_ALLOWED;

function installFsStub(): void {
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((async (
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    const p = (params ?? {}) as Record<string, unknown>;
    const path = p.path as string;
    if (method === "ezcorp/fs.read") {
      if (!existsSync(path)) {
        throw new JsonRpcError(-32000, `ENOENT: no such file or directory: ${path}`);
      }
      const text = readFileSync(path, "utf-8");
      const body = btoa(text);
      return { encoding: "utf-8", body, bytes: text.length, resolvedPath: path };
    }
    if (method === "ezcorp/fs.write") {
      const content = p.content as string;
      writeFileSync(path, content);
      return { bytes: content.length, resolvedPath: path };
    }
    if (method === "ezcorp/fs.mkdir") {
      mkdirSync(path, { recursive: p.recursive === true });
      return { resolvedPath: path };
    }
    throw new JsonRpcError(-32601, `web-search cache test stub: unexpected RPC method ${method}`);
  }) as ReturnType<typeof getChannel>["request"]);
}

beforeAll(() => {
  process.env.EZCORP_FS_ALLOWED = "1";
});

afterAll(() => {
  if (ORIG_FS_ALLOWED === undefined) delete process.env.EZCORP_FS_ALLOWED;
  else process.env.EZCORP_FS_ALLOWED = ORIG_FS_ALLOWED;
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "web-search-cache-"));
  installFsStub();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("DiskCache", () => {
  test("miss returns undefined", async () => {
    const c = new DiskCache({ filePath: join(dir, "c.json"), maxEntries: 10 });
    expect(await c.get("k")).toBeUndefined();
  });

  test("set then get returns the value", async () => {
    const c = new DiskCache({ filePath: join(dir, "c.json"), maxEntries: 10 });
    await c.set("k", "v", 60_000);
    expect(await c.get("k")).toBe("v");
  });

  test("expired entry is treated as a miss and purged", async () => {
    let t = 0;
    const c = new DiskCache({ filePath: join(dir, "c.json"), maxEntries: 10, now: () => t });
    await c.set("k", "v", 1000);
    t = 999;
    expect(await c.get("k")).toBe("v");
    t = 1001;
    expect(await c.get("k")).toBeUndefined();
  });

  test("LRU evicts oldest when maxEntries exceeded", async () => {
    const c = new DiskCache({ filePath: join(dir, "c.json"), maxEntries: 2 });
    await c.set("a", "1", 60_000);
    await c.set("b", "2", 60_000);
    await c.set("c", "3", 60_000);
    expect(await c.get("a")).toBeUndefined();
    expect(await c.get("b")).toBe("2");
    expect(await c.get("c")).toBe("3");
  });

  test("get refreshes LRU position so most-recently-read survives eviction", async () => {
    const c = new DiskCache({ filePath: join(dir, "c.json"), maxEntries: 2 });
    await c.set("a", "1", 60_000);
    await c.set("b", "2", 60_000);
    expect(await c.get("a")).toBe("1"); // move 'a' to most-recent
    await c.set("c", "3", 60_000);
    expect(await c.get("a")).toBe("1");
    expect(await c.get("b")).toBeUndefined();
  });

  test("contents survive across instances (round-trip)", async () => {
    const path = join(dir, "c.json");
    const c1 = new DiskCache({ filePath: path, maxEntries: 10 });
    await c1.set("k", "v", 60_000);
    const c2 = new DiskCache({ filePath: path, maxEntries: 10 });
    expect(await c2.get("k")).toBe("v");
  });

  test("corrupt file starts empty and reports via onError", async () => {
    const path = join(dir, "c.json");
    writeFileSync(path, "{not json", "utf8");
    const errs: Array<{ op: string }> = [];
    const c = new DiskCache({
      filePath: path,
      maxEntries: 10,
      onError: (_e, op) => errs.push({ op }),
    });
    expect(await c.get("k")).toBeUndefined();
    expect(errs.some((e) => e.op === "read")).toBe(true);
  });

  test("skips malformed entries in the persisted file", async () => {
    const path = join(dir, "c.json");
    writeFileSync(path, JSON.stringify({ good: { value: "v", expiresAt: 9e15 }, bad: { value: 1 } }), "utf8");
    const c = new DiskCache({ filePath: path, maxEntries: 10 });
    expect(await c.get("good")).toBe("v");
    expect(await c.get("bad")).toBeUndefined();
  });

  test("set on unwritable path still returns without throwing, flagged via onError", async () => {
    const path = join(dir, "nested", "c.json"); // parent dir is auto-created, so use an illegal char instead
    const impossible = join(dir, "\0bad", "c.json");
    const errs: Array<{ op: string }> = [];
    const c = new DiskCache({
      filePath: impossible,
      maxEntries: 10,
      onError: (_e, op) => errs.push({ op }),
    });
    await c.set("k", "v", 60_000);
    expect(errs.some((e) => e.op === "write")).toBe(true);
    // Parent dir version writes fine.
    const ok = new DiskCache({ filePath: path, maxEntries: 10 });
    await ok.set("k", "v", 60_000);
    expect(await ok.get("k")).toBe("v");
  });
});
