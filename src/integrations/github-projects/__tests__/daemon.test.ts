/**
 * Unit tests for GithubProjectsDaemon (daemon.ts).
 *
 * Everything below the daemon is mocked: the DB query layer, the host-only
 * secrets store (`getSecret`), the spawn bridge (`approveProposal`), and the
 * `gh auth token` shell. The GitHub client is INJECTED via daemon options, so
 * we never touch `client.ts` (Agent A) or a real network. Each test drives
 * `pollOnce()` directly.
 */
import { test, expect, describe, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "../../../__tests__/helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mock handles (re-pointed per test) ─────────────────────────────────────

let listEnabledLinksMock = mock(() => Promise.resolve<unknown[]>([]));
let insertProposalIfNewMock = mock((_input: unknown) => Promise.resolve<unknown>(null));
let updateLinkPollStateMock = mock((_id: string, _state: unknown) => Promise.resolve());
let getSecretMock = mock(
  (_extensionId: string, _projectId: string | null, _name: string) =>
    Promise.resolve<string | null>(null),
);
let approveProposalMock = mock((_id: string, _actor: unknown) => Promise.resolve<unknown>({}));

function installMocks(): void {
  // Export the FULL query surface (superset) so a sibling test file's
  // mock.module of the same module — materialized first in a shared `bun test
  // src/` run — can't freeze this module to a 3-export shape and break us.
  // (CI runs each spec in its own isolated shard, so this only matters locally.)
  mock.module("../../../db/queries/github-projects", () => ({
    listEnabledLinks: (...a: unknown[]) => listEnabledLinksMock(...(a as [])),
    insertProposalIfNew: (input: unknown) => insertProposalIfNewMock(input),
    updateLinkPollState: (id: string, state: unknown) => updateLinkPollStateMock(id, state),
    getProposalById: () => Promise.resolve(null),
    getProposalByRunId: () => Promise.resolve(null),
    getLinkById: () => Promise.resolve(null),
    countActiveProposalsForProject: () => Promise.resolve(0),
    updateProposal: () => Promise.resolve(null),
  }));
  mock.module("../../../extensions/secrets-store", () => ({
    getSecret: (extensionId: string, projectId: string | null, name: string) =>
      getSecretMock(extensionId, projectId, name),
  }));
  // NB: the auto-spawn bridge is injected via the daemon's `approve` option
  // (not mock.module) so this file never poisons `../spawn` for spawn.test.ts
  // (Bun mock.module materialization freeze across files in a shared run).
  // Logger — keep tests quiet; we don't assert on it here.
  mock.module("../../../logger", () => ({
    logger: { child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }));
}

// Imported AFTER the mocks are installed at module level.
installMocks();
const { GithubProjectsDaemon, getGithubProjectsDaemon, _resetGithubProjectsDaemonForTests } =
  await import("../daemon");
const {
  GithubAuthError,
  GithubNotFoundError,
  GithubRateLimitError,
} = await import("../types");

// ── Fixtures ────────────────────────────────────────────────────────────────

type Link = {
  id: string;
  projectId: string;
  boardNodeId: string;
  authMode: "pat" | "gh";
  columnActionMap: Record<string, { action: "plan" | "execute"; autoSpawn: boolean; permissionMode?: string; agentName?: string }>;
  pollCursor: Record<string, string> | null;
  pollIntervalSec: number;
  lastPolledAt: Date | null;
};

function makeLink(over: Partial<Link> = {}): Link {
  return {
    id: "link-1",
    projectId: "proj-1",
    boardNodeId: "PVT_board",
    authMode: "pat",
    columnActionMap: { "opt-doing": { action: "plan", autoSpawn: false } },
    pollCursor: null,
    pollIntervalSec: 60,
    lastPolledAt: null,
    ...over,
  };
}

function makeItem(over: Partial<{
  itemNodeId: string; contentNodeId: string | null; title: string; url: string | null;
  statusOptionId: string | null; statusName: string | null; updatedAt: string;
}> = {}) {
  return {
    itemNodeId: "item-1",
    contentNodeId: "content-1",
    title: "Fix the bug",
    url: "https://github.com/x/1",
    statusOptionId: "opt-doing",
    statusName: "Doing",
    updatedAt: "2026-06-01T00:00:00Z",
    ...over,
  };
}

/** A minimal injected client whose fetchBoardItems is a spy. */
function makeClient(page: { items: unknown[]; cursor: Record<string, string> } | (() => never)) {
  const fetchBoardItems = mock((_board: string, _auth: unknown, _cursor: unknown) =>
    typeof page === "function" ? page() : Promise.resolve(page),
  );
  return { fetchBoardItems } as never;
}

beforeEach(() => {
  listEnabledLinksMock = mock(() => Promise.resolve<unknown[]>([]));
  insertProposalIfNewMock = mock((_input: unknown) => Promise.resolve<unknown>(null));
  updateLinkPollStateMock = mock((_id: string, _state: unknown) => Promise.resolve());
  getSecretMock = mock(
    (_extensionId: string, _projectId: string | null, _name: string) =>
      Promise.resolve<string | null>("ghp_token"),
  );
  approveProposalMock = mock((_id: string, _actor: unknown) => Promise.resolve<unknown>({}));
  installMocks();
  _resetGithubProjectsDaemonForTests();
});

afterEach(() => {
  _resetGithubProjectsDaemonForTests();
});

// ── start()/stop() lifecycle ────────────────────────────────────────────────

describe("GithubProjectsDaemon.start/stop", () => {
  const PRIOR = process.env.EZCORP_DISABLE_GITHUB_PROJECTS_DAEMON;
  afterEach(() => {
    if (PRIOR === undefined) delete process.env.EZCORP_DISABLE_GITHUB_PROJECTS_DAEMON;
    else process.env.EZCORP_DISABLE_GITHUB_PROJECTS_DAEMON = PRIOR;
  });

  test("start() returns true, arms a timer, and is idempotent", () => {
    delete process.env.EZCORP_DISABLE_GITHUB_PROJECTS_DAEMON;
    const d = new GithubProjectsDaemon({ wakeIntervalMsOverride: 10_000 });
    expect(d.start()).toBe(true);
    // Second start() is a no-op that still returns true (timer already armed).
    expect(d.start()).toBe(true);
    d.stop();
  });

  test("start() honors the kill-switch (returns false, no timer)", () => {
    process.env.EZCORP_DISABLE_GITHUB_PROJECTS_DAEMON = "1";
    const d = new GithubProjectsDaemon();
    expect(d.start()).toBe(false);
    d.stop(); // safe even when never started
  });

  test("the wake-loop tick invokes pollOnce (swallows its rejection)", async () => {
    delete process.env.EZCORP_DISABLE_GITHUB_PROJECTS_DAEMON;
    listEnabledLinksMock = mock(() => Promise.reject(new Error("db down")));
    installMocks();
    let captured: (() => void) | undefined;
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((fn: () => void) => {
      captured = fn;
      return 0 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    try {
      const d = new GithubProjectsDaemon({ wakeIntervalMsOverride: 5 });
      d.start();
      expect(typeof captured).toBe("function");
      captured!(); // fire the tick — must not throw despite the rejected poll
      await Promise.resolve();
      d.stop();
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  test("getGithubProjectsDaemon returns a stable singleton; reset drops it", () => {
    const a = getGithubProjectsDaemon();
    const b = getGithubProjectsDaemon();
    expect(a).toBe(b);
    _resetGithubProjectsDaemonForTests();
    const c = getGithubProjectsDaemon();
    expect(c).not.toBe(a);
  });
});

// ── pollOnce: trigger detection + proposal creation ─────────────────────────

describe("GithubProjectsDaemon.pollOnce — triggers", () => {
  test("a card in a mapped column (first poll) creates a pending proposal", async () => {
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink()]));
    const created = { id: "prop-1" };
    insertProposalIfNewMock = mock(() => Promise.resolve(created));
    installMocks();

    const client = makeClient({ items: [makeItem()], cursor: { "item-1": "2026-06-01T00:00:00Z" } });
    const d = new GithubProjectsDaemon({ client });
    await d.pollOnce();

    expect(insertProposalIfNewMock).toHaveBeenCalledTimes(1);
    const arg = insertProposalIfNewMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.projectId).toBe("proj-1");
    expect(arg.itemNodeId).toBe("item-1");
    expect(arg.statusOptionId).toBe("opt-doing");
    expect(arg.action).toBe("plan");
    expect(arg.status).toBe("pending");
    expect(arg.dedupeKey).toBe("proj-1:item-1:opt-doing:plan");
    // autoSpawn=false → no spawn.
    expect(approveProposalMock).not.toHaveBeenCalled();
    // cursor advanced + error cleared.
    expect(updateLinkPollStateMock).toHaveBeenCalledTimes(1);
    const state = updateLinkPollStateMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(state.pollCursor).toEqual({ "item-1": "2026-06-01T00:00:00Z" });
    expect(state.lastError).toBeNull();
  });

  test("a card in an UNMAPPED column never triggers", async () => {
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink()]));
    installMocks();
    const client = makeClient({ items: [makeItem({ statusOptionId: "opt-todo" })], cursor: {} });
    const d = new GithubProjectsDaemon({ client });
    await d.pollOnce();
    expect(insertProposalIfNewMock).not.toHaveBeenCalled();
    // still advances the cursor (clean poll).
    expect(updateLinkPollStateMock).toHaveBeenCalledTimes(1);
  });

  test("a card with NO status set never triggers", async () => {
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink()]));
    installMocks();
    const client = makeClient({ items: [makeItem({ statusOptionId: null })], cursor: {} });
    const d = new GithubProjectsDaemon({ client });
    await d.pollOnce();
    expect(insertProposalIfNewMock).not.toHaveBeenCalled();
  });

  test("an unchanged card already past the cursor does NOT re-trigger", async () => {
    listEnabledLinksMock = mock(() =>
      Promise.resolve([makeLink({ pollCursor: { "item-1": "2026-06-01T00:00:00Z" } })]),
    );
    installMocks();
    const client = makeClient({
      items: [makeItem({ updatedAt: "2026-06-01T00:00:00Z" })],
      cursor: { "item-1": "2026-06-01T00:00:00Z" },
    });
    const d = new GithubProjectsDaemon({ client });
    await d.pollOnce();
    expect(insertProposalIfNewMock).not.toHaveBeenCalled();
  });

  test("a card whose updatedAt advanced past the cursor re-triggers", async () => {
    listEnabledLinksMock = mock(() =>
      Promise.resolve([makeLink({ pollCursor: { "item-1": "2026-06-01T00:00:00Z" } })]),
    );
    insertProposalIfNewMock = mock(() => Promise.resolve({ id: "prop-2" }));
    installMocks();
    const client = makeClient({
      items: [makeItem({ updatedAt: "2026-06-02T00:00:00Z" })],
      cursor: { "item-1": "2026-06-02T00:00:00Z" },
    });
    const d = new GithubProjectsDaemon({ client });
    await d.pollOnce();
    expect(insertProposalIfNewMock).toHaveBeenCalledTimes(1);
  });

  test("dedupe: insertProposalIfNew returning null → no spawn, no event", async () => {
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink({
      columnActionMap: { "opt-doing": { action: "plan", autoSpawn: true } },
    })]));
    insertProposalIfNewMock = mock(() => Promise.resolve(null)); // conflict
    const emit = mock(() => {});
    installMocks();
    const client = makeClient({ items: [makeItem()], cursor: {} });
    const d = new GithubProjectsDaemon({ client, emit, approve: approveProposalMock });
    await d.pollOnce();
    expect(insertProposalIfNewMock).toHaveBeenCalledTimes(1);
    expect(approveProposalMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled(); // nothing changed
  });

  test("autoSpawn=true → approveProposal({kind:'auto'}) on a NEW proposal + Hub event", async () => {
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink({
      columnActionMap: { "opt-doing": { action: "execute", autoSpawn: true } },
    })]));
    insertProposalIfNewMock = mock(() => Promise.resolve({ id: "prop-3" }));
    const emit = mock(() => {});
    installMocks();
    const client = makeClient({ items: [makeItem()], cursor: {} });
    const d = new GithubProjectsDaemon({ client, emit, approve: approveProposalMock });
    await d.pollOnce();
    expect(approveProposalMock).toHaveBeenCalledTimes(1);
    expect(approveProposalMock.mock.calls[0]![0]).toBe("prop-3");
    expect(approveProposalMock.mock.calls[0]![1]).toEqual({ kind: "auto" });
    expect(emit).toHaveBeenCalledTimes(1);
    const ev = emit.mock.calls[0]!;
    expect(ev[0]).toBe("github-projects:proposal-update");
    expect(ev[1]).toEqual({ projectId: "proj-1" });
  });

  test("autoSpawn failure is swallowed — the sweep still advances the cursor", async () => {
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink({
      columnActionMap: { "opt-doing": { action: "plan", autoSpawn: true } },
    })]));
    insertProposalIfNewMock = mock(() => Promise.resolve({ id: "prop-4" }));
    approveProposalMock = mock(() => Promise.reject(new Error("cap exceeded")));
    installMocks();
    const client = makeClient({ items: [makeItem()], cursor: { "item-1": "x" } });
    const d = new GithubProjectsDaemon({ client, approve: approveProposalMock });
    await d.pollOnce();
    expect(approveProposalMock).toHaveBeenCalledTimes(1);
    // The cursor still advances despite the spawn failure.
    expect(updateLinkPollStateMock).toHaveBeenCalledTimes(1);
  });

  test("autoSpawn with NO injected approve falls back to the real bridge (default path)", async () => {
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink({
      columnActionMap: { "opt-doing": { action: "plan", autoSpawn: true } },
    })]));
    insertProposalIfNewMock = mock(() => Promise.resolve({ id: "prop-5" }));
    installMocks();
    const client = makeClient({ items: [makeItem()], cursor: { "item-1": "x" } });
    // No `approve` option → `this.opts.approve ?? defaultApproveProposal` takes
    // the default branch. The real approveProposal throws (its query mock
    // returns null for the proposal lookup); the daemon must swallow it and
    // still advance the cursor.
    const d = new GithubProjectsDaemon({ client });
    await d.pollOnce();
    expect(updateLinkPollStateMock).toHaveBeenCalledTimes(1);
  });
});

