/**
 * E2E test for the bundled `extension-author` extension.
 *
 * Spawns the extension as a real subprocess via `ExtensionProcess` (the
 * same class the host uses in `ExtensionRegistry.getProcess`) and
 * exercises the round-trip: scaffold → write draft files → read →
 * patch → validate → discard.
 *
 * Reverse-RPC stubs at the subprocess boundary:
 *   - `ezcorp/drafts` — synthesized response with an in-memory store.
 *   - `ezcorp/fs.*`   — implemented over `node:fs/promises` against the
 *     test's tmp dir. Production wires the real fs-handler against the
 *     extension's filesystem grant; the unit test for the host-side
 *     fs-handler covers that path. This e2e exists to verify the
 *     EXTENSION subprocess's behavior — what files it writes, in what
 *     order, with what content.
 */
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { join } from "node:path";
import { mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

// DB stubs — same pattern as auto-note's e2e test. Must come BEFORE
// importing ExtensionProcess.
let _incrementCalls = 0;
let _resetCalls = 0;
let _disableCalls = 0;
let _simulatedConsecutiveFailures = 0;
mock.module("../../../../src/db/queries/extensions", () => ({
  incrementFailures: async () => {
    _incrementCalls++;
    _simulatedConsecutiveFailures++;
    return _simulatedConsecutiveFailures;
  },
  resetFailures: async () => {
    _resetCalls++;
    _simulatedConsecutiveFailures = 0;
  },
  disableExtension: async () => {
    _disableCalls++;
  },
}));

import { ExtensionProcess } from "../../../../src/extensions/subprocess";
import type { JsonRpcRequest, JsonRpcResponse } from "../../../../src/extensions/types";

const ENTRYPOINT = join(import.meta.dir, "index.ts");
const TEST_TMP_ROOT = join(tmpdir(), `extension-author-e2e-${Date.now()}`);

function buildAllowedEnvLike(extensionId: string): Record<string, string> {
  const extTmpDir = join(tmpdir(), "ezcorp-ext", extensionId);
  mkdirSync(extTmpDir, { recursive: true });
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "test",
    TMPDIR: extTmpDir,
    // The SDK's ensureFsAllowed() checks this flag before round-tripping
    // to the host. Without it, fsRead/fsWrite/etc throw before the
    // reverse-RPC even leaves the subprocess.
    EZCORP_FS_ALLOWED: "1",
  };
}

interface FakeDraftStore {
  drafts: Map<string, { userId: string; kind: string; payload: Record<string, unknown>; createdAt: number }>;
  nextId: number;
}

