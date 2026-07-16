// docs-updater — full-flow integration against the REAL loop primitive.
//
// Drives the REAL `defineLoop` facade (check → deferred act → onComplete →
// approve/decline resolution + the LOCKED approval-label store) end-to-end,
// with only the leaf side effects injected:
//   - REAL `git` against a throwaway repo (the check cursor path);
//   - an in-memory Storage KV (faithful to the host storage RPC contract) —
//     the run store, cursor, and label store live here;
//   - an injected spawn (the coding agent is not really dispatched);
//   - an injected `gh` shell (NO real GitHub calls — deterministic + offline);
//   - a spying LoopEvents (observe the approval nudges without a channel).
//
// It proves the flagship wiring the unit tests exercise in isolation actually
// composes on the primitive: a manual fire drafts + parks a proposal; a
// dashboard Approve row action resolves it through `approveRun` and writes the
// approval label with the HOST-STAMPED `decidedBy` (`event.userId`); Decline
// closes the PR + writes a `declined` label; and a lost finalize closure
// (a restart) surfaces `verifyManually` with NO double action + NO label.
//
// The loop-primitive test seams are imported by RELATIVE path (they are not on
// the `@ezcorp/sdk/runtime` public barrel) — the same resolved module the
// example's `@ezcorp/sdk/runtime` import binds, so the injected singletons are
// the ones the fire path reads.

import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  createLoopRunStore,
  getLoopTools,
  LoopEvents,
  type StorageScope,
} from "@ezcorp/sdk/runtime";
import type { spawnAssignment } from "../../../../packages/@ezcorp/sdk/src/runtime/spawn";
import {
  __resetLoopsForTests,
  _setStoreFactoryForTests,
  _setSpawnForTests,
  _setLoopEventsForTests,
  _setSettingsResolverForTests,
  _setProposalClosuresForTests,
  dispatchAssignmentUpdate,
} from "../../../../packages/@ezcorp/sdk/src/runtime/loop";
import { __resetChannelForTests } from "../../../../packages/@ezcorp/sdk/src/runtime/channel";
import {
  defineDocsUpdaterLoop,
  handleApproveAction,
  handleDeclineAction,
  _setShellForTests,
  _setProjectRootForTests,
  type ShellResult,
} from "./index";
import type { LoopApprovalLabel, LoopRunState } from "../../../../packages/@ezcorp/sdk/src/runtime/loop-types";

// ── in-memory Storage (mirrors the host storage RPC contract) ───────

function makeMemStorage() {
  const kv = new Map<string, unknown>();
  const storage = {
    async get<T = unknown>(key: string) {
      return kv.has(key)
        ? { value: kv.get(key) as T, exists: true }
        : { value: null as T | null, exists: false };
    },
    async set<T = unknown>(key: string, value: T) {
      kv.set(key, JSON.parse(JSON.stringify(value)));
      return { ok: true as const, sizeBytes: 0 };
    },
    async delete(key: string) {
      return { deleted: kv.delete(key) };
    },
    async list(opts?: { prefix?: string }) {
      const p = opts?.prefix ?? "";
      return { keys: [...kv.keys()].filter((k) => k.startsWith(p)) };
    },
  };
  return { kv, storage };
}

// ── fake gh shell (offline, deterministic) ──────────────────────────

const IN_SCOPE_DIFF: ShellResult = { exitCode: 0, stdout: "README.md\ndocs/x.md\n", stderr: "" };
const OPEN_MERGEABLE: ShellResult = { exitCode: 0, stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE" }), stderr: "" };

let ghCalls: string[][] = [];
function fakeGh() {
  _setShellForTests(async (cmd) => {
    ghCalls.push(cmd);
    const sub = cmd.slice(1, 3).join(" ");
    if (sub === "pr diff") return IN_SCOPE_DIFF;
    if (sub === "pr view") return OPEN_MERGEABLE;
    return { exitCode: 0, stdout: "", stderr: "" };
  });
}

// ── harness ─────────────────────────────────────────────────────────

let repo: string;
let kv: Map<string, unknown>;
let events: { pending: unknown[]; resolved: unknown[] };
let spawnCount = 0;

async function git(...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  await p.exited;
}
async function commit(file: string, msg: string): Promise<void> {
  const abs = join(repo, file);
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, `${msg}\n`);
  await git("add", file);
  await git("commit", "-q", "-m", msg);
}