// ── pollOnce: scheduling (due/interval) + reentrancy ────────────────────────

describe("GithubProjectsDaemon.pollOnce — scheduling", () => {
  test("a link not yet due (interval not elapsed) is skipped", async () => {
    const now = 1_000_000;
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink({
      lastPolledAt: new Date(now - 10_000), // 10s ago
      pollIntervalSec: 60, // needs 60s
    })]));
    installMocks();
    const client = makeClient({ items: [], cursor: {} });
    const d = new GithubProjectsDaemon({ client, now: () => now });
    await d.pollOnce();
    // Not due → never fetched, never persisted.
    expect((client as { fetchBoardItems: ReturnType<typeof mock> }).fetchBoardItems).not.toHaveBeenCalled();
    expect(updateLinkPollStateMock).not.toHaveBeenCalled();
  });

  test("a link past its interval IS polled", async () => {
    const now = 1_000_000;
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink({
      lastPolledAt: new Date(now - 120_000), // 120s ago
      pollIntervalSec: 60,
    })]));
    installMocks();
    const client = makeClient({ items: [], cursor: {} });
    const d = new GithubProjectsDaemon({ client, now: () => now });
    await d.pollOnce();
    expect((client as { fetchBoardItems: ReturnType<typeof mock> }).fetchBoardItems).toHaveBeenCalledTimes(1);
  });

  test("a re-entrant pollOnce (already ticking) returns immediately", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    listEnabledLinksMock = mock(async () => { await gate; return []; });
    installMocks();
    const d = new GithubProjectsDaemon({ client: makeClient({ items: [], cursor: {} }) });
    const first = d.pollOnce(); // starts, blocks on the gate
    await d.pollOnce(); // re-entrant guard → returns instantly
    expect(listEnabledLinksMock).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});

