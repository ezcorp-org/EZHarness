#!/usr/bin/env bun
// ping-loop — a watchable, deterministic, LLM-free Loop SDK demo.
//
// The simplest possible thing a human can fire live and SEE working: a
// MANUAL-trigger loop with a Hub dashboard. Click "Ping now" on the page and
// the loop fires — appending a fresh "done" run row (a monotonic seq + a
// `pong #<seq>` message). There is NO LLM call, NO chat, and NO network, so
// every fire is fully reproducible.
//
// Determinism (project lesson — ids/time are ALWAYS injected): `act` NEVER
// calls `Date.now()` / `Math.random()` / `new Date()`. The sequence number
// arrives in `ctx.input.seq` (the dashboard's page-action handler computes
// it from the current run count), and the timestamp is the one the primitive
// injects via `ctx.fire.firedAt`. This keeps the loop flake-free + unit-
// testable without a live channel.
//
// The whole loop is ONE declarative `defineLoop` — the primitive owns
// settings resolution, the run record + retention, fire logging, the
// artifact write, AND the dashboard (render + push-on-change). The author
// writes only `act` (what to do), a small `contract`, and the page `render`.
//
// See docs/extensions/loops.md for the full reference.

import {
  createLoopRunStore,
  createToolDispatcher,
  defineLoop,
  getChannel,
  getLoopTools,
  PageBuilder,
  type ActResult,
  type LoopActContext,
  type LoopRunState,
  type PageActionEvent,
} from "@ezcorp/sdk/runtime";

/** Loop id — namespaces the run store (`loop:ping:run:<id>`, …) and the
 *  artifact dir (`.ezcorp/extension-data/ping/`). */
export const LOOP_ID = "ping";
/** Hub page id — MUST equal `manifest.pages[0].id` (the BARE id, not an
 *  `<ext>:`-prefixed one). The loop registers its dashboard under this value
 *  (`definePage({ id: PAGE_ID })`), and the host resolves the Hub tab
 *  `ext:ping-loop:dashboard` to this bare id when it pulls `ezcorp/page.render`
 *  — so a prefixed value here would register a page the host never looks up
 *  ("Unknown page" → the dashboard fails to render). `LOOP_ID` ("ping", the
 *  storage namespace) is independent of this. */
export const PAGE_ID = "dashboard";
/** Page-action event the "Ping now" button dispatches. A Hub page-action
 *  event MUST be `${manifest.name}:<suffix>` — the EXTENSION name ("ping-loop"),
 *  ONE colon, then a colon-free suffix. The Hub dispatcher
 *  (`web/src/lib/hub.ts` buildActionRequest) strips the `ping-loop:` prefix and
 *  rejects (drops the click client-side, no network call) any event that
 *  doesn't start with it or whose suffix contains a further colon. So this is
 *  the EXTENSION name, NOT `LOOP_ID` ("ping"). Must also be in
 *  `permissions.eventSubscriptions`. Reused as the `rowActions` key + the
 *  trigger `pageAction`, so this single constant keeps all three in sync. */
export const PING_EVENT = "ping-loop:run";
/** Manual-trigger tool name the loop registers; the page-action handler
 *  fires it to run the loop. */
export const PING_TOOL = "ping_run";

/** The terminal outcome of a ping run. Exported so the test asserts its
 *  exact shape. */
export interface PingOutcome {
  /** Monotonic sequence number (injected via `ctx.input.seq`, 0-based). */
  seq: number;
  /** The timestamp the primitive injected for this fire (`ctx.fire.firedAt`). */
  firedAt: string;
  /** Human-readable ping line shown on the dashboard + mirrored to a file. */
  message: string;
}

/** The triggering input — the page-action handler / tool passes the seq to
 *  run at; everything else is injected by the primitive. */
export interface PingInput {
  seq?: number;
}

/**
 * The loop body — deterministic + LLM-free. Exported so the unit test can
 * drive it with a hand-built `ctx` (no live channel). It maps the injected
 * seq + fire timestamp to a terminal "done" outcome, or skips when disabled.
 *
 * CRITICAL: this reads `seq` ONLY from `ctx.input` and the timestamp ONLY
 * from `ctx.fire.firedAt` — never the wall clock or a random source — so the
 * suite is order-independent and flake-free.
 */
export async function pingAct(
  ctx: LoopActContext<PingInput>,
): Promise<ActResult<PingOutcome>> {
  if (ctx.settings.enabled === false) {
    return { kind: "skip", reason: "settings_disabled" };
  }
  // Normalize the injected seq to a non-negative integer (the page-action
  // handler always supplies one; default to 0 for a bare manual fire).
  const raw = ctx.input.seq;
  const seq = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  const firedAt = ctx.fire.firedAt;
  ctx.log(`ping #${seq}`);
  return {
    kind: "terminal",
    status: "done",
    outcome: { seq, firedAt, message: `pong #${seq}` },
  };
}