beforeEach(async () => {
  __resetLoopsForTests();
  spawnCount = 0;
  ghCalls = [];
  repo = join(tmpdir(), `du-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(repo, { recursive: true });
  await git("init", "-q");
  await git("config", "user.email", "probe@example.test");
  await git("config", "user.name", "Probe");
  await commit("README.md", "feat: initial");

  const mem = makeMemStorage();
  kv = mem.kv;
  events = { pending: [], resolved: [] };

  _setStoreFactoryForTests(<O,>(loopId: string, contract: unknown) =>
    createLoopRunStore<O>(loopId, contract as never, (_scope: StorageScope) => mem.storage),
  );
  _setSpawnForTests((async () => {
    spawnCount += 1;
    const n = spawnCount;
    return { subConversationId: `sub-${n}`, agentRunId: `agent-run-${n}`, taskId: `task-${n}`, assignmentId: `assign-${n}` };
  }) as typeof spawnAssignment);
  _setLoopEventsForTests({
    emitApprovalPending: async (p: unknown) => { events.pending.push(p); },
    emitApprovalResolved: async (p: unknown) => { events.resolved.push(p); },
    emitAutoDisabled: async () => {},
  } as unknown as LoopEvents);
  _setSettingsResolverForTests(async () => ({
    enabled: true,
    repo_path: repo,
    agent_name: "coder",
    write_paths: "README.md,docs/",
    auto_merge: false,
  }));
  _setProjectRootForTests(() => repo);
  fakeGh();
  defineDocsUpdaterLoop();
});

afterEach(() => {
  __resetLoopsForTests();
  _setStoreFactoryForTests(null);
  _setSpawnForTests(null);
  _setLoopEventsForTests(null);
  _setSettingsResolverForTests(null);
  _setProposalClosuresForTests("docs-updater", "*", null);
  _setShellForTests(null);
  _setProjectRootForTests(null);
  __resetChannelForTests();
  rmSync(repo, { recursive: true, force: true });
});

/** Fire the manual tool once and return the reported run id. */
async function fireManual(): Promise<string> {
  const handler = getLoopTools().run_docs_update!;
  const res = await handler({}, undefined);
  const text = (res as { content?: { text?: string }[] }).content?.[0]?.text ?? "{}";
  return (JSON.parse(text) as { runId: string }).runId;
}

/** Deliver the deferred agent's completion for a run. */
async function complete(runId: string, resultPreview: string): Promise<void> {
  const n = runId.split("-").pop();
  await dispatchAssignmentUpdate({
    taskId: `task-${n}`,
    assignment: { id: `assign-${n}`, agentRunId: runId, status: "completed", resultPreview },
  } as never);
}

function runOf(runId: string): LoopRunState | undefined {
  return kv.get(`loop:docs-updater:run:${runId}`) as LoopRunState | undefined;
}
function labels(): LoopApprovalLabel[] {
  return (kv.get("loop:docs-updater:labels") as LoopApprovalLabel[] | undefined) ?? [];
}

// ── the flow ────────────────────────────────────────────────────────

describe("docs-updater full flow (real primitive + real git + fake gh)", () => {
  test("manual fire → check advances cursor → deferred draft run", async () => {
    const runId = await fireManual();
    expect(runId).toBe("agent-run-1");
    expect(runOf(runId)?.status).toBe("drafting");
    // The cursor advanced to HEAD (at-most-once).
    const cursor = kv.get("loop:docs-updater:cursor") as string | undefined;
    expect(cursor).toMatch(/^[0-9a-f]{40}$/);
  });

  test("no new commits → the check declines (no draft)", async () => {
    await fireManual(); // advances the cursor to HEAD
    const handler = getLoopTools().run_docs_update!;
    const res = await handler({}, undefined);
    const body = JSON.parse((res as { content?: { text?: string }[] }).content?.[0]?.text ?? "{}");
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("no_new_commits");
  });

  test("approve → PR marked ready + label with HOST-STAMPED decidedBy", async () => {
    const runId = await fireManual();
    await complete(runId, "Opened https://github.com/o/r/pull/9");

    // Parked awaiting approval, proposal carries the PR ref; pending nudge emitted.
    expect(runOf(runId)?.status).toBe("awaiting_approval");
    expect(runOf(runId)?.proposal?.ref).toBe("https://github.com/o/r/pull/9");
    expect(events.pending.length).toBe(1);

    // Dashboard Approve row action — `userId` is the HOST-STAMPED identity.
    await handleApproveAction({ source: "hub", pageId: "dashboard", userId: "user-42", payload: { runId } });

    const run = runOf(runId)!;
    expect(run.status).toBe("approved");
    expect((run.outcome as { marked?: string }).marked).toBe("ready");
    // The LOCKED eval-signal label captured the decision + the host-stamped user.
    const ls = labels();
    expect(ls.length).toBe(1);
    expect(ls[0]).toMatchObject({ decision: "approved", decidedBy: "user-42", loopConfigVersion: "1" });
    expect(events.resolved.length).toBe(1);
    // gh marked the PR (comment + ready) but NEVER merged (/repo posture: repo endsWith not /repo here, but auto_merge is off).
    const subs = ghCalls.map((c) => c.slice(1, 3).join(" "));
    expect(subs).toContain("pr comment");
    expect(subs).toContain("pr ready");
    expect(subs).not.toContain("pr merge");
  });

  test("decline → PR closed + declined label with decidedBy + note", async () => {
    const r1 = await fireManual();
    await complete(r1, "Opened https://github.com/o/r/pull/9");
    await handleApproveAction({ source: "hub", pageId: "dashboard", userId: "user-1", payload: { runId: r1 } });

    // A NEW commit so the next check proceeds; draft + park a second run.
    await commit("docs/new.md", "docs: add a page");
    const r2 = await fireManual();
    expect(r2).toBe("agent-run-2");
    await complete(r2, "Opened https://github.com/o/r/pull/10");
    expect(runOf(r2)?.status).toBe("awaiting_approval");

    ghCalls = [];
    await handleDeclineAction({ source: "hub", pageId: "dashboard", userId: "user-99", payload: { runId: r2, note: "not needed" } });

    expect(runOf(r2)?.status).toBe("declined");
    const ls = labels();
    expect(ls.length).toBe(2);
    expect(ls[1]).toMatchObject({ decision: "declined", decidedBy: "user-99", note: "not needed" });
    expect(ghCalls.map((c) => c.slice(1, 3).join(" "))).toContain("pr close");
  });

  test("lost finalize closure (restart) → verifyManually, NO double action, NO label", async () => {
    const runId = await fireManual();
    await complete(runId, "Opened https://github.com/o/r/pull/9");
    expect(runOf(runId)?.status).toBe("awaiting_approval");

    // Simulate a subprocess restart: the in-memory finalize closure is gone,
    // but the parked run survives in Storage.
    _setProposalClosuresForTests("docs-updater", runId, null);
    ghCalls = [];

    await handleApproveAction({ source: "hub", pageId: "dashboard", userId: "user-42", payload: { runId } });

    const run = runOf(runId)!;
    // Never re-invokes finalize: stays parked + flagged for manual verification.
    expect(run.verifyManually).toBe(true);
    expect(run.status).toBe("awaiting_approval");
    // No label appended (the decision could not be safely finalized), no gh.
    expect(labels().length).toBe(0);
    expect(ghCalls.length).toBe(0);
  });
});
