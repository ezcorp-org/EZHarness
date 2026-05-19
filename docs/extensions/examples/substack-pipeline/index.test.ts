// substack-pipeline — manifest validation + 3-tool pipeline logic.
//
// Manifest tests mirror substack-pilot/index.test.ts (pipe through the
// host's validateManifestV2). Logic tests drive draftPost/revisePost/
// finalizePost with the LLM, cross-ext invoke, and conversation storage
// all injected via seams — zero network / LLM / subprocess.

import { test, expect, describe, afterEach } from "bun:test";
import manifest from "./ezcorp.config";
import { validateManifestV2 } from "../../../../src/extensions/manifest";
import { tools } from "./index";
import {
  draftPost,
  revisePost,
  finalizePost,
  _setLlmForTests,
  _resetLlmForTests,
} from "./lib/pipeline";
import { _setInvokeForTests } from "./lib/invoke-helpers";
import { _setStoreForTests, SCRATCH_KEY, type Scratch } from "./lib/scratch";
import { WRITER_PROMPT, ILLUSTRATOR_PROMPT, MAX_REVISE_ROUNDS } from "./lib/prompts";

// ── seams ───────────────────────────────────────────────────────

const tcr = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  isError,
});

const summaryReply = (title: string, summary: string) =>
  tcr(JSON.stringify({ summaries: [{ url: "u", title, summary }] }));

function fakeInvoke(opts: {
  summary?: { title: string; summary: string };
  summaryError?: string;
  image?: string;
  imageError?: boolean;
}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const fn = async <T>(tool: string, args: Record<string, unknown>): Promise<T> => {
    calls.push({ tool, args });
    if (tool === "substack-pilot__summarize_urls") {
      if (opts.summaryError) return tcr(opts.summaryError, true) as T;
      const s = opts.summary ?? { title: "Src", summary: "A factual summary." };
      return summaryReply(s.title, s.summary) as T;
    }
    if (tool === "openai-image-gen-2__generate") {
      if (opts.imageError) return tcr("rate limited", true) as T;
      return tcr(opts.image ?? "![cover](/api/ext-files/openai-image-gen-2/g/x.png)") as T;
    }
    throw new Error(`unexpected invoke: ${tool}`);
  };
  return { fn, calls };
}

function fakeLlm(drafts: string[], imagePrompt = "A vivid metaphor scene") {
  const queue = [...drafts];
  return {
    complete: async (o: { systemPrompt?: string }) => {
      if (o.systemPrompt === ILLUSTRATOR_PROMPT) return { content: imagePrompt };
      if (o.systemPrompt === WRITER_PROMPT) {
        return { content: queue.shift() ?? "# Fallback\n\nBody." };
      }
      throw new Error(`unexpected systemPrompt: ${o.systemPrompt?.slice(0, 20)}`);
    },
  };
}

/** In-memory conversation store implementing the scratch StoreLike. */
function fakeStore(seed?: Scratch) {
  const map = new Map<string, unknown>();
  if (seed) map.set(SCRATCH_KEY, seed);
  return {
    map,
    store: {
      get: async <T>(k: string) => {
        const has = map.has(k);
        return { value: (has ? (map.get(k) as T) : null), exists: has };
      },
      set: async (k: string, v: unknown) => {
        map.set(k, v);
        return { ok: true as const, sizeBytes: 0 };
      },
      delete: async (k: string) => {
        const had = map.has(k);
        map.delete(k);
        return { deleted: had };
      },
    },
  };
}

afterEach(() => {
  _setInvokeForTests(null);
  _resetLlmForTests();
  _setStoreForTests(null);
});

// ── manifest ────────────────────────────────────────────────────

describe("substack-pipeline — manifest shape", () => {
  test("required fields", () => {
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.name).toBe("substack-pipeline");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.author.name).toBe("EZCorp");
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest.entrypoint).toBe("./index.ts");
  });

  test("declares the 3 pipeline tools", () => {
    const names = (manifest.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      "draft_substack_post",
      "finalize_substack_post",
      "revise_substack_post",
    ]);
  });

  test("bundles the skill via a file ref", () => {
    expect(manifest.skills?.[0]?.files).toEqual([
      "skills/substack-pipeline/SKILL.md",
    ]);
  });

  test("deps are the two non-requiresUserInput cross-ext targets (NOT ask-user)", () => {
    const deps = manifest.dependencies ?? {};
    expect(Object.keys(deps).sort()).toEqual([
      "openai-image-gen-2",
      "substack-pilot",
    ]);
    expect(deps).not.toHaveProperty("ask-user");
  });

  test("requests storage; not network/shell/env", () => {
    const p = manifest.permissions as Record<string, unknown>;
    expect(p.storage).toBe(true);
    expect(p.network).toBeUndefined();
    expect(p.shell).toBeUndefined();
    expect(p.env).toBeUndefined();
  });

  test("validateManifestV2 accepts the manifest", () => {
    const r = validateManifestV2(manifest);
    if (!r.valid) throw new Error(`rejected:\n  ${r.errors.join("\n  ")}`);
    expect(r.valid).toBe(true);
  });

  test("dispatcher registers the 3 tools", () => {
    expect(Object.keys(tools).sort()).toEqual([
      "draft_substack_post",
      "finalize_substack_post",
      "revise_substack_post",
    ]);
  });
});

