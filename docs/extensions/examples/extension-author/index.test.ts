/**
 * In-process unit tests for the extension-author tool handlers.
 *
 * The sibling `e2e-server-pipeline.test.ts` spawns this extension as a
 * real subprocess, which is the right shape for the wire contract but
 * measures NO coverage (a child process is not instrumented by the
 * parent) and cannot easily drive host responses that are malformed
 * rather than merely failing. These tests import the handlers directly
 * with `@ezcorp/sdk/runtime` mocked, so every branch — including the
 * response-validation paths added after a shape-broken host reply was
 * found to produce `{ok:true, extensionId:""}` — is exercised.
 */

import { test, expect, describe, beforeEach, mock } from "bun:test";

// ── Mutable fakes, swapped per test ─────────────────────────────────
let rpcImpl: (method: string, params: Record<string, unknown>) => Promise<unknown> =
  async () => ({});
let existsImpl: (p: string) => Promise<boolean> = async () => true;
let readImpl: (p: string) => Promise<string | Uint8Array> = async (p) => `content of ${p}`;
let writeImpl: (p: string, c: string) => Promise<void> = async () => {};
let scaffoldImpl: (args: Record<string, unknown>) => { files: Record<string, string> } = () => ({
  files: { "ezcorp.config.ts": "cfg", "index.ts": "entry" },
});
/** Every `getChannel().request` call, for asserting the wire params. */
let rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];

mock.module("@ezcorp/sdk/runtime", () => ({
  toolResult: (text: string) => ({ content: [{ type: "text", text }], isError: false }),
  toolError: (message: string) => ({
    content: [{ type: "text", text: message }],
    isError: true,
  }),
  getChannel: () => ({
    request: (method: string, params: Record<string, unknown>) => {
      rpcCalls.push({ method, params });
      return rpcImpl(method, params);
    },
    start: () => {},
  }),
  createToolDispatcher: () => {},
  fsExists: (p: string) => existsImpl(p),
  fsRead: (p: string) => readImpl(p),
  fsWrite: (p: string, c: string) => writeImpl(p, c),
}));

mock.module("@ezcorp/sdk", () => ({
  scaffoldExtension: (args: Record<string, unknown>) => scaffoldImpl(args),
}));

const { tools } = await import("./index");

// ── Helpers ─────────────────────────────────────────────────────────

interface Result {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}

async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  const handler = tools[name];
  if (!handler) throw new Error(`no such tool: ${name}`);
  return (await handler(args)) as unknown as Result;
}

function body(r: Result): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

function text(r: Result): string {
  return r.content[0]!.text;
}

/** The dir every resolveDir stub hands back. */
const DRAFT_DIR = "/drafts/d1";

/** A JsonRpc-style rejection carrying the host's structured `data.code`. */
function rpcFailure(message: string, code?: string): Error {
  const err = new Error(message) as Error & { data?: { code: string } };
  if (code) err.data = { code };
  return err;
}

beforeEach(() => {
  rpcCalls = [];
  rpcImpl = async () => ({});
  existsImpl = async () => true;
  readImpl = async (p) => `content of ${p}`;
  writeImpl = async () => {};
  scaffoldImpl = () => ({ files: { "ezcorp.config.ts": "cfg", "index.ts": "entry" } });
});

// ── create_extension ────────────────────────────────────────────────