// ── pollOnce: auth resolution ───────────────────────────────────────────────

describe("GithubProjectsDaemon.pollOnce — auth", () => {
  test("PAT mode: getSecret produces the bearer", async () => {
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink({ authMode: "pat" })]));
    getSecretMock = mock(() => Promise.resolve<string | null>("ghp_secret"));
    installMocks();
    const client = makeClient({ items: [], cursor: {} });
    const d = new GithubProjectsDaemon({ client });
    await d.pollOnce();
    // Scope coordinates: (extensionId, projectId, name).
    expect(getSecretMock).toHaveBeenCalledWith("github-projects", "proj-1", "apiToken");
    const auth = (client as { fetchBoardItems: ReturnType<typeof mock> }).fetchBoardItems.mock.calls[0]![1] as { mode: string; token: string };
    expect(auth).toEqual({ mode: "pat", token: "ghp_secret" });
  });

  test("PAT mode: a null secret degrades the link (no fetch)", async () => {
    // getSecret returns null for a missing OR undecryptable secret — both
    // degrade the link exactly like a 401.
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink({ authMode: "pat" })]));
    getSecretMock = mock(() => Promise.resolve<string | null>(null));
    installMocks();
    const client = makeClient({ items: [], cursor: {} });
    const d = new GithubProjectsDaemon({ client });
    await d.pollOnce();
    expect((client as { fetchBoardItems: ReturnType<typeof mock> }).fetchBoardItems).not.toHaveBeenCalled();
    // degrade → lastError persisted.
    expect(updateLinkPollStateMock).toHaveBeenCalledTimes(1);
    const state = updateLinkPollStateMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(state.lastError).toContain("no PAT stored");
  });

  test("gh mode: the injected ghAuthToken resolver supplies the bearer", async () => {
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink({ authMode: "gh" })]));
    installMocks();
    const client = makeClient({ items: [], cursor: {} });
    const ghAuthToken = mock(() => Promise.resolve("  gho_token\n"));
    const d = new GithubProjectsDaemon({ client, ghAuthToken });
    await d.pollOnce();
    expect(ghAuthToken).toHaveBeenCalledTimes(1);
    const auth = (client as { fetchBoardItems: ReturnType<typeof mock> }).fetchBoardItems.mock.calls[0]![1] as { mode: string; token: string };
    expect(auth).toEqual({ mode: "gh", token: "gho_token" }); // trimmed
  });

  test("gh mode: an empty `gh auth token` output degrades the link", async () => {
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink({ authMode: "gh" })]));
    installMocks();
    const client = makeClient({ items: [], cursor: {} });
    const ghAuthToken = mock(() => Promise.resolve("   \n"));
    const d = new GithubProjectsDaemon({ client, ghAuthToken });
    await d.pollOnce();
    expect((client as { fetchBoardItems: ReturnType<typeof mock> }).fetchBoardItems).not.toHaveBeenCalled();
    const state = updateLinkPollStateMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(state.lastError).toContain("empty output");
  });
});

