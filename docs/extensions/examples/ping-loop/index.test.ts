// ping-loop — unit tests for the watchable Loop SDK demo (pure pieces).
//
// Drives every exported pure function with hand-built inputs (no live
// channel):
//   - `pingAct` — the deterministic loop body (terminal outcome + skip path).
//   - `renderPingDashboard` — the Hub page tree (button action + table rows).
//   - `listPingRuns` / `_setRunListerForTests` — the run-list seam.
//   - `definePingLoop` — registers without throwing (ONCE; the registry is
//     module-global, so a second real registration would collide).
// `firePing`'s tool wiring + the default run-store lister + the production
// `start()` boot are covered against stubs in firing.test.ts / boot.test.ts.

import { test, expect, describe, afterEach } from "bun:test";
import type { LoopActContext, LoopRunState } from "@ezcorp/sdk/runtime";
import manifest from "./ezcorp.config";
import {
  definePingLoop,
  listPingRuns,
  pingAct,
  renderPingDashboard,
  PAGE_ID,
  PING_EVENT,
  PING_TOOL,
  _setRunListerForTests,
  type PingInput,
  type PingOutcome,
} from "./index";

function makeCtx(
  overrides: {
    seq?: number;
    firedAt?: string;
    settings?: Record<string, unknown>;
  } = {},
): LoopActContext<PingInput> & { _logged: string[] } {
  const logged: string[] = [];
  return {
    fire: {
      id: "fire-1",
      firedAt: overrides.firedAt ?? "2026-06-24T00:00:00.000Z",
      trigger: { kind: "manual", tool: PING_TOOL, pageAction: PING_EVENT },
      catchUp: false,
    },
    input: overrides.seq === undefined ? {} : { seq: overrides.seq },
    settings: overrides.settings ?? {},
    llm: { complete: async () => { throw new Error("llm not used"); } } as never,
    recentMessages: async () => [],
    formatMessages: () => "",
    spawn: (async () => { throw new Error("spawn not used"); }) as never,
    log: (msg: string) => logged.push(msg),
    _logged: logged,
  };
}

function makeRun(id: string, message: string, status = "done"): LoopRunState<PingOutcome> {
  return {
    id,
    loopId: "ping",
    scope: "global",
    status,
    events: [],
    outcome: { seq: 0, firedAt: "2026-06-24T00:00:00.000Z", message },
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  };
}

describe("pingAct", () => {
  test("injected seq + fire timestamp → terminal 'done' outcome", async () => {
    const result = await pingAct(makeCtx({ seq: 3, firedAt: "2026-06-24T12:00:00.000Z" }));
    expect(result).toEqual({
      kind: "terminal",
      status: "done",
      outcome: { seq: 3, firedAt: "2026-06-24T12:00:00.000Z", message: "pong #3" },
    });
  });

  test("appends a fire-log note (deterministic, from the injected seq)", async () => {
    const ctx = makeCtx({ seq: 7 });
    await pingAct(ctx);
    expect(ctx._logged).toEqual(["ping #7"]);
  });

  test("missing seq → defaults to 0 (bare manual fire)", async () => {
    const result = await pingAct(makeCtx());
    expect(result).toEqual({
      kind: "terminal",
      status: "done",
      outcome: { seq: 0, firedAt: "2026-06-24T00:00:00.000Z", message: "pong #0" },
    });
  });

  test("negative / non-finite / non-integer seq is normalized to a safe int", async () => {
    expect((await pingAct(makeCtx({ seq: -5 }))).outcome).toMatchObject({ seq: 0 });
    expect((await pingAct(makeCtx({ seq: 2.9 }))).outcome).toMatchObject({ seq: 2 });
    expect((await pingAct(makeCtx({ seq: Number.NaN }))).outcome).toMatchObject({ seq: 0 });
  });

  test("settings.enabled=false → skip (no outcome)", async () => {
    const result = await pingAct(makeCtx({ seq: 1, settings: { enabled: false } }));
    expect(result).toEqual({ kind: "skip", reason: "settings_disabled" });
  });
});

