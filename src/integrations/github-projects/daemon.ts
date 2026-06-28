/**
 * GitHub Projects poller daemon.  ──  OWNED BY AGENT B.
 *
 * A module-scoped singleton wired into `src/startup/background-timers.ts`,
 * modeled on the sibling host daemons (ScheduleDaemon / FileOrganizerDaemon):
 * a strict kill-switch env var (`EZCORP_DISABLE_GITHUB_PROJECTS_DAEMON`), a
 * timer guard so a re-invocation never double-arms the loop, and a
 * NON-REENTRANT, swallow-and-continue tick.
 *
 * Each `pollOnce()` sweep, for every ENABLED link (paused links aren't
 * returned by `listEnabledLinks`):
 *   - skip the link unless it is DUE (`now - lastPolledAt >= pollIntervalSec`)
 *     and not inside a rate-limit back-off window,
 *   - resolve host-only auth (read the stored PAT from the secrets store, or
 *     shell `gh auth token`),
 *   - `client.fetchBoardItems(boardNodeId, auth, pollCursor)`,
 *   - diff each item: it TRIGGERS when its current `statusOptionId` is a key in
 *     the link's `columnActionMap` AND it is newly in that state (first sight,
 *     or its `updatedAt` advanced past the stored cursor),
 *   - for each trigger, `insertProposalIfNew({...})` keyed on the server-derived
 *     `githubProposalDedupeKey` (ON CONFLICT DO NOTHING — the anti-double-spawn
 *     primitive). A non-null return is a genuinely NEW proposal; if that
 *     column's `autoSpawn` is true we `approveProposal(id, { kind: 'auto' })`,
 *     otherwise it stays `pending` for Hub approval,
 *   - advance + persist the merged cursor via `updateLinkPollState` and stamp
 *     `lastPolledAt`,
 *   - on GithubAuthError/GithubNotFoundError/GithubRateLimitError set
 *     `lastError`/`lastErrorAt` (DEGRADE this one link — never throw out of the
 *     loop and starve the others); back off on rate-limit.
 *   - emit `GITHUB_PROJECTS_EVENT` on the bus when proposals changed so the Hub
 *     refreshes.
 */
import { extensionLogger } from "../../logger";
import {
  listEnabledLinks,
  getLinkByProjectId,
  insertProposalIfNew,
  updateLinkPollState,
} from "../../db/queries/github-projects";
import { resolveLinkAuth } from "./auth";
import { getGithubProjectsEmit } from "./bus-registry";
import { createGithubClient } from "./client";
import { approveProposal as defaultApproveProposal, type ProposalActor } from "./spawn";
import {
  GithubAuthError,
  GithubNotFoundError,
  GithubRateLimitError,
  GITHUB_PROJECTS_EVENT,
  githubProposalDedupeKey,
  type GithubAuth,
  type GithubBoardItem,
  type GithubClient,
  type GithubColumnAction,
} from "./types";
import type { GithubProjectsLink } from "../../db/schema";

const log = extensionLogger("github-projects", "daemon");

const KILL_SWITCH = "EZCORP_DISABLE_GITHUB_PROJECTS_DAEMON";
/** How often the wake loop fires (each tick re-checks which links are due). */
const DEFAULT_WAKE_MS = 30_000;
/** Rate-limit back-off floor when the client doesn't supply `retryAfterMs`. */
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

/** Emit the Hub-refresh event. The web layer wires the real bus emitter. */
type EventEmitter = (
  event: typeof GITHUB_PROJECTS_EVENT,
  payload: { projectId: string },
) => void;

export interface GithubProjectsDaemonOptions {
  /** GitHub client (host-only). Defaults to the real `createGithubClient()`. */
  client?: GithubClient;
  /** Emit the Hub-refresh event. Defaults to a no-op (web layer wires the bus). */
  emit?: EventEmitter;
  /** `gh auth token` resolver (host shell). Injected so tests stay pure. */
  ghAuthToken?: () => Promise<string>;
  /** Auto-spawn bridge. Injected so tests don't have to mock the spawn module. */
  approve?: (proposalId: string, actor: ProposalActor) => Promise<unknown>;
  /** Now-injection for due-check + back-off math. */
  now?: () => number;
  /** Override the wake interval (ms). Tests pass small / 0. */
  wakeIntervalMsOverride?: number;
}

