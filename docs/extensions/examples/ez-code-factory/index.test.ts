import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetChannelForTests,
  __resetPagesForTests,
  getChannel,
} from "@ezcorp/sdk/runtime";
import type { HostChannel } from "@ezcorp/sdk/runtime";
import {
  initGateTool,
  handlePushReceived,
  renderDashboard,
  register,
  start,
  tools,
  PUSH_RECEIVED_ACTION,
  _setProjectRootForTests,
  _setShellForTests,
  _setStoreForTests,
  _setPushPageForTests,
  _setTmpBaseForTests,
  _setBaseUrlForTests,
} from "./index";
import { gateDir as gateDirFor, GATE_REMOTE } from "./lib/gate";
import { productionHostRunner, type ShellRunner } from "./lib/shell";
import type { RunRecord, RunStore, StepResultRecord } from "./lib/runs";

// ── in-memory store + fakes ─────────────────────────────────────────

function memStore(): RunStore & { runs: Map<string, RunRecord> } {
  const runs = new Map<string, RunRecord>();
  const steps = new Map<string, StepResultRecord>();
  return {
    runs,
    async createRun(run) {
      runs.set(run.id, run);
    },
    async getRun(id) {
      return runs.get(id) ?? null;
    },
    async updateRun(id, patch) {
      const cur = runs.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
      runs.set(id, next);
      return next;
    },
    async listRuns() {
      return [...runs.values()];
    },
    async putStepResult(step) {
      steps.set(`${step.runId}/${step.step}`, step);
    },
    async getStepResult(runId, step) {
      return steps.get(`${runId}/${step}`) ?? null;
    },
  };
}

/** A git runner that succeeds for every command (worktree ops as no-ops). */
const okShell: ShellRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });

const VALID_PUSH = {
  repoId: "0123456789ab",
  branch: "feat/x",
  ref: "refs/heads/feat/x",
  newSha: "abcdef1234567890abcdef1234567890abcdef12",
};

afterEach(() => {
  _setProjectRootForTests(null);
  _setShellForTests(null);
  _setStoreForTests(null);
  _setPushPageForTests(null);
  _setTmpBaseForTests(null);
  _setBaseUrlForTests(null);
});

// ── init_gate tool ──────────────────────────────────────────────────

describe("initGateTool", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ezcf-idx-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("errors when no active project is set", async () => {
    _setProjectRootForTests(() => undefined);
    const res = await initGateTool({});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("EZCORP_PROJECT_ROOT unset");
  });

  test("provisions the gate on a real repo and returns structured JSON", async () => {
    const work = join(root, "work");
    mkdirSync(work);
    await productionHostRunner(["git", "init", "-b", "main"], work);
    await productionHostRunner(["git", "remote", "add", "origin", "https://up/x.git"], work);
    _setProjectRootForTests(() => work);
    _setShellForTests(productionHostRunner);
    _setBaseUrlForTests(() => "http://127.0.0.1:9");

    const res = await initGateTool({ upstream: "  " }); // blank upstream ignored
    expect(res.isError).toBe(false);
    const out = JSON.parse(res.content[0]!.text);
    expect(out.ok).toBe(true);
    expect(out.gateRemote).toBe(GATE_REMOTE);
    expect(out.pushHint).toBe(`git push ${GATE_REMOTE} <branch>`);
    expect(existsSync(gateDirFor(work, out.repoId))).toBe(true);
  });

  test("surfaces an init failure as a tool error", async () => {
    _setProjectRootForTests(() => "/proj");
    _setShellForTests(async (cmd) =>
      cmd.join(" ").includes("git init --bare")
        ? { exitCode: 1, stdout: "", stderr: "denied" }
        : { exitCode: 1, stdout: "", stderr: "" },
    );
    const res = await initGateTool({});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("init_gate failed");
  });
});

// ── push-received action ────────────────────────────────────────────

describe("handlePushReceived", () => {
  test("ignores the event when no active project is set", async () => {
    _setProjectRootForTests(() => undefined);
    const store = memStore();
    _setStoreForTests(store);
    await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
    expect(store.runs.size).toBe(0);
  });

  test("ignores an invalid (attacker-shaped) payload", async () => {
    _setProjectRootForTests(() => "/proj");
    const store = memStore();
    _setStoreForTests(store);
    await handlePushReceived({
      source: "hub",
      pageId: "dashboard",
      userId: "u",
      payload: { branch: "a;rm -rf", repoId: "x" },
    });
    expect(store.runs.size).toBe(0);
  });

  test("valid push → run lifecycle + dashboard refresh", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    _setShellForTests(okShell);
    const store = memStore();
    _setStoreForTests(store);
    const pushes: string[] = [];
    _setPushPageForTests((pageId) => pushes.push(pageId));

    await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });

    expect(store.runs.size).toBe(1);
    const run = [...store.runs.values()][0]!;
    expect(run.status).toBe("completed");
    expect(run.repoId).toBe(VALID_PUSH.repoId);
    // Dashboard was refreshed at least once via the content-free page push.
    expect(pushes).toContain("dashboard");
  });

  test("a failed run lifecycle is reported (run marked failed)", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    // worktree add fails → the run fails.
    _setShellForTests(async (cmd) =>
      cmd.includes("add") ? { exitCode: 1, stdout: "", stderr: "no such rev" } : { exitCode: 0, stdout: "", stderr: "" },
    );
    const store = memStore();
    _setStoreForTests(store);
    _setPushPageForTests(() => {});

    await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
    const run = [...store.runs.values()][0]!;
    expect(run.status).toBe("failed");
  });

  test("a throw escaping runGateLifecycle (teardown) is caught + logged, not swallowed", async () => {
    _setProjectRootForTests(() => "/proj");
    _setTmpBaseForTests(() => "/tmp/ext");
    // worktree add succeeds, but teardown (`worktree remove`) THROWS — that
    // escapes runGateLifecycle's own catch (it fires in the finally) and would
    // be swallowed by the channel's notification path without this handler's
    // outer guard.
    _setShellForTests(async (cmd) => {
      if (cmd.includes("worktree") && cmd.includes("remove")) throw new Error("teardown boom");
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    _setStoreForTests(memStore());
    _setPushPageForTests(() => {});
    const stderr: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
      stderr.push(String(s));
      return true;
    }) as typeof process.stderr.write);
    try {
      await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
      expect(stderr.join("")).toContain("push-received handler error");
    } finally {
      spy.mockRestore();
    }
  });
});

