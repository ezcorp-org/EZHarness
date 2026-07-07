/**
 * REAL-runtime wiring contract for the spawn bridge (spawn.ts).
 *
 * WHY THIS FILE EXISTS (audit gap HIGH-6): every other spawn test INJECTS
 * `deps.runtime`, so the production `resolveRuntime()` path (spawn.ts:261, used
 * at :316 as `deps.runtime ?? resolveRuntime()`) is NEVER executed. That path
 * is the ONLY place spawn.ts reaches the live executor + bus:
 *
 *     const { executor, bus } = getBriefingRuntime();
 *     return { streamChat: executor.streamChat.bind(executor), on: bus.on.bind(bus) };
 *
 * The whole object is returned `as SpawnRuntime` — a CAST that hides any drift
 * between the real `AgentExecutor.streamChat` / `EventBus` surfaces and the
 * `SpawnRuntime` shape spawn.ts consumes. An executor-signature change, a wrong
 * `.bind`, or a bus event-name rename would therefore ship green under the
 * injected-deps tests. This file closes that gap by driving `approveProposal`
 * WITHOUT `deps.runtime`, against a REAL `EventBus<AgentEvents>` registered
 * through the REAL runtime registry — mocking only the true external
 * boundaries (the DB query layer + the GitHub progress side-effects). The
 * executor's `streamChat` body is a stub (that IS the network/LLM boundary),
 * but the RESOLUTION + binding + event wiring are all real.
 *
 * What each assertion proves:
 *   - `resolveRuntime()` actually runs (it is exercised, not injected/faked);
 *   - it binds `executor.streamChat` to the executor (`this` === executor),
 *     so a rename of the bound property or a lost `.bind` breaks the test;
 *   - spawn passes the run through with the resolved conversationId + runId;
 *   - firing the REAL `run:complete`/`run:error`/`run:cancel` events on the
 *     REAL bus (typed against `AgentEvents`, the same contract the executor
 *     emits against) drives the proposal to its terminal status — proving the
 *     `bus.on` binding + the event NAMES spawn subscribes to match the names
 *     the executor emits (an event-name drift silently stops transitions);
 *   - the not-registered branch throws loudly (never a silent dropped spawn).
 */
import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "../../../__tests__/helpers/mock-cleanup";
import { EventBus } from "../../../runtime/events";
import {
  registerBriefingRuntime,
  getBriefingRuntime,
  _resetBriefingRuntimeForTests,
  type BriefingExecutor,
} from "../../../runtime/briefing/runtime-registry";
import type { AgentEvents, AgentRun } from "../../../types";
// NOTE: `../../../extensions/bundled` is imported DYNAMICALLY inside its test —
// a static import would pull in the real logger before installMocks() runs and
// defeat the logger stub (mock.module materialization is order-sensitive).

afterAll(() => {
  _resetBriefingRuntimeForTests();
  restoreModuleMocks();
});

// ── Mock ONLY the external boundaries — NOT the runtime registry / event bus ──

let getProposalByIdMock = mock((_id: string) => Promise.resolve<unknown>(null));
let getProposalByRunIdMock = mock((_rid: string) => Promise.resolve<unknown>(null));
let getLinkByIdMock = mock((_id: string) => Promise.resolve<unknown>(null));
let countActiveMock = mock((_pid: string) => Promise.resolve(0));
let updateProposalMock = mock((id: string, patch: Record<string, unknown>) =>
  Promise.resolve<unknown>({ id, ...patch }),
);
let claimProposalMock = mock(
  (id: string, _from: readonly string[], patch: Record<string, unknown>) =>
    Promise.resolve<unknown>({ ...makeProposal({ id }), ...patch }),
);
let createConversationMock = mock((_pid: string, _opts: unknown) =>
  Promise.resolve<{ id: string }>({ id: "conv-1" }),
);
let createMessageMock = mock((_cid: string, _data: Record<string, unknown>) =>
  Promise.resolve<{ id: string }>({ id: "msg-seed" }),
);
let getExtensionByNameMock = mock((_n: string) => Promise.resolve<unknown>(null));
let getAgentConfigByNameMock = mock((_n: string) => Promise.resolve<unknown>(undefined));
let postTicketCommentMock = mock((_l: unknown, _p: unknown, _b: string) => Promise.resolve(true));
let moveCardOnDoneMock = mock((_l: unknown, _p: unknown, _c: unknown) => Promise.resolve(false));

