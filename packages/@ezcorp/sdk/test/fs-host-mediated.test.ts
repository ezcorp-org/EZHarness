// Phase 3 SDK helpers — `fsRead`, `fsWrite`, `fsList`, `fsStat`,
// `fsExists`, `fsMkdir`, `fsUnlink`. Each calls the host's
// `ezcorp/fs.{read,write,...}` reverse-RPC via the channel and
// surfaces host errors as thrown Errors.
//
// Strategy mirrors `storage.test.ts`: spy on `getChannel().request`
// to intercept calls, synthesize host responses, and assert the
// SDK's wire shape + return-value transforms (encoding, base64
// round-trip, etc.).
//
// Streaming reassembly is exercised via `createHostChannelForTests`
// + the chunked-frame protocol (announce + chunks); the channel
// dispatches the assembled JSON-RPC response to the pending
// `request()` promise the same way as a single-line response.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  fsRead,
  fsWrite,
  fsList,
  fsStat,
  fsExists,
  fsMkdir,
  fsUnlink,
} from "../src/runtime/fs";
import {
  __resetChannelForTests,
  createHostChannelForTests,
  getChannel,
  JsonRpcError,
  type HostChannel,
} from "../src/runtime/channel";

// ── Test rig ──────────────────────────────────────────────────────

interface RequestCall {
  method: string;
  params: unknown;
  timeoutMs: number | undefined;
}

function stubRequest(
  impl: (call: RequestCall) => Promise<unknown>,
): { calls: RequestCall[] } {
  const ch: HostChannel = getChannel();
  const calls: RequestCall[] = [];
  const spy = spyOn(ch, "request");
  spy.mockImplementation(
    (async (method: string, params: unknown, timeoutMs?: number) => {
      const call: RequestCall = { method, params, timeoutMs };
      calls.push(call);
      return impl(call);
    }) as HostChannel["request"],
  );
  return { calls };
}

const ORIG_FS_ALLOWED = process.env.EZCORP_FS_ALLOWED;

beforeEach(() => {
  process.env.EZCORP_FS_ALLOWED = "1";
});

afterEach(() => {
  __resetChannelForTests();
  if (ORIG_FS_ALLOWED === undefined) delete process.env.EZCORP_FS_ALLOWED;
  else process.env.EZCORP_FS_ALLOWED = ORIG_FS_ALLOWED;
});

// ── Pre-flight ────────────────────────────────────────────────────

describe("fsRead / fsWrite / ... — pre-flight EZCORP_FS_ALLOWED", () => {
  test("fsRead throws BEFORE any RPC when EZCORP_FS_ALLOWED is unset", async () => {
    delete process.env.EZCORP_FS_ALLOWED;
    let called = false;
    stubRequest(async () => {
      called = true;
      return null;
    });
    await expect(fsRead("/tmp/x")).rejects.toThrow(/no filesystem grant/);
    expect(called).toBe(false);
  });

  test("fsWrite throws BEFORE any RPC when EZCORP_FS_ALLOWED is unset", async () => {
    delete process.env.EZCORP_FS_ALLOWED;
    await expect(fsWrite("/tmp/x", "data")).rejects.toThrow(/no filesystem grant/);
  });

  test("fsList / fsStat / fsExists / fsMkdir / fsUnlink all fail-fast", async () => {
    delete process.env.EZCORP_FS_ALLOWED;
    await expect(fsList("/tmp/x")).rejects.toThrow(/no filesystem grant/);
    await expect(fsStat("/tmp/x")).rejects.toThrow(/no filesystem grant/);
    await expect(fsExists("/tmp/x")).rejects.toThrow(/no filesystem grant/);
    await expect(fsMkdir("/tmp/x")).rejects.toThrow(/no filesystem grant/);
    await expect(fsUnlink("/tmp/x")).rejects.toThrow(/no filesystem grant/);
  });
});

// ── fsRead ────────────────────────────────────────────────────────