/** Per-link transient back-off state (rate-limit only; never persisted). */
interface BackoffState {
  /** Epoch ms before which the link is skipped (rate-limit cool-down). */
  until: number;
}

/** Per-link poll counters — aggregated by `pollOnce` into the one-line sweep
 *  summary, and echoed per link at debug. `due` flags whether the link was
 *  actually polled this sweep (vs skipped as not-due). */
interface LinkPollResult {
  due: boolean;
  fetched: number;
  triggers: number;
  newProposals: number;
  autoSpawned: number;
  degraded: boolean;
}

/** Zeroed result for a link that was skipped (not due). */
function skippedLinkResult(): LinkPollResult {
  return { due: false, fetched: 0, triggers: 0, newProposals: 0, autoSpawned: 0, degraded: false };
}

export class GithubProjectsDaemon {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly now: () => number;
  private readonly backoff = new Map<string, BackoffState>();
  private readonly opts: GithubProjectsDaemonOptions;

  constructor(opts: GithubProjectsDaemonOptions = {}) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  /** Lazily resolve the client so a missing-impl stub doesn't crash construction. */
  private getClient(): GithubClient {
    return this.opts.client ?? createGithubClient();
  }

  /** Start the wake loop. Returns false when refused (kill-switch). Idempotent. */
  start(): boolean {
    if (this.timer) return true;
    if (process.env[KILL_SWITCH] === "1") {
      log.info("github-projects daemon disabled via kill-switch");
      return false;
    }
    const intervalMs = this.opts.wakeIntervalMsOverride ?? DEFAULT_WAKE_MS;
    this.timer = setInterval(() => {
      void this.pollOnce().catch((err) =>
        log.warn("github-projects poll tick failed", { error: String(err) }),
      );
    }, intervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as unknown as { unref: () => void }).unref();
    }
    log.info("github-projects daemon wake loop armed", { wakeMs: intervalMs });
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Single poll sweep across all enabled links. Exposed for tests + the wake loop. */
  async pollOnce(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const links = await listEnabledLinks();
      let due = 0;
      let fetched = 0;
      let triggers = 0;
      let newProposals = 0;
      let autoSpawned = 0;
      let degraded = 0;
      for (const link of links) {
        // One link's failure must never starve the others.
        try {
          const r = await this.pollLink(link);
          if (r.due) due += 1;
          fetched += r.fetched;
          triggers += r.triggers;
          newProposals += r.newProposals;
          autoSpawned += r.autoSpawned;
          if (r.degraded) degraded += 1;
        } catch (err) {
          degraded += 1;
          log.warn("github-projects link poll failed", {
            linkId: link.id,
            error: String(err),
          });
        }
      }
      // One high-signal line per sweep (default-visible at LOG_LEVEL=info), but
      // only when there's at least one enabled link — an idle host with no
      // connected board stays quiet instead of logging every 30s.
      if (links.length > 0) {
        log.info("github-projects poll sweep", {
          enabledLinks: links.length,
          due,
          fetched,
          triggers,
          newProposals,
          autoSpawned,
          degraded,
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Poll a single link: due-check → fetch → diff → propose → persist. */
  private async pollLink(link: GithubProjectsLink): Promise<LinkPollResult> {
    const nowMs = this.now();
    if (!this.isDue(link, nowMs)) {
      log.debug("github-projects link skipped: not due", {
        linkId: link.id,
        projectId: link.projectId,
      });
      return skippedLinkResult();
    }
    return this.runPoll(link, nowMs);
  }

  /**
   * Force a single, immediate poll of ONE project's link from the Hub's
   * "Poll now" button — bypassing the due-check + back-off. Resolves the link
   * by projectId; refuses when there is no board (`no-board`) or the link is
   * paused (`paused` — the user must resume first; we never silently override
   * their pause). On success runs the full poll body against the link.
   */
  async pollProjectNow(projectId: string): Promise<{ polled: boolean; reason?: string }> {
    log.info("github-projects poll-now requested", { projectId });
    const link = await getLinkByProjectId(projectId);
    if (!link) {
      log.info("github-projects poll-now skipped", { projectId, reason: "no-board" });
      return { polled: false, reason: "no-board" };
    }
    if (!link.enabled) {
      log.info("github-projects poll-now skipped", { projectId, reason: "paused" });
      return { polled: false, reason: "paused" };
    }
    await this.runPoll(link, this.now());
    log.info("github-projects poll-now completed", { projectId, linkId: link.id });
    return { polled: true };
  }

  /**
   * The poll BODY (auth → fetch → diff → propose → persist → emit) for a single
   * link, with the due-check already passed (or bypassed by `pollProjectNow`).
   */
  private async runPoll(link: GithubProjectsLink, nowMs: number): Promise<LinkPollResult> {
    let auth: GithubAuth;
    try {
      auth = await this.resolveAuth(link);
    } catch (err) {
      // Auth resolution (missing/garbage PAT, gh shell failure) degrades the
      // link exactly like a 401 — surface it, don't crash the loop.
      await this.degrade(link, err, nowMs);
      return { due: true, fetched: 0, triggers: 0, newProposals: 0, autoSpawned: 0, degraded: true };
    }

    let page;
    try {
      page = await this.getClient().fetchBoardItems(
        link.boardNodeId,
        auth,
        link.pollCursor ?? null,
      );
    } catch (err) {
      await this.degrade(link, err, nowMs);
      return { due: true, fetched: 0, triggers: 0, newProposals: 0, autoSpawned: 0, degraded: true };
    }

    const prevCursor = link.pollCursor ?? {};
    const actionMap = link.columnActionMap ?? {};
    let changed = false;
    let triggers = 0;
    let newProposals = 0;
    let autoSpawned = 0;

    for (const item of page.items) {
      const trigger = this.detectTrigger(item, prevCursor, actionMap);
      if (!trigger) continue;
      triggers += 1;
      const { statusOptionId, column } = trigger;
      const dedupeKey = githubProposalDedupeKey(
        link.projectId,
        item.itemNodeId,
        statusOptionId,
        column.action,
      );
      const inserted = await insertProposalIfNew({
        projectId: link.projectId,
        linkId: link.id,
        itemNodeId: item.itemNodeId,
        contentNodeId: item.contentNodeId,
        statusOptionId,
        statusName: item.statusName ?? "",
        action: column.action,
        title: item.title,
        ticketUrl: item.url,
        dedupeKey,
        status: "pending",
      });
      // A mapped card moved into a triggering column. `deduped` ⇒ a proposal
      // with this dedupeKey already exists (re-detection / card churn) and we
      // do NOT spawn again — the anti-spawn-storm guard.
      log.debug("github-projects trigger", {
        linkId: link.id,
        itemNodeId: item.itemNodeId,
        statusOptionId,
        action: column.action,
        autoSpawn: column.autoSpawn,
        deduped: !inserted,
      });
      if (!inserted) continue;
      changed = true;
      newProposals += 1;
      if (column.autoSpawn) {
        // Auto-spawn is the dangerous opt-in path. approveProposal enforces
        // the per-project concurrency cap + pins a non-yolo permission mode.
        const approve = this.opts.approve ?? defaultApproveProposal;
        try {
          await approve(inserted.id, { kind: "auto" });
          autoSpawned += 1;
        } catch (err) {
          log.warn("github-projects auto-spawn failed", {
            proposalId: inserted.id,
            error: String(err),
          });
        }
      }
    }

    // Advance + persist the cursor; clear any prior error on a clean poll.
    await updateLinkPollState(link.id, {
      pollCursor: page.cursor,
      lastPolledAt: new Date(nowMs),
      lastError: null,
      lastErrorAt: null,
    });
    // A successful poll clears rate-limit back-off.
    this.backoff.delete(link.id);

    log.debug("github-projects link polled", {
      linkId: link.id,
      projectId: link.projectId,
      fetched: page.items.length,
      triggers,
      newProposals,
      autoSpawned,
      cursorSize: Object.keys(page.cursor).length,
    });

    // Injected `emit` wins (tests); else fall back to the registered bus
    // emitter so the lazily-constructed `getGithubProjectsDaemon()` singleton —
    // which carries no `emit` — still refreshes the Hub.
    if (changed) {
      const emit = this.opts.emit ?? getGithubProjectsEmit();
      emit?.(GITHUB_PROJECTS_EVENT, { projectId: link.projectId });
    }

    return { due: true, fetched: page.items.length, triggers, newProposals, autoSpawned, degraded: false };
  }

  /**
   * A link is due when it has never been polled, OR `pollIntervalSec` has
   * elapsed since `lastPolledAt`. Links in rate-limit back-off are skipped
   * until their cool-down passes.
   */
  private isDue(link: GithubProjectsLink, nowMs: number): boolean {
    const bo = this.backoff.get(link.id);
    if (bo && nowMs < bo.until) return false;
    if (!link.lastPolledAt) return true;
    const elapsedSec = (nowMs - link.lastPolledAt.getTime()) / 1000;
    return elapsedSec >= link.pollIntervalSec;
  }

  /**
   * Pure trigger detection. An item triggers when its current `statusOptionId`
   * is a mapped column AND it is newly in that state — either the cursor has
   * never seen this item, or the item's `updatedAt` advanced past the stored
   * high-water mark (a status change bumps `updatedAt`, so the cursor diff
   * captures both "moved into a triggering column" and "re-entered after churn").
   */
  private detectTrigger(
    item: GithubBoardItem,
    prevCursor: Record<string, string>,
    actionMap: Record<string, GithubColumnAction>,
  ): { statusOptionId: string; column: GithubColumnAction } | null {
    const statusOptionId = item.statusOptionId;
    if (!statusOptionId) return null;
    const column = actionMap[statusOptionId];
    if (!column) return null;
    const prev = prevCursor[item.itemNodeId];
    // First time we see this item → trigger. Otherwise only when updatedAt
    // advanced (strictly greater — equal means unchanged since last poll).
    if (prev !== undefined && !(item.updatedAt > prev)) return null;
    return { statusOptionId, column };
  }

  /** Resolve the host-only bearer for a link (PAT from the secrets store, or
   *  `gh auth token`). Delegates to the shared resolver so the daemon and the
   *  `link/refresh-columns` route resolve credentials identically. */
  private async resolveAuth(link: GithubProjectsLink): Promise<GithubAuth> {
    return resolveLinkAuth(link, () => this.runGhAuthToken());
  }

  /** Host shell `gh auth token`. Injectable so tests never spawn a real shell. */
  private async runGhAuthToken(): Promise<string> {
    if (this.opts.ghAuthToken) return this.opts.ghAuthToken();
    // Default host-side resolver: Bun's tagged-template shell.
    const out = await Bun.$`gh auth token`.text();
    return out;
  }

  /**
   * Degrade a single link on a recoverable error: persist lastError/lastErrorAt
   * and, for a rate-limit, set a back-off window so the next sweep skips this
   * link until the cool-down passes. Never re-throws — the sweep continues to
   * the next link.
   */
  private async degrade(link: GithubProjectsLink, err: unknown, nowMs: number): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof GithubRateLimitError) {
      const backoffMs = err.retryAfterMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
      this.backoff.set(link.id, { until: nowMs + backoffMs });
      log.warn("github-projects link rate-limited — backing off", {
        linkId: link.id,
        projectId: link.projectId,
        authMode: link.authMode,
        backoffMs,
      });
    } else if (err instanceof GithubAuthError || err instanceof GithubNotFoundError) {
      log.warn("github-projects link degraded", {
        linkId: link.id,
        projectId: link.projectId,
        authMode: link.authMode,
        error: message,
      });
    } else {
      // An unexpected (non-GitHub) error still degrades the link rather than
      // bubbling out of the sweep — fail-closed for the link, loop continues.
      log.warn("github-projects link unexpected error — degrading", {
        linkId: link.id,
        projectId: link.projectId,
        authMode: link.authMode,
        error: message,
      });
    }
    await updateLinkPollState(link.id, {
      lastError: message,
      lastErrorAt: new Date(nowMs),
    });
  }
}

let singleton: GithubProjectsDaemon | null = null;

export function getGithubProjectsDaemon(): GithubProjectsDaemon {
  if (!singleton) singleton = new GithubProjectsDaemon();
  return singleton;
}

/** Test-only: drop the singleton so a fresh construction is observable. */
export function _resetGithubProjectsDaemonForTests(): void {
  if (singleton) singleton.stop();
  singleton = null;
}