function installMocks(): void {
  mock.module("../../../db/queries/github-projects", () => ({
    getProposalById: (id: string) => getProposalByIdMock(id),
    getProposalByRunId: (rid: string) => getProposalByRunIdMock(rid),
    getLinkById: (id: string) => getLinkByIdMock(id),
    countActiveProposalsForProject: (pid: string) => countActiveMock(pid),
    updateProposal: (id: string, patch: Record<string, unknown>) => updateProposalMock(id, patch),
    claimProposal: (id: string, from: readonly string[], patch: Record<string, unknown>) =>
      claimProposalMock(id, from, patch),
    insertProposalIfNew: () => Promise.resolve(null),
    listEnabledLinks: () => Promise.resolve([]),
    updateLinkPollState: () => Promise.resolve(),
  }));
  mock.module("../../../db/queries/conversations", () => ({
    createConversation: (pid: string, opts: unknown) => createConversationMock(pid, opts),
    createMessage: (cid: string, data: Record<string, unknown>) => createMessageMock(cid, data),
  }));
  mock.module("../../../db/queries/conversation-extensions", () => ({
    addConversationExtensions: () => Promise.resolve(),
  }));
  mock.module("../../../db/queries/extensions", () => ({
    getExtensionByName: (n: string) => getExtensionByNameMock(n),
  }));
  mock.module("../../../db/queries/agent-configs", () => ({
    getAgentConfigByName: (n: string) => getAgentConfigByNameMock(n),
  }));
  mock.module("../../../logger", () => {
    const stub = { info() {}, warn() {}, error() {}, debug() {} };
    return { logger: { child: () => stub }, extensionLogger: () => stub };
  });
  mock.module("../progress", () => ({
    postTicketComment: (l: unknown, p: unknown, b: string) => postTicketCommentMock(l, p, b),
    moveCardOnDone: (l: unknown, p: unknown, c: unknown) => moveCardOnDoneMock(l, p, c),
    buildStartComment: () => "🤖 started",
    buildDoneComment: () => "✅ done",
    buildFailedComment: () => "❌ failed",
    extractPrUrl: () => null,
    summarize: () => "",
  }));
  // NOTE: `../../../runtime/briefing/runtime-registry` and `../../../runtime/events`
  // are deliberately NOT mocked — spawn.ts's resolveRuntime() must read the REAL
  // registry singleton (the same instance this test registers into) and bind the
  // REAL bus, or the whole point of this file is lost.
}

installMocks();
const { approveProposal } = await import("../spawn");

// ── Fixtures ──────────────────────────────────────────────────────────────

type Proposal = {
  id: string;
  linkId: string;
  projectId: string;
  statusOptionId: string;
  action: "plan" | "execute";
  title: string;
  ticketUrl: string | null;
  status: string;
  contentNodeId: string | null;
};

function makeProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "prop-1",
    linkId: "link-1",
    projectId: "proj-REAL",
    statusOptionId: "opt-doing",
    action: "plan",
    title: "Fix the bug",
    ticketUrl: "https://github.com/acme/repo/issues/1",
    status: "pending",
    contentNodeId: "I_1",
    ...over,
  };
}

function makeLink() {
  return {
    id: "link-1",
    projectId: "proj-REAL",
    defaultModel: null,
    defaultPermissionMode: null,
    columnActionMap: { "opt-doing": { action: "plan", autoSpawn: false } },
  };
}

/** A real EventBus + a stub executor whose `streamChat` records `this` (so we
 *  can prove `resolveRuntime()` bound it) and returns a real-shaped AgentRun. */
function makeRealRuntime() {
  const bus = new EventBus<AgentEvents>();
  const streamChatCalls: Array<{
    thisArg: unknown;
    conversationId: string;
    userMessage: string;
    options: Record<string, unknown>;
  }> = [];
  const executor = {
    async streamChat(
      conversationId: string,
      userMessage: string,
      options: Record<string, unknown>,
    ): Promise<AgentRun> {
      streamChatCalls.push({ thisArg: this, conversationId, userMessage, options });
      return {
        id: (options.runId as string) ?? "run-x",
        agentName: "chat",
        status: "success",
        startedAt: Date.now(),
        logs: [],
      } as AgentRun;
    },
    cancelRun() {
      return true;
    },
  };
  registerBriefingRuntime({ executor: executor as unknown as BriefingExecutor, bus });
  return { bus, executor, streamChatCalls };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  _resetBriefingRuntimeForTests();
  getProposalByIdMock = mock((id: string) => Promise.resolve(makeProposal({ id })));
  getProposalByRunIdMock = mock((_rid: string) => Promise.resolve(makeProposal({ id: "prop-1" })));
  getLinkByIdMock = mock((_id: string) => Promise.resolve(makeLink()));
  countActiveMock = mock((_pid: string) => Promise.resolve(0));
  updateProposalMock = mock((id: string, patch: Record<string, unknown>) =>
    Promise.resolve({ id, ...patch }),
  );
  claimProposalMock = mock(
    (id: string, _from: readonly string[], patch: Record<string, unknown>) =>
      Promise.resolve<unknown>({ ...makeProposal({ id }), ...patch }),
  );
  createConversationMock = mock((_pid: string, _opts: unknown) => Promise.resolve({ id: "conv-1" }));
  createMessageMock = mock((_cid: string, _data: Record<string, unknown>) =>
    Promise.resolve({ id: "msg-seed" }),
  );
  getExtensionByNameMock = mock((_n: string) => Promise.resolve<unknown>(null));
  getAgentConfigByNameMock = mock((_n: string) => Promise.resolve<unknown>(undefined));
  postTicketCommentMock = mock((_l: unknown, _p: unknown, _b: string) => Promise.resolve(true));
  moveCardOnDoneMock = mock((_l: unknown, _p: unknown, _c: unknown) => Promise.resolve(false));
  installMocks();
});