// ── production env defaults (no test overrides) ─────────────────────

describe("production env defaults", () => {
  test("the default seams read process.env (set + unset)", async () => {
    const saved = {
      root: process.env.EZCORP_PROJECT_ROOT,
      base: process.env.EZCORP_BASE_URL,
      tmp: process.env.TMPDIR,
    };
    try {
      // Reset every seam to its PRODUCTION default closure (not a test double).
      _setProjectRootForTests(null);
      _setBaseUrlForTests(null);
      _setTmpBaseForTests(null);
      _setShellForTests(okShell); // every git step a no-op success
      const store = memStore();
      _setStoreForTests(store);
      _setPushPageForTests(() => {});

      // UNSET → defaultProjectRoot() returns undefined → the tool errors out.
      delete process.env.EZCORP_PROJECT_ROOT;
      const err = await initGateTool({});
      expect(err.isError).toBe(true);
      expect(err.content[0]!.text).toContain("EZCORP_PROJECT_ROOT unset");

      // SET → defaultProjectRoot + defaultBaseUrl are both read through initGate.
      process.env.EZCORP_PROJECT_ROOT = "/proj";
      process.env.EZCORP_BASE_URL = "http://127.0.0.1:9";
      const ok = await initGateTool({});
      expect(ok.isError).toBe(false);

      // defaultTmpBase is read through the push-received lifecycle.
      process.env.TMPDIR = "/tmp/ezcf-env-default";
      await handlePushReceived({ source: "hub", pageId: "dashboard", userId: "u", payload: VALID_PUSH });
      expect(store.runs.size).toBeGreaterThan(0);
    } finally {
      // Restore the ambient env so sibling tests see the original values.
      const restore: Record<string, string | undefined> = {
        EZCORP_PROJECT_ROOT: saved.root,
        EZCORP_BASE_URL: saved.base,
        TMPDIR: saved.tmp,
      };
      for (const [k, v] of Object.entries(restore)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// ── renderDashboard ─────────────────────────────────────────────────

describe("renderDashboard", () => {
  test("reads through the store into a page tree", async () => {
    const store = memStore();
    await store.createRun({
      id: "r1",
      repoId: "0123456789ab",
      branch: "feat/x",
      ref: "refs/heads/feat/x",
      headSha: "abcdef0123456789",
      status: "completed",
      worktreePath: null,
      createdAt: "2026-07-15T08:00:00.000Z",
      updatedAt: "2026-07-15T08:00:00.000Z",
      parkedMs: 0,
      awaitingAgentSince: null,
    });
    _setStoreForTests(store);
    const tree = await renderDashboard();
    expect(tree.title).toBe("ez-code-factory");
    const nodes = tree.nodes as Array<Record<string, unknown>>;
    expect(nodes.some((n) => n.type === "table")).toBe(true);
  });

  test("lazily builds the production store when none is injected", async () => {
    _setStoreForTests(null);
    __resetChannelForTests();
    const ch = getChannel() as HostChannel;
    spyOn(ch, "request").mockImplementation((async () => ({ value: null, exists: false })) as HostChannel["request"]);
    try {
      const tree = await renderDashboard(); // exercises getStore() lazy init
      expect(tree.title).toBe("ez-code-factory");
    } finally {
      __resetChannelForTests();
    }
  });
});

// ── register / start wiring ─────────────────────────────────────────

describe("register / start", () => {
  beforeEach(() => {
    __resetChannelForTests();
    __resetPagesForTests();
  });
  afterEach(() => {
    __resetChannelForTests();
    __resetPagesForTests();
  });

  test("register wires the page render, the push-received action, and the tool dispatcher", () => {
    const ch = getChannel() as HostChannel;
    const methods = new Set<string>();
    const original = ch.onRequest.bind(ch);
    ch.onRequest = (method: string, handler: (p: unknown) => unknown) => {
      methods.add(method);
      return original(method, handler);
    };
    try {
      expect(() => register()).not.toThrow();
      expect(methods.has("ezcorp/page.render")).toBe(true);
      expect(methods.has(`ezcorp/event/${PUSH_RECEIVED_ACTION}`)).toBe(true);
      expect(methods.has("tools/call")).toBe(true);
      expect(Object.keys(tools)).toEqual(["init_gate"]);
    } finally {
      ch.onRequest = original;
    }
  });

  test("start registers and boots the channel", () => {
    const ch = getChannel() as HostChannel;
    let started = 0;
    const spy = spyOn(ch, "start");
    spy.mockImplementation((() => {
      started++;
    }) as HostChannel["start"]);
    try {
      expect(() => start()).not.toThrow();
      expect(started).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