describe("create_extension", () => {
  test("scaffolds, ships the file map to the host, returns the draft link", async () => {
    rpcImpl = async () => ({ draftId: "d1", openUrl: "/extensions/author?prefill=d1" });
    const r = await call("create_extension", {
      name: "weather",
      type: "tool",
      description: "returns weather",
    });
    expect(r.isError).toBe(false);
    expect(body(r)).toEqual({
      draftId: "d1",
      openUrl: "/extensions/author?prefill=d1",
      name: "weather",
      type: "tool",
    });
    // The HOST materializes the files — they ride the create call.
    expect(rpcCalls[0]!.params.action).toBe("create");
    expect(rpcCalls[0]!.params.files).toEqual({
      "ezcorp.config.ts": "cfg",
      "index.ts": "entry",
    });
    expect(rpcCalls[0]!.params.payload).toEqual({
      name: "weather",
      type: "tool",
      mode: "author",
    });
  });

  test("rejects a non-string name / type / description", async () => {
    expect(text(await call("create_extension", { name: 1, type: "tool", description: "d" })))
      .toContain("`name` must be a string");
    expect(text(await call("create_extension", { name: "n", type: 1, description: "d" })))
      .toContain("`type` must be a string");
    expect(text(await call("create_extension", { name: "n", type: "tool", description: 1 })))
      .toContain("`description` must be a string");
  });

  // This exact rejection is the manifest's declared smokeTest probe.
  test("rejects an unknown type before touching the scaffolder or the host", async () => {
    let scaffolded = false;
    scaffoldImpl = () => {
      scaffolded = true;
      return { files: {} };
    };
    const r = await call("create_extension", {
      name: "n",
      type: "not-a-real-type",
      description: "d",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("must be one of tool|skill|agent|multi");
    expect(scaffolded).toBe(false);
    expect(rpcCalls).toEqual([]);
  });

  test("a scaffolder throw fails BEFORE a draft row is minted", async () => {
    scaffoldImpl = () => {
      throw new Error("bad name shape");
    };
    const r = await call("create_extension", { name: "N", type: "tool", description: "d" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Scaffold failed: bad name shape");
    expect(rpcCalls).toEqual([]);
  });

  test("a failing create RPC is surfaced verbatim", async () => {
    rpcImpl = async () => {
      throw new Error("db offline");
    };
    const r = await call("create_extension", { name: "n", type: "skill", description: "d" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("ezcorp/drafts.create failed: db offline");
  });
});

// ── validate_extension ──────────────────────────────────────────────

describe("validate_extension", () => {
  test("returns the host's structured verdict", async () => {
    rpcImpl = async (_m, params) => {
      if (params.action === "resolveDir") return { draftDir: "/drafts/d1" };
      return { pass: true, steps: [{ name: "load-manifest", ok: true, detail: "ok" }] };
    };
    const r = await call("validate_extension", { draftId: "d1" });
    expect(body(r)).toEqual({
      ok: true,
      pass: true,
      steps: [{ name: "load-manifest", ok: true, detail: "ok" }],
    });
  });

  test("a FAILING gate is a result, not an error (the LLM must read the steps)", async () => {
    rpcImpl = async (_m, params) => {
      if (params.action === "resolveDir") return { draftDir: "/drafts/d1" };
      return { pass: false, steps: [{ name: "smoke-test-roundtrip", ok: false, detail: "boom" }] };
    };
    const r = await call("validate_extension", { draftId: "d1" });
    expect(r.isError).toBe(false);
    expect(body(r).ok).toBe(false);
    expect(body(r).pass).toBe(false);
  });

  test("a verdict with no steps still parses", async () => {
    rpcImpl = async (_m, params) =>
      params.action === "resolveDir" ? { draftDir: "/d" } : {};
    expect(body(await call("validate_extension", { draftId: "d1" }))).toEqual({
      ok: false,
      pass: false,
      steps: [],
    });
  });

  test("rejects a malformed draftId without a round trip", async () => {
    const r = await call("validate_extension", { draftId: "bad id!" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Invalid draftId: "bad id!"');
    expect(rpcCalls).toEqual([]);
  });

  test("an unresolvable draft reports the opaque ownership failure", async () => {
    rpcImpl = async () => {
      throw new Error("Draft not found");
    };
    expect(text(await call("validate_extension", { draftId: "d1" }))).toContain(
      "Draft not accessible",
    );
  });

  test("a host that returns no draftDir is rejected", async () => {
    rpcImpl = async () => ({ draftDir: "" });
    expect(text(await call("validate_extension", { draftId: "d1" }))).toContain(
      "Host returned no draftDir",
    );
  });

  test("missing dir / missing manifest are distinct messages", async () => {
    rpcImpl = async () => ({ draftDir: "/drafts/d1" });
    existsImpl = async () => false;
    expect(text(await call("validate_extension", { draftId: "d1" }))).toContain(
      "Draft directory does not exist",
    );
    existsImpl = async (p) => !p.endsWith("ezcorp.config.ts");
    expect(text(await call("validate_extension", { draftId: "d1" }))).toContain(
      "Draft missing ezcorp.config.ts",
    );
  });

  test("a verify transport failure carries the host's structured code", async () => {
    rpcImpl = async (_m, params) => {
      if (params.action === "resolveDir") return { draftDir: "/d" };
      throw rpcFailure("nope", "PERMISSION_NOT_GRANTED");
    };
    const r = await call("validate_extension", { draftId: "d1" });
    expect(r.isError).toBe(true);
    expect(body(r).code).toBe("PERMISSION_NOT_GRANTED");
  });

  test("a codeless verify failure omits `code` rather than inventing one", async () => {
    rpcImpl = async (_m, params) => {
      if (params.action === "resolveDir") return { draftDir: "/d" };
      throw new Error("transport died");
    };
    const b = body(await call("validate_extension", { draftId: "d1" }));
    expect(b.ok).toBe(false);
    expect("code" in b).toBe(false);
  });
});

// ── list_drafts ─────────────────────────────────────────────────────

describe("list_drafts", () => {
  test("passes the host's owner-scoped list through", async () => {
    rpcImpl = async () => ({ drafts: [{ draftId: "d1", createdAt: 1 }] });
    expect(body(await call("list_drafts", {}))).toEqual({
      drafts: [{ draftId: "d1", createdAt: 1 }],
    });
  });

  test("a host response without `drafts` degrades to an empty list", async () => {
    rpcImpl = async () => ({});
    expect(body(await call("list_drafts", {}))).toEqual({ drafts: [] });
  });

  test("a failing list is an error, not an empty list", async () => {
    rpcImpl = async () => {
      throw new Error("db offline");
    };
    const r = await call("list_drafts", {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("ezcorp/drafts.listForUser failed");
  });
});

// ── read_draft ──────────────────────────────────────────────────────

describe("read_draft", () => {
  beforeEach(() => {
    rpcImpl = async () => ({ draftDir: "/drafts/d1" });
  });

  test("returns the file map, and omits `unreadable` when everything read", async () => {
    existsImpl = async (p) => p === DRAFT_DIR || p.endsWith("ezcorp.config.ts") || p.endsWith("index.ts");
    const b = body(await call("read_draft", { draftId: "d1" }));
    expect(Object.keys(b.files as object).sort()).toEqual(["ezcorp.config.ts", "index.ts"]);
    expect("unreadable" in b).toBe(false);
  });

  test("decodes a binary read into text", async () => {
    existsImpl = async (p) => p === DRAFT_DIR || p.endsWith("index.ts");
    readImpl = async () => new TextEncoder().encode("binary entry");
    const b = body(await call("read_draft", { draftId: "d1" }));
    expect((b.files as Record<string, string>)["index.ts"]).toBe("binary entry");
  });

  // Silently dropping the file let the model "read" a draft, never see
  // index.ts, and then rewrite a file it had not looked at.
  test("an unreadable file is REPORTED, and the rest still return", async () => {
    existsImpl = async (p) => p === DRAFT_DIR || p.endsWith("ezcorp.config.ts") || p.endsWith("index.ts");
    readImpl = async (p) => {
      if (p.endsWith("index.ts")) throw new Error("EACCES: permission denied");
      return "cfg";
    };
    const b = body(await call("read_draft", { draftId: "d1" }));
    expect((b.files as Record<string, string>)["ezcorp.config.ts"]).toBe("cfg");
    expect((b.files as Record<string, string>)["index.ts"]).toBeUndefined();
    expect(b.unreadable).toEqual([{ path: "index.ts", error: "EACCES: permission denied" }]);
  });

  test("rejects a malformed draftId and an unresolvable draft", async () => {
    expect(text(await call("read_draft", { draftId: "../etc" }))).toContain("Invalid draftId");
    rpcImpl = async () => {
      throw new Error("Draft not found");
    };
    expect(text(await call("read_draft", { draftId: "d1" }))).toContain("Draft not accessible");
  });

  test("a missing draft directory is an error", async () => {
    existsImpl = async () => false;
    expect(text(await call("read_draft", { draftId: "d1" }))).toContain(
      "Draft directory does not exist",
    );
  });
});

// ── write_draft_file ────────────────────────────────────────────────

describe("write_draft_file", () => {
  beforeEach(() => {
    rpcImpl = async () => ({ draftDir: "/drafts/d1" });
  });

  test("writes an allowlisted file under the resolved dir", async () => {
    const writes: Array<[string, string]> = [];
    writeImpl = async (p, c) => {
      writes.push([p, c]);
    };
    const r = await call("write_draft_file", {
      draftId: "d1",
      path: "index.ts",
      content: "// new",
    });
    expect(body(r)).toEqual({ ok: true, path: "index.ts" });
    expect(writes).toEqual([["/drafts/d1/index.ts", "// new"]]);
  });

  test("rejects a bad draftId / non-string path / non-string content", async () => {
    expect(text(await call("write_draft_file", { draftId: "!", path: "a", content: "b" })))
      .toContain("Invalid draftId");
    expect(text(await call("write_draft_file", { draftId: "d1", path: 1, content: "b" })))
      .toContain("`path` must be a string");
    expect(text(await call("write_draft_file", { draftId: "d1", path: "index.ts", content: 1 })))
      .toContain("`content` must be a string");
  });

  test("path allowlist + traversal defences", async () => {
    const cases: Array<[string, string]> = [
      ["/etc/passwd", "Path must be relative"],
      ["secret.key", "not in scaffolder file allowlist"],
      ["../index.ts", "not in scaffolder file allowlist"],
    ];
    for (const [path, expected] of cases) {
      expect(text(await call("write_draft_file", { draftId: "d1", path, content: "x" })))
        .toContain(expected);
    }
  });

  test("an unresolvable draft and a missing dir are distinct failures", async () => {
    rpcImpl = async () => {
      throw new Error("Draft not found");
    };
    expect(text(await call("write_draft_file", { draftId: "d1", path: "index.ts", content: "x" })))
      .toContain("Draft not accessible");
    rpcImpl = async () => ({ draftDir: "/drafts/d1" });
    existsImpl = async () => false;
    expect(text(await call("write_draft_file", { draftId: "d1", path: "index.ts", content: "x" })))
      .toContain("Draft directory does not exist");
  });

  test("a failing write is surfaced, never reported as ok", async () => {
    writeImpl = async () => {
      throw new Error("disk full");
    };
    const r = await call("write_draft_file", {
      draftId: "d1",
      path: "index.ts",
      content: "x",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Failed to write file: disk full");
  });
});

// ── discard_draft ───────────────────────────────────────────────────

describe("discard_draft", () => {
  test("one round trip; host result passed through", async () => {
    rpcImpl = async () => ({ ok: true });
    expect(body(await call("discard_draft", { draftId: "d1" }))).toEqual({ ok: true });
    expect(rpcCalls[0]!.params.action).toBe("discard");
  });

  test("a host `ok:false` is not upgraded to true", async () => {
    rpcImpl = async () => ({ ok: false });
    expect(body(await call("discard_draft", { draftId: "d1" }))).toEqual({ ok: false });
  });

  test("rejects a malformed draftId; surfaces a failing discard", async () => {
    expect(text(await call("discard_draft", { draftId: "" }))).toContain("Invalid draftId");
    rpcImpl = async () => {
      throw new Error("db offline");
    };
    expect(text(await call("discard_draft", { draftId: "d1" }))).toContain(
      "ezcorp/drafts.discard failed",
    );
  });
});

// ── install_draft ───────────────────────────────────────────────────

describe("install_draft", () => {
  test("success passes the host-revalidated openUrl through verbatim", async () => {
    rpcImpl = async () => ({
      ok: true,
      extensionId: "ext-1",
      name: "weather",
      openUrl: "/extensions/weather",
    });
    expect(body(await call("install_draft", { draftId: "d1" }))).toEqual({
      ok: true,
      extensionId: "ext-1",
      name: "weather",
      openUrl: "/extensions/weather",
    });
  });

  test("a withheld openUrl is omitted, not synthesized", async () => {
    rpcImpl = async () => ({ ok: true, extensionId: "ext-1", name: "weather" });
    const b = body(await call("install_draft", { draftId: "d1" }));
    expect("openUrl" in b).toBe(false);
    expect(b.name).toBe("weather");
  });

  test("an empty-string openUrl is treated as withheld", async () => {
    rpcImpl = async () => ({ ok: true, extensionId: "ext-1", name: "w", openUrl: "" });
    expect("openUrl" in body(await call("install_draft", { draftId: "d1" }))).toBe(false);
  });

  // `?? ""` used to turn these into `{ok:true, extensionId:""}` — a green
  // install card for an extension that may not exist.
  test("a shape-broken host result is BAD_HOST_RESPONSE, never ok:true", async () => {
    for (const bad of [{ ok: true }, { ok: true, extensionId: "" }, { ok: false, extensionId: "e" }]) {
      rpcImpl = async () => bad;
      const r = await call("install_draft", { draftId: "d1" });
      expect(r.isError).toBe(true);
      expect(body(r).ok).toBe(false);
      expect(body(r).code).toBe("BAD_HOST_RESPONSE");
      expect(body(r).error).toContain("may or may not have");
    }
  });

  test("a missing `name` degrades to empty string but keeps ok:true", async () => {
    rpcImpl = async () => ({ ok: true, extensionId: "ext-1" });
    expect(body(await call("install_draft", { draftId: "d1" }))).toEqual({
      ok: true,
      extensionId: "ext-1",
      name: "",
    });
  });

  test("a structured host error keeps its code for deterministic branching", async () => {
    rpcImpl = async () => {
      throw rpcFailure("NAME_COLLISION: taken", "NAME_COLLISION");
    };
    const r = await call("install_draft", { draftId: "d1" });
    expect(r.isError).toBe(true);
    expect(body(r).code).toBe("NAME_COLLISION");
  });

  test("a codeless host error omits `code`", async () => {
    rpcImpl = async () => {
      throw new Error("kaboom");
    };
    const b = body(await call("install_draft", { draftId: "d1" }));
    expect("code" in b).toBe(false);
    expect(b.error).toContain("kaboom");
  });

  test("rejects a malformed draftId without a round trip", async () => {
    expect(text(await call("install_draft", { draftId: "no spaces allowed" }))).toContain(
      "Invalid draftId",
    );
    expect(rpcCalls).toEqual([]);
  });
});

// ── modify_extension ────────────────────────────────────────────────

describe("modify_extension", () => {
  test("success returns the draft to continue editing in", async () => {
    rpcImpl = async () => ({ draftId: "d9", name: "weather" });
    expect(body(await call("modify_extension", { name: "weather" }))).toEqual({
      ok: true,
      draftId: "d9",
      name: "weather",
    });
    expect(rpcCalls[0]!.params).toEqual({ action: "reopen", name: "weather" });
  });

  test("falls back to the requested name when the host omits it", async () => {
    rpcImpl = async () => ({ draftId: "d9" });
    expect(body(await call("modify_extension", { name: "weather" })).name).toBe("weather");
  });

  // Hardcoding ok:true sent the model to read_draft(""), whose "Invalid
  // draftId" error is about the wrong thing and masks the real fault.
  test("a draftId-less host result is BAD_HOST_RESPONSE, never ok:true", async () => {
    for (const bad of [{ name: "weather" }, { draftId: "" }]) {
      rpcImpl = async () => bad;
      const r = await call("modify_extension", { name: "weather" });
      expect(r.isError).toBe(true);
      expect(body(r).code).toBe("BAD_HOST_RESPONSE");
      expect(body(r).error).toContain("read_draft");
    }
  });

  test("rejects a missing / empty name", async () => {
    expect(text(await call("modify_extension", {}))).toContain("must be a non-empty string");
    expect(text(await call("modify_extension", { name: "" }))).toContain(
      "must be a non-empty string",
    );
  });

  test("a structured host error keeps its code", async () => {
    rpcImpl = async () => {
      throw rpcFailure("nope", "NOT_FOUND_OR_NOT_MODIFIABLE");
    };
    const r = await call("modify_extension", { name: "weather" });
    expect(body(r).code).toBe("NOT_FOUND_OR_NOT_MODIFIABLE");
  });

  test("a codeless host error omits `code`", async () => {
    rpcImpl = async () => {
      throw new Error("transport died");
    };
    const b = body(await call("modify_extension", { name: "weather" }));
    expect("code" in b).toBe(false);
    expect(b.error).toContain("transport died");
  });
});