/**
 * Build the dashboard tree from the current run list. Pure + exported so the
 * test asserts the button's action event + the table rows directly. Renders:
 *   - a "Ping now" button whose action event is `ping-loop:run` (fires the loop),
 *   - a table of run rows (id / status / message).
 */
export function renderPingDashboard(
  runs: LoopRunState<PingOutcome>[],
): PageBuilder {
  const page = new PageBuilder("Ping Loop")
    .markdownBlock(
      "A deterministic, LLM-free Loop SDK demo. Click **Ping now** to fire " +
        "the loop — each fire appends a `done` run row below.",
    )
    .stats([{ label: "Total pings", value: String(runs.length) }])
    .button("Ping now", { event: PING_EVENT }, "primary");

  if (runs.length === 0) {
    page.emptyState("No pings yet", "Click 'Ping now' to fire the loop.");
    return page;
  }

  page.table(
    ["Run", "Status", "Message"],
    runs.map((r) => ({
      cells: [
        r.id.slice(0, 8),
        r.status,
        r.outcome ? r.outcome.message : "—",
      ],
    })),
  );
  return page;
}

/**
 * The `ping-loop:run` page-action handler. Computes the next seq from the current
 * run count (deterministic given the store state — no clock/random), then
 * fires the loop via its manual-trigger tool. Exported so the test drives it
 * against a stubbed tool map. Fail-soft: a missing tool handler (loop not
 * yet registered) is a no-op rather than a throw into the host.
 */
export async function firePing(_event: PageActionEvent): Promise<void> {
  const tools = getLoopTools();
  const fire = tools[PING_TOOL];
  if (!fire) return;
  const runs = await listPingRuns();
  await fire({ seq: runs.length });
}

/**
 * Read the current ping run list (newest-first) for seq computation + tests.
 * Indirected through the registered loop's store so the page-action handler
 * never reaches into Storage directly. Returns `[]` when the loop isn't
 * registered yet.
 */
export async function listPingRuns(): Promise<LoopRunState<PingOutcome>[]> {
  return runListImpl();
}

/** The single copy of the loop contract — shared by `defineLoop` and the
 *  production run-store wiring so both read the same scope/retention. A
 *  dashboard REQUIRES `scope: "global"` (the Hub page is cross-user cached);
 *  `defineLoop` throws otherwise. */
const PING_CONTRACT = {
  states: ["done"],
  scope: "global",
  retention: { maxRuns: 50 },
} as const;

/** The run-list source `firePing` reads to compute the next seq. The default
 *  builds a GLOBAL-scoped run store over the same `loop:ping:*` keys the
 *  primitive writes (a stateless wrapper — no second copy of state). Tests
 *  override it so `firePing` runs without a live Storage channel. */
type RunLister = () => Promise<LoopRunState<PingOutcome>[]>;
const defaultRunLister: RunLister = () =>
  createLoopRunStore<PingOutcome>(LOOP_ID, PING_CONTRACT).list();
let runListImpl: RunLister = defaultRunLister;

/** @internal test-only — substitute the run-list source `firePing` reads. */
export function _setRunListerForTests(fn: RunLister | null): void {
  runListImpl = fn ?? defaultRunLister;
}

/**
 * Register the ping loop. Exported (not auto-run) so unit tests can register
 * it against a stubbed channel without `import.meta.main`. The manual trigger
 * declares BOTH a `tool` (what `firePing` invokes) and the `pageAction` (the
 * button's declarative intent); the dashboard's `rowActions` wires the
 * `ping-loop:run` event to `firePing`.
 */
export function definePingLoop(): void {
  defineLoop<PingInput, PingOutcome>({
    id: LOOP_ID,
    // Manual: the dashboard button (page action) fires the `ping_run` tool.
    trigger: { kind: "manual", tool: PING_TOOL, pageAction: PING_EVENT },
    contract: PING_CONTRACT,
    act: pingAct,
    log: {
      // Mirror each ping to a human-readable artifact (fail-soft; the durable
      // record lives in Storage, never the file).
      artifact: (run, outcome) => ({
        path: `pings/${run.id}.md`,
        body: `# Ping\n\n${outcome.message}\n\nfiredAt: ${outcome.firedAt}\n`,
      }),
      dashboard: {
        pageId: PAGE_ID,
        render: renderPingDashboard,
        rowActions: { [PING_EVENT]: firePing },
      },
    },
  });
}

/**
 * Production boot: register the loop, mount the tools/call plumbing (merging
 * the loop's manual tool via `getLoopTools()`), and start the channel's stdin
 * read loop. Exported (not inlined under `import.meta.main`) so a unit test
 * can drive the boot path against the SDK test channel — mirrors `start()` in
 * the sample-loop example.
 */
export function start(): void {
  definePingLoop();
  createToolDispatcher({ ...getLoopTools() });
  getChannel().start();
}

// Gated on `import.meta.main` so test imports don't open stdin.
if (import.meta.main) start();