async function handleFsRpc(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const path = params.path as string;
  try {
    switch (req.method) {
      case "ezcorp/fs.read": {
        const buf = await readFile(path);
        const body = btoa(String.fromCharCode(...buf));
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: { encoding: params.encoding ?? "utf-8", body, bytes: buf.byteLength, resolvedPath: path },
        };
      }
      case "ezcorp/fs.write": {
        const content = params.content as string;
        const encoding = (params.encoding as string) ?? "utf-8";
        const buf =
          encoding === "binary"
            ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0))
            : new TextEncoder().encode(content);
        await writeFile(path, buf);
        return { jsonrpc: "2.0", id: req.id, result: { bytes: buf.byteLength, resolvedPath: path } };
      }
      case "ezcorp/fs.exists": {
        return { jsonrpc: "2.0", id: req.id, result: { exists: existsSync(path) } };
      }
      case "ezcorp/fs.mkdir": {
        await mkdir(path, { recursive: params.recursive === true });
        return { jsonrpc: "2.0", id: req.id, result: { resolvedPath: path } };
      }
      case "ezcorp/fs.list": {
        const ents = await readdir(path, { withFileTypes: true });
        const entries = ents.map((e) => ({
          name: e.name,
          isFile: e.isFile(),
          isDirectory: e.isDirectory(),
        }));
        return { jsonrpc: "2.0", id: req.id, result: { entries } };
      }
      case "ezcorp/fs.stat": {
        const s = await stat(path);
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            size: s.size,
            mtimeMs: s.mtimeMs,
            isFile: s.isFile(),
            isDirectory: s.isDirectory(),
            resolvedPath: path,
          },
        };
      }
      case "ezcorp/fs.unlink": {
        // Accept directory or file unlinks (best-effort to mirror the
        // host's POSIX-faithful implementation in the simple cases the
        // bundled extension uses).
        try {
          const s = await stat(path);
          if (s.isDirectory()) {
            // node:fs.rmdir requires empty dir. The bundled extension
            // recurses into entries first.
            await import("node:fs/promises").then((m) => m.rmdir(path));
          } else {
            await unlink(path);
          }
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32603, message: `unlink failed: ${(err as Error).message}` },
          };
        }
        return { jsonrpc: "2.0", id: req.id, result: { resolvedPath: path } };
      }
      default:
        return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Unknown method: ${req.method}` } };
    }
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32603, message: (err as Error).message },
    };
  }
}

function getDraftDirForUser(rootCwd: string, userId: string, draftId: string): string {
  return join(rootCwd, ".ezcorp/extension-data/extension-author/drafts", userId, draftId);
}

function makeProc(
  store: FakeDraftStore,
  rootCwd: string,
  userId: string = "user-a",
): ExtensionProcess {
  const extId = `extension-author-test-${Math.random().toString(36).slice(2, 8)}`;
  const env = buildAllowedEnvLike(extId);
  const proc = new ExtensionProcess(extId, ENTRYPOINT, env, {
    persistent: true,
    callTimeoutMs: 15_000,
  });
  proc.setRequestHandler(async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    if (req.method.startsWith("ezcorp/fs.")) {
      return handleFsRpc(req);
    }
    if (req.method === "ezcorp/drafts") {
      const params = (req.params ?? {}) as Record<string, unknown>;
      if (params.action === "create") {
        const id = `draft-${++store.nextId}`;
        const payload = (params.payload as Record<string, unknown>) ?? {};
        const draftDir = getDraftDirForUser(rootCwd, userId, id);
        // Mirror prod: stamp draftDir into the payload post-insert.
        store.drafts.set(id, {
          userId,
          kind: params.kind as string,
          payload: { ...payload, draftDir },
          createdAt: Date.now(),
        });
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: { draftId: id, openUrl: `/extensions/author?prefill=${id}` },
        };
      }
      if (params.action === "consume") {
        const id = params.draftId as string;
        const row = store.drafts.get(id);
        if (!row || row.userId !== userId) {
          return { jsonrpc: "2.0", id: req.id, result: { ok: false } };
        }
        store.drafts.delete(id);
        return { jsonrpc: "2.0", id: req.id, result: { ok: true } };
      }
      if (params.action === "resolveDir") {
        const id = params.draftId as string;
        const row = store.drafts.get(id);
        // Opacity: same -32603 for missing / wrong-owner.
        if (!row || row.userId !== userId) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32603, message: "Draft not found" },
          };
        }
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: { draftDir: getDraftDirForUser(rootCwd, userId, id) },
        };
      }
      if (params.action === "listForUser") {
        const drafts = Array.from(store.drafts.entries())
          .filter(([_id, r]) => r.userId === userId)
          .map(([id, r]) => ({
            draftId: id,
            name: typeof r.payload.name === "string" ? r.payload.name : undefined,
            type: typeof r.payload.type === "string" ? r.payload.type : undefined,
            createdAt: r.createdAt,
          }));
        return { jsonrpc: "2.0", id: req.id, result: { drafts } };
      }
      if (params.action === "discard") {
        const id = params.draftId as string;
        const row = store.drafts.get(id);
        if (!row || row.userId !== userId) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32603, message: "Draft not found" },
          };
        }
        const dir = getDraftDirForUser(rootCwd, userId, id);
        try {
          if (existsSync(dir)) {
            await import("node:fs/promises").then((m) => m.rm(dir, { recursive: true, force: true }));
          }
        } catch {
          // best-effort
        }
        store.drafts.delete(id);
        return { jsonrpc: "2.0", id: req.id, result: { ok: true } };
      }
      return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "stub: unknown drafts action" } };
    }
    return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found in stub" } };
  });
  return proc;
}

describe("extension-author e2e — server pipeline round-trip", () => {
  let cwd: string;
  let originalCwd: string;
  let store: FakeDraftStore;
  const procs: ExtensionProcess[] = [];

  beforeEach(() => {
    cwd = join(TEST_TMP_ROOT, `cwd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(cwd, ".git"), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(cwd);
    store = { drafts: new Map(), nextId: 0 };
  });

  afterEach(() => {
    for (const p of procs.splice(0)) {
      try { p.kill(); } catch { /* swallow */ }
    }
    try { process.chdir(originalCwd); } catch { /* swallow */ }
  });

  test("create_extension scaffolds files + creates draft + returns openUrl", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);

    const result = await proc.callTool("create_extension", {
      name: "weather",
      type: "tool",
      description: "Returns current weather",
    });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.draftId).toMatch(/^draft-\d+$/);
    expect(payload.openUrl).toBe(`/extensions/author?prefill=${payload.draftId}`);
    expect(payload.name).toBe("weather");
    expect(payload.type).toBe("tool");

    // On-disk files exist
    const draftDir = join(cwd, ".ezcorp/extension-data/extension-author/drafts", "user-a", payload.draftId);
    expect(existsSync(join(draftDir, "ezcorp.config.ts"))).toBe(true);
    expect(existsSync(join(draftDir, "index.ts"))).toBe(true);
    expect(existsSync(join(draftDir, "README.md"))).toBe(true);
    expect(existsSync(join(draftDir, "package.json"))).toBe(true);
    // Skill type omits index.ts — verify a separate scaffold path too.
    expect(store.drafts.has(payload.draftId)).toBe(true);
  }, 30_000);

  test("create_extension scaffold for skill omits index.ts", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);
    const result = await proc.callTool("create_extension", {
      name: "trivia",
      type: "skill",
      description: "x",
    });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text);
    const dir = join(cwd, ".ezcorp/extension-data/extension-author/drafts", "user-a", payload.draftId);
    expect(existsSync(join(dir, "index.ts"))).toBe(false);
    expect(existsSync(join(dir, "ezcorp.config.ts"))).toBe(true);
  }, 30_000);

  test("create_extension validates name regex (UPPERCASE rejected)", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);

    const bad = await proc.callTool("create_extension", {
      name: "BadName",
      type: "tool",
      description: "x",
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/Scaffold failed|NAME_REGEX|match/);
    // No draft row created on validation failure.
    expect(store.drafts.size).toBe(0);
  }, 30_000);

  test("create_extension rejects invalid type", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);

    const bad = await proc.callTool("create_extension", {
      name: "x",
      type: "weird",
      description: "x",
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/type.*must be one of/);
  }, 30_000);

  test("read_draft returns full file map for a created draft", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);

    const create = JSON.parse(
      (await proc.callTool("create_extension", { name: "x1", type: "tool", description: "x" }))
        .content[0]!.text,
    );
    const read = await proc.callTool("read_draft", { draftId: create.draftId });
    expect(read.isError).toBe(false);
    const payload = JSON.parse(read.content[0]!.text);
    expect(payload.draftId).toBe(create.draftId);
    expect(typeof payload.files["ezcorp.config.ts"]).toBe("string");
    expect(payload.files["ezcorp.config.ts"]).toContain("name: \"x1\"");
    expect(typeof payload.files["index.ts"]).toBe("string");
  }, 30_000);

  test("write_draft_file patches a known file", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);
    const create = JSON.parse(
      (await proc.callTool("create_extension", { name: "x2", type: "skill", description: "x" }))
        .content[0]!.text,
    );

    const newReadme = "# Patched README\n\nedited by test";
    const write = await proc.callTool("write_draft_file", {
      draftId: create.draftId,
      path: "README.md",
      content: newReadme,
    });
    expect(write.isError).toBe(false);

    const read = await proc.callTool("read_draft", { draftId: create.draftId });
    const payload = JSON.parse(read.content[0]!.text);
    expect(payload.files["README.md"]).toBe(newReadme);
  }, 30_000);

  test("write_draft_file rejects path traversal", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);
    const create = JSON.parse(
      (await proc.callTool("create_extension", { name: "x3", type: "skill", description: "x" }))
        .content[0]!.text,
    );

    const traverse = await proc.callTool("write_draft_file", {
      draftId: create.draftId,
      path: "../../etc/passwd",
      content: "evil",
    });
    expect(traverse.isError).toBe(true);
    expect(traverse.content[0]!.text).toMatch(/allowlist|relative|\.\./);
  }, 30_000);

  test("write_draft_file rejects path not in scaffolder allowlist", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);
    const create = JSON.parse(
      (await proc.callTool("create_extension", { name: "x4", type: "skill", description: "x" }))
        .content[0]!.text,
    );

    const bad = await proc.callTool("write_draft_file", {
      draftId: create.draftId,
      path: "secret.key",
      content: "abc",
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/allowlist/);
  }, 30_000);

  test("validate_extension returns ok for fresh scaffold", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);
    const create = JSON.parse(
      (await proc.callTool("create_extension", { name: "x5", type: "tool", description: "x" }))
        .content[0]!.text,
    );

    const validate = await proc.callTool("validate_extension", { draftId: create.draftId });
    expect(validate.isError).toBe(false);
    const payload = JSON.parse(validate.content[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.errors).toEqual([]);
  }, 30_000);

  test("validate_extension reports errors after manifest corruption", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);
    const create = JSON.parse(
      (await proc.callTool("create_extension", { name: "x6", type: "tool", description: "x" }))
        .content[0]!.text,
    );

    // Patch the manifest to be invalid (drop required `name`).
    const corrupted = `import { defineExtension } from "@ezcorp/sdk";\nexport default defineExtension({ schemaVersion: 2, version: "0.1.0", description: "x", author: { name: "x" }, permissions: {} });\n`;
    await proc.callTool("write_draft_file", {
      draftId: create.draftId,
      path: "ezcorp.config.ts",
      content: corrupted,
    });

    const validate = await proc.callTool("validate_extension", { draftId: create.draftId });
    expect(validate.isError).toBe(false);
    const payload = JSON.parse(validate.content[0]!.text);
    expect(payload.ok).toBe(false);
    expect(payload.errors.length).toBeGreaterThan(0);
  }, 30_000);

  test("list_drafts surfaces known directories", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);

    await proc.callTool("create_extension", { name: "ld-1", type: "tool", description: "x" });
    await proc.callTool("create_extension", { name: "ld-2", type: "skill", description: "x" });

    const list = await proc.callTool("list_drafts", {});
    expect(list.isError).toBe(false);
    const payload = JSON.parse(list.content[0]!.text);
    expect(payload.drafts.length).toBe(2);
    for (const d of payload.drafts) {
      expect(typeof d.draftId).toBe("string");
      expect(typeof d.createdAt).toBe("number");
    }
  }, 30_000);

  test("discard_draft removes dir + marks row consumed", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);

    const create = JSON.parse(
      (await proc.callTool("create_extension", { name: "d1", type: "tool", description: "x" }))
        .content[0]!.text,
    );
    const dir = join(cwd, ".ezcorp/extension-data/extension-author/drafts", "user-a", create.draftId);
    expect(existsSync(dir)).toBe(true);

    const discard = await proc.callTool("discard_draft", { draftId: create.draftId });
    expect(discard.isError).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(store.drafts.has(create.draftId)).toBe(false);
  }, 30_000);

  test("read_draft on unknown id returns error", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);
    const r = await proc.callTool("read_draft", { draftId: "nonexistent" });
    expect(r.isError).toBe(true);
    // resolveDir-based gate: missing/wrong-owner both return the same
    // opaque "not accessible" / "not found" error per reviewer C1.
    expect(r.content[0]!.text).toMatch(/not accessible|not found|does not exist/);
  }, 30_000);

  test("read_draft rejects malformed draftId", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);
    const r = await proc.callTool("read_draft", { draftId: "../escape" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid/);
  }, 30_000);

  test("scaffolded ezcorp.config.ts contains @ezcorp/sdk import", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);
    const create = JSON.parse(
      (await proc.callTool("create_extension", { name: "x9", type: "tool", description: "x" }))
        .content[0]!.text,
    );
    const dir = join(cwd, ".ezcorp/extension-data/extension-author/drafts", "user-a", create.draftId);
    const cfg = readFileSync(join(dir, "ezcorp.config.ts"), "utf8");
    expect(cfg).toContain('from "@ezcorp/sdk"');
  }, 30_000);

  // ── Cross-user owner-isolation (reviewer C1 regression) ──────────────
  //
  // Spawn two subprocesses with different `userId` contexts; verify that
  // user B cannot read, write, or discard a draft owned by user A, and
  // that B's list_drafts only surfaces B's own drafts.

  test("user B cannot read user A's draft (read_draft → error)", async () => {
    const procA = makeProc(store, cwd, "user-a");
    const procB = makeProc(store, cwd, "user-b");
    procs.push(procA, procB);

    const create = JSON.parse(
      (await procA.callTool("create_extension", { name: "a-1", type: "tool", description: "x" }))
        .content[0]!.text,
    );

    const read = await procB.callTool("read_draft", { draftId: create.draftId });
    expect(read.isError).toBe(true);
    expect(read.content[0]!.text).toMatch(/not accessible|not found/i);
  }, 30_000);

  test("user B cannot write to user A's draft (write_draft_file → error)", async () => {
    const procA = makeProc(store, cwd, "user-a");
    const procB = makeProc(store, cwd, "user-b");
    procs.push(procA, procB);

    const create = JSON.parse(
      (await procA.callTool("create_extension", { name: "a-2", type: "tool", description: "x" }))
        .content[0]!.text,
    );

    const write = await procB.callTool("write_draft_file", {
      draftId: create.draftId,
      path: "README.md",
      content: "owned",
    });
    expect(write.isError).toBe(true);
    expect(write.content[0]!.text).toMatch(/not accessible|not found/i);
  }, 30_000);

  test("user B cannot discard user A's draft (discard_draft → error, dir survives)", async () => {
    const procA = makeProc(store, cwd, "user-a");
    const procB = makeProc(store, cwd, "user-b");
    procs.push(procA, procB);

    const create = JSON.parse(
      (await procA.callTool("create_extension", { name: "a-3", type: "tool", description: "x" }))
        .content[0]!.text,
    );

    const dir = join(cwd, ".ezcorp/extension-data/extension-author/drafts", "user-a", create.draftId);
    expect(existsSync(dir)).toBe(true);

    const discard = await procB.callTool("discard_draft", { draftId: create.draftId });
    expect(discard.isError).toBe(true);
    expect(discard.content[0]!.text).toMatch(/not found|discard failed/i);

    // The draft + its on-disk dir survive — B's discard was a no-op.
    expect(store.drafts.has(create.draftId)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  }, 30_000);

  test("user B's list_drafts excludes user A's drafts", async () => {
    const procA = makeProc(store, cwd, "user-a");
    const procB = makeProc(store, cwd, "user-b");
    procs.push(procA, procB);

    const aCreate = JSON.parse(
      (await procA.callTool("create_extension", { name: "a-4", type: "tool", description: "x" }))
        .content[0]!.text,
    );
    const bCreate = JSON.parse(
      (await procB.callTool("create_extension", { name: "b-1", type: "tool", description: "x" }))
        .content[0]!.text,
    );

    const list = await procB.callTool("list_drafts", {});
    expect(list.isError).toBe(false);
    const payload = JSON.parse(list.content[0]!.text);
    const ids = payload.drafts.map((d: { draftId: string }) => d.draftId);
    expect(ids).toContain(bCreate.draftId);
    expect(ids).not.toContain(aCreate.draftId);
  }, 30_000);

  // Spec line 257: smoke-spawn verification + dir-removal contract for
  // discard_draft (formerly leaked the dir via fsUnlink-on-dir; reviewer
  // C2). Confirms `Bun.file(...).exists()` returns false after discard.
  test("discard_draft truly removes the dir from disk (no fsUnlink-EISDIR leak)", async () => {
    const proc = makeProc(store, cwd);
    procs.push(proc);

    const create = JSON.parse(
      (await proc.callTool("create_extension", { name: "d2", type: "tool", description: "x" }))
        .content[0]!.text,
    );
    const dir = join(cwd, ".ezcorp/extension-data/extension-author/drafts", "user-a", create.draftId);
    expect(existsSync(dir)).toBe(true);

    const discard = await proc.callTool("discard_draft", { draftId: create.draftId });
    expect(discard.isError).toBe(false);

    // Bun-native exists check (per spec line ~261). False = the dir was
    // recursively removed (not just emptied).
    expect(await Bun.file(dir).exists()).toBe(false);
    expect(existsSync(dir)).toBe(false);
  }, 30_000);
});

// Cleanup TEST_TMP_ROOT after the suite.
import { afterAll } from "bun:test";
afterAll(() => {
  try { rmSync(TEST_TMP_ROOT, { recursive: true }); } catch { /* swallow */ }
});