describe("fsRead", () => {
  test("UTF-8 decoding (default) returns a string", async () => {
    stubRequest(async () => ({
      encoding: "utf-8",
      body: btoa("Hello, world!"),
      bytes: 13,
      resolvedPath: "/tmp/x",
    }));
    const r = await fsRead("/tmp/x");
    expect(typeof r).toBe("string");
    expect(r).toBe("Hello, world!");
  });

  test("binary encoding returns a Uint8Array", async () => {
    const raw = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    stubRequest(async () => ({
      encoding: "binary",
      body: btoa(String.fromCharCode(...raw)),
      bytes: 4,
      resolvedPath: "/tmp/x.bin",
    }));
    const r = await fsRead("/tmp/x.bin", { encoding: "binary" });
    expect(r instanceof Uint8Array).toBe(true);
    expect(Array.from(r as Uint8Array)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  test("wire shape: method + params correct", async () => {
    const { calls } = stubRequest(async () => ({
      encoding: "utf-8",
      body: "",
      bytes: 0,
      resolvedPath: "/tmp/x",
    }));
    await fsRead("/tmp/x", { encoding: "binary" });
    expect(calls[0]?.method).toBe("ezcorp/fs.read");
    expect(calls[0]?.params).toEqual({ path: "/tmp/x", encoding: "binary" });
  });

  test("rethrows host error (-32001 deny)", async () => {
    stubRequest(async () => {
      throw new JsonRpcError(-32001, "Filesystem access denied: /etc/passwd outside grant");
    });
    await expect(fsRead("/etc/passwd")).rejects.toThrow(/access denied/);
  });
});

// ── fsWrite ───────────────────────────────────────────────────────

describe("fsWrite", () => {
  test("string content sends utf-8 encoding", async () => {
    const { calls } = stubRequest(async () => ({ bytes: 5, resolvedPath: "/tmp/x" }));
    const r = await fsWrite("/tmp/x", "hello");
    expect(calls[0]?.method).toBe("ezcorp/fs.write");
    expect(calls[0]?.params).toMatchObject({
      path: "/tmp/x",
      content: "hello",
      encoding: "utf-8",
    });
    expect(r.bytes).toBe(5);
  });

  test("Uint8Array content is base64-encoded with binary encoding", async () => {
    const { calls } = stubRequest(async () => ({ bytes: 4, resolvedPath: "/tmp/x.bin" }));
    const data = new Uint8Array([0x01, 0x02, 0x03, 0xff]);
    await fsWrite("/tmp/x.bin", data);
    const params = calls[0]?.params as Record<string, unknown>;
    expect(params.encoding).toBe("binary");
    const decoded = Uint8Array.from(atob(params.content as string), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual([0x01, 0x02, 0x03, 0xff]);
  });

  test("host returns bytes + resolvedPath; SDK passes through", async () => {
    stubRequest(async () => ({ bytes: 100, resolvedPath: "/granted/out.txt" }));
    const r = await fsWrite("/granted/out.txt", "x".repeat(100));
    expect(r).toEqual({ bytes: 100, resolvedPath: "/granted/out.txt" });
  });

  test("(N1) pre-base64 size guard: oversized Uint8Array throws BEFORE allocating base64", async () => {
    // The host enforces the same 100MB cap, but inflating a 100MB+
    // Uint8Array to base64 client-side first allocates ~133MB of
    // string before the host rejects — a real OOM risk on
    // memory-constrained extensions. The SDK now pre-checks
    // byteLength.
    //
    // We assert the throw happens BEFORE any RPC is sent (`called`
    // stays false), proving the guard fires before the base64
    // allocation. We use a small Uint8Array with a faked byteLength
    // to avoid actually allocating 100MB in the test process.
    let called = false;
    stubRequest(async () => {
      called = true;
      return { bytes: 0, resolvedPath: "/x" };
    });

    // Build a small Uint8Array but spoof the byteLength to exceed
    // 100MB. We can't override byteLength on a real Uint8Array, so
    // construct a wrapper object that the SDK will treat as
    // Uint8Array. The `instanceof Uint8Array` check in fsWrite means
    // we need an actual Uint8Array. Use a real backing buffer via a
    // sub-array — still small actual memory footprint.
    //
    // The cleanest path: create an actual 100MB+1 Uint8Array. That
    // allocates 100MB once, but the test harness can do that
    // briefly. We then assert the SDK throws before calling the
    // stub.
    const bigBytes = new Uint8Array(100 * 1024 * 1024 + 1);
    await expect(fsWrite("/granted/big", bigBytes)).rejects.toThrow(/100MB|exceed/i);
    expect(called).toBe(false);
  });

  test("(N1) pre-base64 size guard: oversized utf-8 string throws BEFORE allocating", async () => {
    let called = false;
    stubRequest(async () => {
      called = true;
      return { bytes: 0, resolvedPath: "/x" };
    });
    // 100MB + 1 byte of utf-8 'A' (1 byte each).
    const bigStr = "A".repeat(100 * 1024 * 1024 + 1);
    await expect(fsWrite("/granted/big.txt", bigStr)).rejects.toThrow(/100MB|exceed/i);
    expect(called).toBe(false);
  });
});

// ── fsList / fsStat / fsExists / fsMkdir / fsUnlink ─────────────

describe("fsList", () => {
  test("returns entries array; method + params correct", async () => {
    const entries = [
      { name: "a.txt", isFile: true, isDirectory: false },
      { name: "sub", isFile: false, isDirectory: true },
    ];
    const { calls } = stubRequest(async () => ({ entries }));
    const r = await fsList("/tmp");
    expect(calls[0]?.method).toBe("ezcorp/fs.list");
    expect(calls[0]?.params).toEqual({ path: "/tmp" });
    expect(r).toEqual(entries);
  });
});

describe("fsStat", () => {
  test("returns size + mtime + flags", async () => {
    stubRequest(async () => ({
      size: 42,
      mtimeMs: 1700000000000,
      isFile: true,
      isDirectory: false,
      resolvedPath: "/tmp/x",
    }));
    const r = await fsStat("/tmp/x");
    expect(r.size).toBe(42);
    expect(r.isFile).toBe(true);
    expect(r.isDirectory).toBe(false);
  });
});

describe("fsExists", () => {
  test("true when host says exists:true", async () => {
    stubRequest(async () => ({ exists: true, resolvedPath: "/tmp/x" }));
    const r = await fsExists("/tmp/x");
    expect(r).toBe(true);
  });

  test("false when host says exists:false", async () => {
    stubRequest(async () => ({ exists: false, resolvedPath: "/tmp/missing" }));
    const r = await fsExists("/tmp/missing");
    expect(r).toBe(false);
  });

  test("rethrows host -32001 (out-of-grant existence is a deny, not a leak)", async () => {
    stubRequest(async () => {
      throw new JsonRpcError(-32001, "Filesystem access denied: /etc/passwd is outside declared permission paths.");
    });
    await expect(fsExists("/etc/passwd")).rejects.toThrow(/access denied/);
  });
});

describe("fsMkdir", () => {
  test("default recursive=false, params correct", async () => {
    const { calls } = stubRequest(async () => ({ resolvedPath: "/tmp/d" }));
    await fsMkdir("/tmp/d");
    expect(calls[0]?.params).toEqual({ path: "/tmp/d", recursive: false });
  });

  test("recursive=true is forwarded", async () => {
    const { calls } = stubRequest(async () => ({ resolvedPath: "/tmp/a/b/c" }));
    await fsMkdir("/tmp/a/b/c", { recursive: true });
    expect(calls[0]?.params).toEqual({ path: "/tmp/a/b/c", recursive: true });
  });
});

describe("fsUnlink", () => {
  test("calls ezcorp/fs.unlink with path", async () => {
    const { calls } = stubRequest(async () => ({ resolvedPath: "/tmp/x" }));
    await fsUnlink("/tmp/x");
    expect(calls[0]?.method).toBe("ezcorp/fs.unlink");
    expect(calls[0]?.params).toEqual({ path: "/tmp/x" });
  });
});

// ── Streaming round-trip via channel chunked-frame protocol ─────

describe("fsRead — streaming round-trip via real channel", () => {
  // This test exercises the SDK's `channel.ts` chunked-frame state
  // machine end-to-end: synthesize announce + chunks for a 5MB
  // response on stdin, observe `fsRead` resolves with the assembled
  // body. Uses `createHostChannelForTests` so the singleton wires
  // through our controlled stdin.

  test("5MB chunked response reassembles correctly", async () => {
    process.env.EZCORP_FS_ALLOWED = "1";
    // We can't substitute the singleton mid-call (getChannel caches),
    // so build the test channel BEFORE fsRead is invoked. Use the
    // test channel's `request` directly to verify the streaming +
    // assembly path; the SDK's `fsRead` wrapper just adds the
    // params/decoding + base64 → string conversion, which is
    // covered by the stubbed-request tests above.
    const stdinQueue: string[] = [];
    let pendingResolve: ((v: IteratorResult<string>) => void) | null = null;
    let closed = false;
    const stdinIterable: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            const next = stdinQueue.shift();
            if (next !== undefined) return Promise.resolve({ value: next, done: false });
            if (closed) return Promise.resolve({ value: "", done: true });
            return new Promise((res) => {
              pendingResolve = res;
            });
          },
        };
      },
    };
    const stdoutWrites: string[] = [];
    const ch = createHostChannelForTests({
      stdin: stdinIterable,
      stdout: { write: (s) => { stdoutWrites.push(s); } },
    });
    ch.start();

    type ReadResult = { encoding: "utf-8" | "binary"; body: string; bytes: number; resolvedPath: string };
    const requestPromise = ch.request<ReadResult>(
      "ezcorp/fs.read",
      { path: "/tmp/big" },
      120_000,
    );

    // Wait for the request frame to be written so we know the
    // pending entry is registered (and grab the id).
    while (stdoutWrites.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const sentReq = JSON.parse(stdoutWrites[0]!) as { id: number };
    const id = sentReq.id;

    // Build a 5MB response body (base64-encoded, just like the host
    // does) and chunk it.
    const rawBytes = Buffer.alloc(5 * 1024 * 1024, 0x42);
    const responseObj = {
      jsonrpc: "2.0",
      id,
      result: {
        encoding: "utf-8",
        body: rawBytes.toString("base64"),
        bytes: rawBytes.byteLength,
        resolvedPath: "/tmp/big",
      },
    };
    const wire = JSON.stringify(responseObj);
    const CHUNK = 256 * 1024;
    const total = Math.ceil(wire.length / CHUNK);

    const push = (line: string) => {
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r({ value: line, done: false });
      } else {
        stdinQueue.push(line);
      }
    };

    push(`\x02${id}:${total}`);
    for (let i = 0; i < total; i++) {
      const piece = wire.slice(i * CHUNK, (i + 1) * CHUNK);
      const b64 = Buffer.from(piece, "binary").toString("base64");
      push(`\x01${id}:${i}:${b64}`);
      await new Promise((r) => setTimeout(r, 0));
    }

    const result = await requestPromise;
    expect(result.bytes).toBe(5 * 1024 * 1024);
    const decoded = Buffer.from(result.body, "base64");
    expect(decoded.length).toBe(5 * 1024 * 1024);
    expect(decoded[0]).toBe(0x42);

    closed = true;
    // M2 fix: TS narrows `pendingResolve` AND the alias bound to it
    // through the closure when we reassign it to null. Materialize
    // the call inline before the reassignment, casting through unknown
    // when none, to keep the type system out of the way.
    const resolver = pendingResolve as
      | ((v: IteratorResult<string>) => void)
      | null;
    pendingResolve = null;
    if (resolver !== null) {
      (resolver as (v: IteratorResult<string>) => void)({ value: "", done: true });
    }
  });

  test("out-of-order chunk rejects the streaming request", async () => {
    process.env.EZCORP_FS_ALLOWED = "1";
    const stdinQueue: string[] = [];
    let pendingResolve: ((v: IteratorResult<string>) => void) | null = null;
    let closed = false;
    const stdinIterable: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            const next = stdinQueue.shift();
            if (next !== undefined) return Promise.resolve({ value: next, done: false });
            if (closed) return Promise.resolve({ value: "", done: true });
            return new Promise((res) => {
              pendingResolve = res;
            });
          },
        };
      },
    };
    const stdoutWrites: string[] = [];
    const ch = createHostChannelForTests({
      stdin: stdinIterable,
      stdout: { write: (s) => { stdoutWrites.push(s); } },
    });
    ch.start();

    const p = ch.request<unknown>("ezcorp/fs.read", { path: "/x" }, 30_000);
    while (stdoutWrites.length === 0) await new Promise((r) => setTimeout(r, 5));
    const id = (JSON.parse(stdoutWrites[0]!) as { id: number }).id;

    const push = (line: string) => {
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r({ value: line, done: false });
      } else {
        stdinQueue.push(line);
      }
    };

    push(`\x02${id}:3`);
    push(`\x01${id}:0:${btoa("AAA")}`);
    push(`\x01${id}:2:${btoa("CCC")}`); // out of order

    await expect(p).rejects.toThrow(/out of order/);

    closed = true;
    // M2 fix: TS narrows `pendingResolve` AND the alias bound to it
    // through the closure when we reassign it to null. Materialize
    // the call inline before the reassignment, casting through unknown
    // when none, to keep the type system out of the way.
    const resolver = pendingResolve as
      | ((v: IteratorResult<string>) => void)
      | null;
    pendingResolve = null;
    if (resolver !== null) {
      (resolver as (v: IteratorResult<string>) => void)({ value: "", done: true });
    }
  });

  test("cancel frame surfaces error to caller", async () => {
    process.env.EZCORP_FS_ALLOWED = "1";
    const stdinQueue: string[] = [];
    let pendingResolve: ((v: IteratorResult<string>) => void) | null = null;
    let closed = false;
    const stdinIterable: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            const next = stdinQueue.shift();
            if (next !== undefined) return Promise.resolve({ value: next, done: false });
            if (closed) return Promise.resolve({ value: "", done: true });
            return new Promise((res) => {
              pendingResolve = res;
            });
          },
        };
      },
    };
    const stdoutWrites: string[] = [];
    const ch = createHostChannelForTests({
      stdin: stdinIterable,
      stdout: { write: (s) => { stdoutWrites.push(s); } },
    });
    ch.start();

    const p = ch.request<unknown>("ezcorp/fs.read", { path: "/x" }, 30_000);
    while (stdoutWrites.length === 0) await new Promise((r) => setTimeout(r, 5));
    const id = (JSON.parse(stdoutWrites[0]!) as { id: number }).id;

    const push = (line: string) => {
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r({ value: line, done: false });
      } else {
        stdinQueue.push(line);
      }
    };

    push(`\x02${id}:5`);
    push(`\x01${id}:0:${btoa("AAA")}`);
    push(`\x03${id}:host crashed`);

    await expect(p).rejects.toThrow(/cancelled/i);

    closed = true;
    // M2 fix: TS narrows `pendingResolve` AND the alias bound to it
    // through the closure when we reassign it to null. Materialize
    // the call inline before the reassignment, casting through unknown
    // when none, to keep the type system out of the way.
    const resolver = pendingResolve as
      | ((v: IteratorResult<string>) => void)
      | null;
    pendingResolve = null;
    if (resolver !== null) {
      (resolver as (v: IteratorResult<string>) => void)({ value: "", done: true });
    }
  });
});