// ── pollOnce: error degradation + back-off ──────────────────────────────────

describe("GithubProjectsDaemon.pollOnce — degradation", () => {
  test("GithubAuthError degrades the link (lastError set), loop survives", async () => {
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink()]));
    installMocks();
    const client = makeClient(() => { throw new GithubAuthError("401 revoked"); });
    const d = new GithubProjectsDaemon({ client });
    await d.pollOnce();
    const state = updateLinkPollStateMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(state.lastError).toBe("401 revoked");
    expect(state.lastErrorAt).toBeInstanceOf(Date);
  });

  test("GithubNotFoundError degrades the link", async () => {
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink()]));
    installMocks();
    const client = makeClient(() => { throw new GithubNotFoundError("404 board gone"); });
    const d = new GithubProjectsDaemon({ client });
    await d.pollOnce();
    const state = updateLinkPollStateMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(state.lastError).toBe("404 board gone");
  });

  test("a non-GitHub (unexpected) error still degrades the link, never throws out", async () => {
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink()]));
    installMocks();
    const client = makeClient(() => { throw new Error("socket hang up"); });
    const d = new GithubProjectsDaemon({ client });
    await d.pollOnce(); // must resolve
    const state = updateLinkPollStateMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(state.lastError).toBe("socket hang up");
  });

  test("a non-Error throw is stringified into lastError", async () => {
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink()]));
    installMocks();
    const client = makeClient(() => { throw "plain string failure"; });
    const d = new GithubProjectsDaemon({ client });
    await d.pollOnce();
    const state = updateLinkPollStateMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(state.lastError).toBe("plain string failure");
  });

  test("GithubRateLimitError sets a back-off window; the next sweep skips the link", async () => {
    const now = 5_000_000;
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink()]));
    installMocks();
    const rl = new GithubRateLimitError("secondary rate limit");
    rl.retryAfterMs = 30_000;
    const client = makeClient(() => { throw rl; });
    const d = new GithubProjectsDaemon({ client, now: () => now });
    await d.pollOnce();
    const state = updateLinkPollStateMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(state.lastError).toBe("secondary rate limit");

    // Second sweep within the back-off window: link is skipped (no new fetch).
    const callsBefore = (client as { fetchBoardItems: ReturnType<typeof mock> }).fetchBoardItems.mock.calls.length;
    await d.pollOnce();
    const callsAfter = (client as { fetchBoardItems: ReturnType<typeof mock> }).fetchBoardItems.mock.calls.length;
    expect(callsAfter).toBe(callsBefore); // skipped — still backing off
  });

  test("rate-limit without retryAfterMs uses the default back-off floor", async () => {
    const now = 5_000_000;
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink()]));
    installMocks();
    const client = makeClient(() => { throw new GithubRateLimitError("limited"); });
    const d = new GithubProjectsDaemon({ client, now: () => now });
    await d.pollOnce();
    // Still backing off at now+1ms (default floor is 60s).
    const callsBefore = (client as { fetchBoardItems: ReturnType<typeof mock> }).fetchBoardItems.mock.calls.length;
    await d.pollOnce();
    expect((client as { fetchBoardItems: ReturnType<typeof mock> }).fetchBoardItems.mock.calls.length).toBe(callsBefore);
  });

  test("back-off expires: once the cool-down passes the link is polled again", async () => {
    let now = 5_000_000;
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink()]));
    installMocks();
    const rl = new GithubRateLimitError("limited");
    rl.retryAfterMs = 1_000;
    let throwIt = true;
    const fetchBoardItems = mock((_b: string, _a: unknown, _c: unknown) => {
      if (throwIt) { throwIt = false; throw rl; }
      return Promise.resolve({ items: [], cursor: {} });
    });
    const client = { fetchBoardItems } as never;
    const d = new GithubProjectsDaemon({ client, now: () => now });
    await d.pollOnce(); // rate-limited, back-off until now+1000
    now += 2_000; // advance past the cool-down
    await d.pollOnce(); // due again → fetch succeeds
    expect(fetchBoardItems).toHaveBeenCalledTimes(2);
  });

  test("a successful poll clears a prior rate-limit back-off", async () => {
    let now = 9_000_000;
    listEnabledLinksMock = mock(() => Promise.resolve([makeLink()]));
    installMocks();
    const rl = new GithubRateLimitError("limited");
    rl.retryAfterMs = 1_000;
    let phase = 0;
    const fetchBoardItems = mock(() => {
      phase += 1;
      if (phase === 1) throw rl;
      return Promise.resolve({ items: [], cursor: {} });
    });
    const d = new GithubProjectsDaemon({ client: { fetchBoardItems } as never, now: () => now });
    await d.pollOnce();           // rate-limited
    now += 2_000;
    await d.pollOnce();           // clean poll → clears back-off
    // A THIRD immediate poll is still due (back-off cleared, lastPolledAt is
    // not persisted in these mocks so isDue stays true) and fetches again.
    await d.pollOnce();
    expect(fetchBoardItems).toHaveBeenCalledTimes(3);
  });
});