/** The status-carrying patch of the LAST claimProposal call (terminal writes). */
function lastClaimPatch(): Record<string, unknown> {
  return claimProposalMock.mock.calls.at(-1)![2] as Record<string, unknown>;
}

// ── resolveRuntime(): the executor + bus binding ────────────────────────────

describe("resolveRuntime() — real executor + bus wiring (no deps.runtime)", () => {
  test("approveProposal WITHOUT deps runs resolveRuntime() + streams through the bound executor", async () => {
    const { streamChatCalls, executor } = makeRealRuntime();
    // No third argument → deps = {} → `deps.runtime ?? resolveRuntime()` takes
    // the REAL path. If resolveRuntime threw or mis-bound streamChat, this rejects.
    const result = await approveProposal("prop-1", { kind: "auto" });
    expect((result as { status?: string }).status).toBe("running");

    // The resolved streamChat was invoked exactly once, through the real executor.
    expect(streamChatCalls).toHaveLength(1);
    const call = streamChatCalls[0]!;
    // `.bind(executor)` proof: `this` inside streamChat is the executor object.
    expect(call.thisArg).toBe(executor);
    // spawn routed the resolved conversation + a runId into the executor.
    expect(call.conversationId).toBe("conv-1");
    expect(typeof call.options.runId).toBe("string");
    expect(call.options.projectId).toBe("proj-REAL");
  });

  test("run:complete on the REAL bus (via resolveRuntime's bus.on) drives the proposal to done", async () => {
    const { bus, streamChatCalls } = makeRealRuntime();
    await approveProposal("prop-1", { kind: "auto" });
    const runId = streamChatCalls[0]!.options.runId as string;
    claimProposalMock.mockClear();

    // Emit the REAL lifecycle event, typed against AgentEvents (the same
    // contract the executor emits against). If spawn subscribed to a drifted
    // event name, this transition would never happen.
    bus.emit("run:complete", { run: { id: runId } as AgentRun });
    await tick();

    expect(getProposalByRunIdMock).toHaveBeenCalledWith(runId);
    const patch = lastClaimPatch();
    expect(patch.status).toBe("done");
    expect(patch.finishedAt).toBeInstanceOf(Date);
  });

  test("run:error on the REAL bus drives the proposal to failed", async () => {
    const { bus, streamChatCalls } = makeRealRuntime();
    await approveProposal("prop-1", { kind: "auto" });
    const runId = streamChatCalls[0]!.options.runId as string;
    claimProposalMock.mockClear();

    bus.emit("run:error", {
      run: { id: runId, result: { success: false, error: "boom" } } as AgentRun,
      error: "boom",
      runId,
    });
    await tick();

    expect(lastClaimPatch().status).toBe("failed");
  });

  test("run:cancel on the REAL bus drives the proposal to cancelled", async () => {
    const { bus, streamChatCalls } = makeRealRuntime();
    await approveProposal("prop-1", { kind: "auto" });
    const runId = streamChatCalls[0]!.options.runId as string;
    claimProposalMock.mockClear();

    bus.emit("run:cancel", { run: { id: runId } as AgentRun });
    await tick();

    expect(lastClaimPatch().status).toBe("cancelled");
  });

  test("an event for a DIFFERENT runId is ignored (correlation via the real bus)", async () => {
    const { bus } = makeRealRuntime();
    await approveProposal("prop-1", { kind: "auto" });
    claimProposalMock.mockClear();
    getProposalByRunIdMock.mockClear();

    bus.emit("run:complete", { run: { id: "some-other-run" } as AgentRun });
    await tick();

    expect(getProposalByRunIdMock).not.toHaveBeenCalled();
    expect(claimProposalMock).not.toHaveBeenCalled();
  });

  test("resolveRuntime() throws loudly when NO runtime is registered (fail-loud, no silent drop)", async () => {
    // The registry is empty (beforeEach reset it and this test registers nothing).
    expect(getBriefingRuntime()).toBeNull();
    await expect(approveProposal("prop-1", { kind: "auto" })).rejects.toThrow(
      /runtime \(executor \+ bus\) not registered/,
    );
  });
});

// ── Bundled ticket-tool extension name contract (spawn.ts wireGithubProjects) ─

describe("bundled github-projects extension contract (spawn.ts:512-541)", () => {
  test("the extension name spawn.ts wires ('github-projects') is a REAL bundled extension", async () => {
    // spawn.ts's GITHUB_PROJECTS_EXTENSION = "github-projects" is the name passed
    // to getExtensionByName + addConversationExtensions so the spawned run sees the
    // ticket tools. If the bundled entry is renamed, that wiring silently no-ops
    // (the run loses its ticket tools) — this pins the name so a rename is caught.
    const { isBundledExtensionName, getBundledExtensionPath } = await import(
      "../../../extensions/bundled"
    );
    expect(isBundledExtensionName("github-projects")).toBe(true);
    expect(getBundledExtensionPath("github-projects")).toBe(
      "docs/extensions/examples/github-projects",
    );
  });
});