// ── draft_substack_post ─────────────────────────────────────────

describe("draft_substack_post", () => {
  test("summarize → write → persists scratch, returns draft", async () => {
    const inv = fakeInvoke({});
    _setInvokeForTests(inv.fn);
    _setLlmForTests(fakeLlm(["# My Post\n\nGreat body."]));
    const fs = fakeStore();
    _setStoreForTests(fs.store);

    const res = await draftPost({ url: "https://x.com/a", styleNote: "punchy" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("# My Post");
    expect(res.content[0].text).toContain("ask_user_question");
    expect(inv.calls.map((c) => c.tool)).toEqual(["substack-pilot__summarize_urls"]);
    const scratch = fs.map.get(SCRATCH_KEY) as Scratch;
    expect(scratch.draft).toContain("# My Post");
    expect(scratch.styleNote).toBe("punchy");
    expect(scratch.rounds).toBe(0);
  });

  test("rejects non-http url before any invoke", async () => {
    const inv = fakeInvoke({});
    _setInvokeForTests(inv.fn);
    _setStoreForTests(fakeStore().store);
    const res = await draftPost({ url: "ftp://nope" });
    expect(res.isError).toBe(true);
    expect(inv.calls).toHaveLength(0);
  });

  test("summarize failure → toolError, no writer/scratch", async () => {
    const inv = fakeInvoke({ summaryError: "HTTP 404" });
    _setInvokeForTests(inv.fn);
    let llmCalled = false;
    _setLlmForTests({
      complete: async () => {
        llmCalled = true;
        return { content: "x" };
      },
    });
    const fs = fakeStore();
    _setStoreForTests(fs.store);
    const res = await draftPost({ url: "https://x.com/a" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("HTTP 404");
    expect(llmCalled).toBe(false);
    expect(fs.map.has(SCRATCH_KEY)).toBe(false);
  });
});

// ── revise_substack_post ────────────────────────────────────────

const seed: Scratch = {
  url: "https://x.com/a",
  sourceTitle: "Src",
  summary: "A factual summary.",
  draft: "# V1\n\nLong draft.",
  rounds: 0,
};

describe("revise_substack_post", () => {
  test("rewrites from scratch + feedback, bumps rounds", async () => {
    _setInvokeForTests(fakeInvoke({}).fn);
    _setLlmForTests(fakeLlm(["# V2\n\nShort draft."]));
    const fs = fakeStore({ ...seed });
    _setStoreForTests(fs.store);

    const res = await revisePost({ feedback: "make it shorter" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("# V2");
    const scratch = fs.map.get(SCRATCH_KEY) as Scratch;
    expect(scratch.draft).toContain("# V2");
    expect(scratch.rounds).toBe(1);
  });

  test("missing scratch → NO_SCRATCH error", async () => {
    _setLlmForTests(fakeLlm(["x"]));
    _setStoreForTests(fakeStore().store);
    const res = await revisePost({ feedback: "change" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("draft_substack_post first");
  });

  test("empty feedback → toolError", async () => {
    _setStoreForTests(fakeStore({ ...seed }).store);
    const res = await revisePost({ feedback: "   " });
    expect(res.isError).toBe(true);
  });

  test("emits cap reminder at the revise-round limit", async () => {
    _setLlmForTests(fakeLlm(["# Vn\n\nb"]));
    _setStoreForTests(
      fakeStore({ ...seed, rounds: MAX_REVISE_ROUNDS - 1 }).store,
    );
    const res = await revisePost({ feedback: "tweak" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain(`${MAX_REVISE_ROUNDS}`);
    expect(res.content[0].text).toContain("finalize_substack_post");
  });
});

// ── finalize_substack_post ──────────────────────────────────────

describe("finalize_substack_post", () => {
  test("illustrator → image, returns article + image, clears scratch", async () => {
    const inv = fakeInvoke({});
    _setInvokeForTests(inv.fn);
    _setLlmForTests(fakeLlm([]));
    const fs = fakeStore({ ...seed, draft: "# Final\n\nBody." });
    _setStoreForTests(fs.store);

    const res = await finalizePost();

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("![cover](/api/ext-files/openai-image-gen-2/g/x.png)");
    expect(res.content[0].text).toContain("# Final");
    expect(res.content[0].text).not.toContain("Pipeline notes");
    expect(inv.calls.map((c) => c.tool)).toEqual(["openai-image-gen-2__generate"]);
    expect(fs.map.has(SCRATCH_KEY)).toBe(false);
  });

  test("missing scratch → NO_SCRATCH error", async () => {
    _setStoreForTests(fakeStore().store);
    const res = await finalizePost();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("draft_substack_post first");
  });

  test("image failure → article + note, no image markdown, scratch cleared", async () => {
    const inv = fakeInvoke({ imageError: true });
    _setInvokeForTests(inv.fn);
    _setLlmForTests(fakeLlm([]));
    const fs = fakeStore({ ...seed, draft: "# Post\n\nBody." });
    _setStoreForTests(fs.store);

    const res = await finalizePost();

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("# Post");
    expect(res.content[0].text).toContain("Cover image failed");
    expect(res.content[0].text).not.toContain("![");
    expect(fs.map.has(SCRATCH_KEY)).toBe(false);
  });
});