// ── pollOnce: multi-link isolation ──────────────────────────────────────────

describe("GithubProjectsDaemon.pollOnce — isolation", () => {
  test("one failing link never starves the others", async () => {
    listEnabledLinksMock = mock(() =>
      Promise.resolve([
        makeLink({ id: "link-a", projectId: "proj-a" }),
        makeLink({ id: "link-b", projectId: "proj-b" }),
      ]),
    );
    insertProposalIfNewMock = mock(() => Promise.resolve({ id: "p" }));
    installMocks();
    // The client throws for link-a's board, succeeds for link-b. Both links
    // share boardNodeId in makeLink, so distinguish by call order.
    let call = 0;
    const fetchBoardItems = mock((_b: string, _a: unknown, _c: unknown) => {
      call += 1;
      if (call === 1) throw new GithubAuthError("link-a down");
      return Promise.resolve({ items: [makeItem()], cursor: { "item-1": "x" } });
    });
    const d = new GithubProjectsDaemon({ client: { fetchBoardItems } as never });
    await d.pollOnce();
    // Both links got a updateLinkPollState (a: degrade, b: cursor advance).
    expect(updateLinkPollStateMock).toHaveBeenCalledTimes(2);
    // link-b created its proposal.
    expect(insertProposalIfNewMock).toHaveBeenCalledTimes(1);
  });

  test("an empty enabled-link set is a clean no-op sweep", async () => {
    listEnabledLinksMock = mock(() => Promise.resolve([]));
    installMocks();
    const d = new GithubProjectsDaemon({ client: makeClient({ items: [], cursor: {} }) });
    await d.pollOnce();
    expect(updateLinkPollStateMock).not.toHaveBeenCalled();
  });
});