describe("renderPingDashboard", () => {
  test("empty run list → 'Ping now' button + empty state, zero stat", () => {
    const tree = renderPingDashboard([]).build();
    expect(tree.title).toBe("Ping Loop");
    // The button fires the page action that triggers the loop.
    const button = tree.nodes.find(
      (n): n is { type: string; label: string; action: { event: string } } =>
        (n as { type?: string }).type === "button",
    );
    expect(button?.label).toBe("Ping now");
    expect(button?.action.event).toBe(PING_EVENT);
    // No table when there are no runs; an empty-state node instead.
    expect(tree.nodes.some((n) => (n as { type?: string }).type === "table")).toBe(false);
    expect(tree.nodes.some((n) => (n as { type?: string }).type === "empty-state")).toBe(true);
    const stats = tree.nodes.find((n) => (n as { type?: string }).type === "stats") as
      | { items: { label: string; value: string }[] }
      | undefined;
    expect(stats?.items).toEqual([{ label: "Total pings", value: "0" }]);
  });

  test("non-empty run list → a table row per run (id / status / message)", () => {
    const runs = [makeRun("aaaaaaaa1111", "pong #1"), makeRun("bbbbbbbb2222", "pong #0")];
    const tree = renderPingDashboard(runs).build();
    const table = tree.nodes.find((n) => (n as { type?: string }).type === "table") as
      | { columns: string[]; rows: { cells: string[] }[] }
      | undefined;
    expect(table?.columns).toEqual(["Run", "Status", "Message"]);
    expect(table?.rows.map((r) => r.cells)).toEqual([
      ["aaaaaaaa", "done", "pong #1"],
      ["bbbbbbbb", "done", "pong #0"],
    ]);
    // Stats reflect the run count.
    const stats = tree.nodes.find((n) => (n as { type?: string }).type === "stats") as
      | { items: { value: string }[] }
      | undefined;
    expect(stats?.items[0]?.value).toBe("2");
  });

  test("run with no outcome renders a '—' message cell", () => {
    const run = makeRun("cccccccc3333", "ignored");
    delete (run as { outcome?: unknown }).outcome;
    const tree = renderPingDashboard([run]).build();
    const table = tree.nodes.find((n) => (n as { type?: string }).type === "table") as
      | { rows: { cells: string[] }[] }
      | undefined;
    expect(table?.rows[0]?.cells).toEqual(["cccccccc", "done", "—"]);
  });
});

describe("listPingRuns", () => {
  afterEach(() => {
    _setRunListerForTests(null);
  });

  test("delegates to the (overridable) run lister", async () => {
    const runs = [makeRun("r1", "pong #0")];
    _setRunListerForTests(async () => runs);
    expect(await listPingRuns()).toBe(runs);
  });
});

describe("definePingLoop", () => {
  test("registers without throwing (import.meta.main is false under test)", () => {
    expect(() => definePingLoop()).not.toThrow();
  });
});

describe("host-facing identifier contract", () => {
  // These assertions encode the invariants of the live dispatch chain so a
  // regression in any host-facing identifier is caught at unit time instead of
  // surfacing as a silently-dropped click / "Unknown page" in the running app.
  // Each ties a constant to the REAL manifest / render output, never a
  // duplicated literal, so the example and the host can't drift apart.

  test("PAGE_ID is a real manifest.pages[].id the host will render", () => {
    // The loop registers its dashboard under PAGE_ID, but the host pulls
    // `ezcorp/page.render` for the BARE manifest page id — a mismatch resolves
    // to "Unknown page" and the dashboard never renders.
    const declaredIds = (manifest.pages ?? []).map((p) => p.id);
    expect(declaredIds).toContain(PAGE_ID);
  });

  test("PING_EVENT is prefixed with the extension name (hub.ts dispatch rule)", () => {
    // web/src/lib/hub.ts buildActionRequest strips `${manifest.name}:` and
    // DROPS the click (no network call) if the event doesn't start with it.
    expect(PING_EVENT.startsWith(`${manifest.name}:`)).toBe(true);
  });

  test("PING_EVENT suffix is non-empty and colon-free (hub.ts second constraint)", () => {
    // After stripping the prefix, hub.ts rejects an empty suffix or one that
    // contains a further colon.
    const suffix = PING_EVENT.slice(manifest.name.length + 1);
    expect(suffix.length).toBeGreaterThan(0);
    expect(suffix.includes(":")).toBe(false);
  });

  test("PING_EVENT is declared in manifest.permissions.eventSubscriptions", () => {
    // The events route clamps an action to the manifest's eventSubscriptions;
    // an undeclared event is refused host-side.
    expect(manifest.permissions?.eventSubscriptions ?? []).toContain(PING_EVENT);
  });

  test("the rendered 'Ping now' button dispatches exactly PING_EVENT", () => {
    // The button the user clicks must carry PING_EVENT so the render and the
    // constant can't drift (the live click fires whatever the node declares).
    const tree = renderPingDashboard([]).build();
    const button = tree.nodes.find(
      (n): n is { type: string; label: string; action: { event: string } } =>
        (n as { type?: string }).type === "button",
    );
    expect(button?.label).toBe("Ping now");
    expect(button?.action.event).toBe(PING_EVENT);
  });
});
