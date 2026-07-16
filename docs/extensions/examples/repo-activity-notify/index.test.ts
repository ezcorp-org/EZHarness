// repo-activity-notify — unit tests for the check-stage trust probe.
//
// Drives the check + act bodies with hand-built contexts (an in-memory
// cursor, an injected git reader, an injected append RPC) so the logic is
// covered without a live channel. `parseGitHead` is exercised as a pure
// function; `readGitHead` runs against a REAL throwaway git repo (git is
// deterministic here). The full trigger → check → act → append/artifact path
// is covered by the real-subprocess integration test.

import { test, expect, describe, afterEach, beforeEach, spyOn } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  __resetChannelForTests,
  getChannel,
  type LoopActContext,
  type LoopCheckContext,
  type LoopMessage,
} from "@ezcorp/sdk/runtime";
import {
  parseGitHead,
  readGitHead,
  checkRepoActivity,
  notifyAct,
  defineRepoActivityNotifyLoop,
  _setGitHeadForTests,
  _setAppendMessageForTests,
  type GitHead,
  type NotifyInput,
} from "./index";
import config from "./ezcorp.config";

afterEach(() => {
  _setGitHeadForTests(null);
  _setAppendMessageForTests(null);
  __resetChannelForTests();
});

// ── makeCheckCtx / makeActCtx ───────────────────────────────────────

function makeCheckCtx(
  overrides: {
    settings?: Record<string, unknown>;
    cursor?: string;
    input?: NotifyInput;
  } = {},
): { ctx: LoopCheckContext<NotifyInput>; getCursor: () => unknown; logs: string[] } {
  let cursorValue: unknown = overrides.cursor;
  const logs: string[] = [];
  const ctx: LoopCheckContext<NotifyInput> = {
    input: overrides.input ?? ({} as NotifyInput),
    settings: overrides.settings ?? {},
    fire: {
      id: "fire-1",
      firedAt: "2026-07-16T00:00:00.000Z",
      trigger: { kind: "cron", cron: "0 * * * *" },
      catchUp: false,
    },
    cursor: {
      get: async <T,>() => cursorValue as T | undefined,
      set: async <T,>(v: T) => {
        cursorValue = v;
      },
    },
    fetch: (async () => new Response("")) as typeof fetch,
    log: (msg) => logs.push(msg),
  };
  return { ctx, getCursor: () => cursorValue, logs };
}

function makeActCtx(
  overrides: {
    input?: NotifyInput;
    settings?: Record<string, unknown>;
    messages?: LoopMessage[];
  } = {},
): { ctx: LoopActContext<NotifyInput>; logs: string[] } {
  const logs: string[] = [];
  const ctx: LoopActContext<NotifyInput> = {
    fire: {
      id: "fire-1",
      firedAt: "2026-07-16T00:00:00.000Z",
      trigger: { kind: "cron", cron: "0 * * * *" },
      catchUp: false,
    },
    input: overrides.input ?? { hash: "abcdef1234567890", subject: "fix: thing" },
    settings: overrides.settings ?? {},
    llm: {
      complete: async () => {
        throw new Error("llm not used by notify act");
      },
    } as never,
    recentMessages: async () => overrides.messages ?? [{ id: "m-last", role: "user", content: "hi" }],
    formatMessages: (m) => m.map((x) => `[${x.id}] ${x.role}: ${x.content}`).join("\n\n"),
    spawn: (async () => {
      throw new Error("spawn not used");
    }) as never,
    log: (msg) => logs.push(msg),
  };
  return { ctx, logs };
}

// ── parseGitHead (pure) ─────────────────────────────────────────────

describe("parseGitHead", () => {
  test("normal hash + subject", () => {
    expect(parseGitHead("deadbeef\0fix: the bug", 0)).toEqual({
      hash: "deadbeef",
      subject: "fix: the bug",
    });
  });
  test("non-zero exit → null", () => {
    expect(parseGitHead("whatever", 1)).toBeNull();
  });
  test("empty output → null", () => {
    expect(parseGitHead("   \n", 0)).toBeNull();
  });
  test("no NUL separator → whole line is the hash, empty subject", () => {
    expect(parseGitHead("cafebabe", 0)).toEqual({ hash: "cafebabe", subject: "" });
  });
  test("leading NUL (empty hash) → null", () => {
    expect(parseGitHead("\0orphan subject", 0)).toBeNull();
  });
});

