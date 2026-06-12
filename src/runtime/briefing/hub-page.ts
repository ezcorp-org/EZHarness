/**
 * Daily Briefing — flagship core Hub page (`core:briefing`).
 *
 * Renders the user's briefing config summary, last/next-run status,
 * watchlist, and their recent briefing conversations (deep-linked into
 * chat), plus a "Run now" action that shares the run-now route's
 * single 1-per-5-minutes rate bucket.
 *
 * Layering: this module is pure src/ (db queries + agent-config
 * lookup). The run-now trigger lives in the WEB layer
 * (`web/src/lib/server/briefing-run-now.ts` — it owns the RateLimiter
 * and the fire-and-forget pipeline kick) and is injected at
 * registration time from `web/src/lib/server/context.ts`, the same
 * boot site that registers the briefing runtime. src/ never imports
 * web/.
 *
 * Deep-link shape: `/project/<projectId>/chat/<conversationId>` —
 * verified against ChatThread.svelte / CommandPalette.svelte.
 */
import {
  getBriefingConfig,
  BRIEFING_CONFIG_DEFAULTS,
  type BriefingConfig,
} from "../../db/queries/briefing-configs";
import { listRecentConversationsForUser } from "../../db/queries/conversations";
import { getBriefingAgentConfigId } from "./agent-config";
import {
  registerHubPageProvider,
  HubPageActionError,
  type HubPageProvider,
} from "../hub-pages";
import type { HubPageTree, PageNode } from "../../extensions/page-schema";

export const BRIEFING_HUB_PAGE_ID = "briefing";
export const BRIEFING_RUN_NOW_ACTION = "run-now";
const RECENT_BRIEFINGS_LIMIT = 10;

export interface BriefingHubPageDeps {
  /** Shared run-now trigger (web layer owns the rate bucket). */
  triggerRunNow: (userId: string) => Promise<
    | { ok: true }
    | { ok: false; reason: "unavailable" }
    | { ok: false; reason: "rate-limited"; retryAfter?: number }
  >;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

function fmt(date: Date | null | undefined): string {
  if (!date) return "—";
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function statusNode(config: BriefingConfig): PageNode {
  if (!config.enabled) {
    return { type: "status", label: "Scheduled briefings are off", state: "idle" };
  }
  switch (config.lastFireStatus) {
    case "ok":
      return { type: "status", label: "Last run delivered", state: "success" };
    case "error":
      return {
        type: "status",
        label: `Last run failed (${config.consecutiveErrors} consecutive)`,
        state: "error",
      };
    case "skipped":
      return { type: "status", label: "Last run skipped (nothing to brief)", state: "warning" };
    default:
      return { type: "status", label: "Waiting for the first run", state: "idle" };
  }
}

async function renderBriefingPage(userId: string): Promise<HubPageTree> {
  const stored = await getBriefingConfig(userId);
  const config: BriefingConfig =
    stored ??
    ({
      userId,
      ...BRIEFING_CONFIG_DEFAULTS,
      watchlist: [],
      lastFireAt: null,
      lastFireStatus: null,
      consecutiveErrors: 0,
      nextFireAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as BriefingConfig);

  // Recent briefing conversations: filtered by the shared briefing
  // agent-config id — NOT a title pattern (locked decision). When the
  // agent was never bootstrapped on this host there are no briefing
  // conversations by construction.
  const agentConfigId = await getBriefingAgentConfigId();
  const recent = agentConfigId
    ? await listRecentConversationsForUser(userId, {
        onlyAgentConfigId: agentConfigId,
        limit: RECENT_BRIEFINGS_LIMIT,
      })
    : [];

  const nodes: PageNode[] = [
    statusNode(config),
    {
      type: "kv",
      pairs: [
        { key: "Enabled", value: config.enabled ? "Yes" : "No" },
        { key: "Schedule", value: config.cron },
        { key: "Timezone", value: config.timezone },
        ...(config.model ? [{ key: "Model", value: config.model }] : []),
        ...(config.instructions
          ? [{ key: "Instructions", value: config.instructions }]
          : []),
      ],
    },
    {
      type: "stats",
      items: [
        { label: "Last run", value: fmt(config.lastFireAt) },
        { label: "Next run", value: config.enabled ? fmt(config.nextFireAt) : "—" },
        { label: "Consecutive errors", value: String(config.consecutiveErrors) },
      ],
    },
    {
      type: "button",
      label: "Run now",
      style: "primary",
      action: {
        event: BRIEFING_RUN_NOW_ACTION,
        confirm: "Run your briefing now? This uses your provider credits.",
      },
    },
    { type: "divider" },
  ];

  if (config.watchlist.length > 0) {
    nodes.push(
      { type: "heading", level: 3, text: "Watchlist" },
      {
        type: "list",
        items: config.watchlist.map((w) => ({
          label: w.topic,
          detail: `added ${w.addedAt.slice(0, 10)}`,
        })),
      },
      { type: "divider" },
    );
  }

  nodes.push({ type: "heading", level: 3, text: "Recent briefings" });
  if (recent.length === 0) {
    nodes.push({
      type: "empty-state",
      title: "No briefings yet",
      detail: "Run one now, or enable the schedule in Settings.",
    });
  } else {
    nodes.push({
      type: "table",
      columns: ["Briefing", "Created"],
      rows: recent.map((conv) => ({
        cells: [conv.title || "Untitled briefing", fmt(conv.createdAt)],
        href: `/project/${conv.projectId}/chat/${conv.id}`,
      })),
    });
  }

  return { title: "Daily Briefing", nodes };
}

/**
 * Build the provider. Factory (rather than a module-level constant) so
 * the run-now trigger can be injected from the web layer and tests can
 * substitute a stub.
 */
export function createBriefingHubPageProvider(
  deps: BriefingHubPageDeps,
): HubPageProvider {
  return {
    id: BRIEFING_HUB_PAGE_ID,
    title: "Daily Briefing",
    icon: "Sunrise",
    description: "Your scheduled briefing: config, history, and run-now.",
    render: (ctx) => renderBriefingPage(ctx.userId),
    actions: {
      [BRIEFING_RUN_NOW_ACTION]: async (ctx) => {
        const result = await deps.triggerRunNow(ctx.userId);
        if (!result.ok) {
          if (result.reason === "unavailable") {
            throw new HubPageActionError(
              503,
              "Briefing runtime is not available yet — try again shortly",
            );
          }
          throw new HubPageActionError(
            429,
            "Briefing was already run recently — try again later",
            result.retryAfter,
          );
        }
        // Re-render so the tab reflects the just-started run.
        return renderBriefingPage(ctx.userId);
      },
    },
  };
}

/** Boot-time registration — called from the web layer's
 *  `ensureInitialized()` next to `registerBriefingRuntime`. */
export function registerBriefingHubPage(deps: BriefingHubPageDeps): void {
  registerHubPageProvider(createBriefingHubPageProvider(deps));
}