// ── readGitHead (real throwaway repo) ───────────────────────────────

describe("readGitHead", () => {
  let repo: string;

  beforeEach(async () => {
    repo = join(tmpdir(), `ran-git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(repo, { recursive: true });
    const git = async (...args: string[]) => {
      const p = Bun.spawn(["git", "-C", repo, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
      await p.exited;
    };
    await git("init", "-q");
    await git("config", "user.email", "probe@example.test");
    await git("config", "user.name", "Probe");
    writeFileSync(join(repo, "a.txt"), "hello\n");
    await git("add", "a.txt");
    await git("commit", "-q", "-m", "feat: initial commit");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("reads HEAD hash + subject from a real repo", async () => {
    const head = await readGitHead(repo);
    expect(head).not.toBeNull();
    expect(head!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(head!.subject).toBe("feat: initial commit");
  });

  test("a non-repo path → null (git exits non-zero)", async () => {
    const missing = join(tmpdir(), `ran-nope-${Date.now()}`);
    expect(await readGitHead(missing)).toBeNull();
  });
});

// ── checkRepoActivity ───────────────────────────────────────────────

describe("checkRepoActivity", () => {
  test("settings.enabled=false → skip (git not read)", async () => {
    let called = false;
    _setGitHeadForTests(async () => {
      called = true;
      return { hash: "x", subject: "y" };
    });
    const { ctx } = makeCheckCtx({ settings: { enabled: false } });
    expect(await checkRepoActivity(ctx)).toEqual({ proceed: false, reason: "settings_disabled" });
    expect(called).toBe(false);
  });

  test("no git HEAD → skip (no_git_head)", async () => {
    _setGitHeadForTests(async () => null);
    const { ctx } = makeCheckCtx({ settings: { repoPath: "/tmp/whatever" } });
    expect(await checkRepoActivity(ctx)).toEqual({ proceed: false, reason: "no_git_head" });
  });

  test("cursor already at HEAD → skip (no_new_commits)", async () => {
    _setGitHeadForTests(async () => ({ hash: "same-hash", subject: "s" }));
    const { ctx, getCursor } = makeCheckCtx({ settings: { repoPath: "/r" }, cursor: "same-hash" });
    expect(await checkRepoActivity(ctx)).toEqual({ proceed: false, reason: "no_new_commits" });
    expect(getCursor()).toBe("same-hash"); // unchanged
  });

  test("first-ever commit → proceed + cursor set + enrichment (no previousHash)", async () => {
    _setGitHeadForTests(async () => ({ hash: "h1", subject: "feat: x" }));
    const { ctx, getCursor, logs } = makeCheckCtx({ settings: { repoPath: "/r" } });
    const result = await checkRepoActivity(ctx);
    expect(result).toEqual({ proceed: true, input: { hash: "h1", subject: "feat: x" } });
    expect(getCursor()).toBe("h1");
    expect(logs[0]).toContain("new commit h1");
  });

  test("new commit after a prior one → proceed carries previousHash", async () => {
    _setGitHeadForTests(async () => ({ hash: "h2", subject: "fix: y" }));
    const { ctx, getCursor } = makeCheckCtx({ settings: { repoPath: "/r" }, cursor: "h1" });
    const result = await checkRepoActivity(ctx);
    expect(result).toEqual({
      proceed: true,
      input: { hash: "h2", subject: "fix: y", previousHash: "h1" },
    });
    expect(getCursor()).toBe("h2");
  });

  test("blank repoPath falls back to the project root env", async () => {
    let seenPath: string | undefined;
    _setGitHeadForTests(async (p) => {
      seenPath = p;
      return null;
    });
    const prev = process.env.EZCORP_PROJECT_ROOT;
    process.env.EZCORP_PROJECT_ROOT = "/proj/root";
    try {
      const { ctx } = makeCheckCtx({ settings: {} });
      await checkRepoActivity(ctx);
      expect(seenPath).toBe("/proj/root");
    } finally {
      if (prev === undefined) delete process.env.EZCORP_PROJECT_ROOT;
      else process.env.EZCORP_PROJECT_ROOT = prev;
    }
  });
});

// ── notifyAct ───────────────────────────────────────────────────────

describe("notifyAct", () => {
  test("appends a one-line notice to the wired conversation", async () => {
    const appended: Record<string, unknown>[] = [];
    _setAppendMessageForTests(async (p) => {
      appended.push(p);
      return { messageId: "new-msg" };
    });
    const { ctx } = makeActCtx({
      input: { hash: "abcdef1234", subject: "feat: cool" },
      settings: { conversationId: "conv-1" },
      messages: [{ id: "m-parent", role: "assistant", content: "prior" }],
    });
    const result = await notifyAct(ctx);
    expect(result).toEqual({
      kind: "terminal",
      status: "done",
      outcome: {
        hash: "abcdef1234",
        subject: "feat: cool",
        notice: "repo-activity-notify: new commit abcdef12 — feat: cool",
        appended: true,
      },
    });
    expect(appended[0]).toMatchObject({
      conversationId: "conv-1",
      parentMessageId: "m-parent",
      role: "extension",
      content: "repo-activity-notify: new commit abcdef12 — feat: cool",
      excluded: true,
    });
  });

  test("no conversationId configured → artifact-only (not appended, warns)", async () => {
    let calls = 0;
    _setAppendMessageForTests(async () => {
      calls++;
      return {};
    });
    const { ctx, logs } = makeActCtx({ settings: {} });
    const result = (await notifyAct(ctx)) as { outcome: { appended: boolean } };
    expect(result.outcome.appended).toBe(false);
    expect(calls).toBe(0);
    expect(logs.join(" ")).toContain("no conversationId");
  });

  test("conversation with no anchorable message → artifact-only (warns)", async () => {
    let calls = 0;
    _setAppendMessageForTests(async () => {
      calls++;
      return {};
    });
    const { ctx, logs } = makeActCtx({ settings: { conversationId: "conv-1" }, messages: [] });
    const result = (await notifyAct(ctx)) as { outcome: { appended: boolean } };
    expect(result.outcome.appended).toBe(false);
    expect(calls).toBe(0);
    expect(logs.join(" ")).toContain("no message to anchor");
  });

  test("the default append path rides the ezcorp/append-message reverse RPC", async () => {
    // Do NOT inject the seam — exercise the real getChannel().request path.
    _setAppendMessageForTests(null);
    const ch = getChannel();
    const seen: { method: string; params: unknown }[] = [];
    spyOn(ch, "request").mockImplementation((async (method: string, params: unknown) => {
      seen.push({ method, params });
      return { messageId: "x" };
    }) as typeof ch.request);
    const { ctx } = makeActCtx({
      input: { hash: "0011223344", subject: "docs: note" },
      settings: { conversationId: "conv-9" },
      messages: [{ id: "m-a", role: "user", content: "q" }],
    });
    await notifyAct(ctx);
    expect(seen[0]!.method).toBe("ezcorp/append-message");
    expect(seen[0]!.params).toMatchObject({ conversationId: "conv-9", parentMessageId: "m-a" });
  });
});

// ── registration + manifest ─────────────────────────────────────────

describe("registration + manifest", () => {
  test("defineRepoActivityNotifyLoop registers without throwing", () => {
    expect(() => defineRepoActivityNotifyLoop()).not.toThrow();
  });

  test("manifest declares the read-only grants (no llm / no spawnAgents)", () => {
    expect(config.name).toBe("repo-activity-notify");
    expect(config.permissions?.shell).toBe(true);
    expect(config.permissions?.storage).toBe(true);
    expect(config.permissions?.schedule?.crons).toEqual(["0 * * * *"]);
    // The firewall shows up in the manifest too: no model, no agent spawn.
    expect((config.permissions as Record<string, unknown>).llm).toBeUndefined();
    expect((config.permissions as Record<string, unknown>).spawnAgents).toBeUndefined();
  });

  test("seam setters reset to defaults without throwing", () => {
    expect(() => {
      _setGitHeadForTests(null);
      _setAppendMessageForTests(null);
    }).not.toThrow();
  });

  test("GitHead type shape holds", () => {
    const h: GitHead = { hash: "a", subject: "b" };
    expect(h.hash).toBe("a");
  });
});
