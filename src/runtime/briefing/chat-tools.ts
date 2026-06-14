/**
 * Daily Briefing — conversational subscribe tools (Phase 3, spec §5.5).
 *
 * Host-side tools wired into NORMAL conversations (never the
 * briefing run itself — see setup-tools' gate), so "keep an eye on the
 * Bun 2.0 release for me" lands in the watchlist mid-chat:
 *
 *   - `briefing_watch(topic)`    — add a watchlist topic.
 *   - `briefing_unwatch(topic)`  — remove one (case-insensitive).
 *   - `configure_briefing(...)`  — plain-field config (enabled, time,
 *     days preset, timezone, instructions) mapped to cron via the SAME
 *     pure module the settings UI uses (web/src/lib/briefing-cron —
 *     direct src→web/src/lib import, the mention-logic convention).
 *   - `briefing_status()`        — read-only: schedule, last/next fire,
 *     watchlist, recent briefing conversations. Added after a live
 *     transcript showed "what's the latest on my briefings?" had no
 *     affordance — the model flailed through the task-tracking agent
 *     registry hunting for a "Daily Briefing" agent.
 *
 * Every write is user-scoped (userId resolved from the conversation
 * row), funnels through `validateBriefingConfigInput` (shape/caps/
 * dedupe — DRY with the PUT route) and persists via
 * `upsertBriefingConfig` (preserve semantics + next_fire_at recompute).
 * Each returns a plain-text in-chat confirmation; everything captured
 * here is visible + deletable in Settings → Briefing (curation floor,
 * spec §4.3).
 *
 * Wiring mirrors ez-tools-host / briefing/tools.ts: pure in-place push
 * onto the per-turn agentTools array, dedup by name, fail-soft at the
 * setup-tools call site. Category 'write' keeps them excluded from any
 * read-only-restricted turn (including the briefing pipeline run).
 */
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { BuiltinToolDef } from "../tools/types";
import {
  getBriefingConfig,
  upsertBriefingConfig,
  BRIEFING_CONFIG_DEFAULTS,
} from "../../db/queries/briefing-configs";
import {
  validateBriefingConfigInput,
  MAX_TOPIC_LENGTH,
  MAX_WATCHLIST_TOPICS,
} from "./config-validation";
import { addWatchlistTopic, removeWatchlistTopic } from "./watchlist";
import {
  buildBriefingCron,
  parseBriefingCron,
  describeBriefingCron,
  type BriefingSchedule,
  type WeekdayPreset,
} from "../../../web/src/lib/briefing-cron";
import { getBriefingAgentConfigId } from "./agent-config";
import { listRecentConversationsForUser } from "../../db/queries/conversations";
import { logger } from "../../logger";

const log = logger.child("briefing.chat-tools");

export const BRIEFING_CHAT_TOOL_NAMES = [
  "briefing_watch",
  "briefing_unwatch",
  "configure_briefing",
  "briefing_status",
] as const;

const MANAGE_HINT = "manage it in Settings → Briefing";

export interface BriefingChatToolContext {
  /** Conversation owner — every read/write is scoped to this id. */
  userId: string;
}

function ok(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function err(text: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${text}` }],
    details: { isError: true },
  };
}

type Watchlist = Array<{ topic: string; addedAt: string }>;

async function loadWatchlist(userId: string): Promise<{ watchlist: Watchlist; enabled: boolean }> {
  const existing = await getBriefingConfig(userId);
  return {
    watchlist: existing?.watchlist ?? [],
    enabled: existing?.enabled ?? BRIEFING_CONFIG_DEFAULTS.enabled,
  };
}

export function createBriefingWatchTool(ctx: BriefingChatToolContext): BuiltinToolDef {
  return {
    name: "briefing_watch",
    label: "briefing_watch",
    description:
      `Subscribe a topic to the user's Daily Briefing watchlist — every morning's briefing will research overnight developments on it. Use when the user asks to keep an eye on / follow / watch a topic. Max ${MAX_WATCHLIST_TOPICS} topics, ${MAX_TOPIC_LENGTH} chars each.`,
    category: "write",
    cardType: "default",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        topic: { type: "string", description: "The topic to watch, e.g. \"Bun 2.0 release\"." },
      },
      required: ["topic"],
    }),
    execute: async (_toolCallId, params: unknown) => {
      try {
        const p = (params ?? {}) as Record<string, unknown>;
        const topic = typeof p.topic === "string" ? p.topic.trim() : "";
        if (!topic) return err("topic is required");

        // `enabled` is needed only for the chat-specific disabled hint;
        // the add/dedup/validate/persist logic is the shared primitive.
        const { enabled } = await loadWatchlist(ctx.userId);
        const result = await addWatchlistTopic(ctx.userId, topic);
        if (!result.ok) return err(result.error);
        if (!result.added) {
          return ok(`"${topic}" is already on your briefing watchlist — ${MANAGE_HINT}.`, {
            alreadyWatched: true,
            topic,
          });
        }

        const enabledHint = enabled
          ? ""
          : " Your daily briefing is currently disabled — enable it there (or ask me) to start receiving it.";
        log.info("watchlist topic added via chat", { userId: ctx.userId, topic });
        return ok(
          `Added "${topic}" to your briefing watchlist — ${MANAGE_HINT}.${enabledHint}`,
          { topic, watchlistSize: result.size },
        );
      } catch (e) {
        return err((e as Error)?.message ?? String(e));
      }
    },
  };
}

export function createBriefingUnwatchTool(ctx: BriefingChatToolContext): BuiltinToolDef {
  return {
    name: "briefing_unwatch",
    label: "briefing_unwatch",
    description:
      "Remove a topic from the user's Daily Briefing watchlist (case-insensitive match). Use when the user asks to stop watching / following a topic.",
    category: "write",
    cardType: "default",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        topic: { type: "string", description: "The watched topic to remove." },
      },
      required: ["topic"],
    }),
    execute: async (_toolCallId, params: unknown) => {
      try {
        const p = (params ?? {}) as Record<string, unknown>;
        const topic = typeof p.topic === "string" ? p.topic.trim() : "";
        if (!topic) return err("topic is required");

        // Load once for the chat-specific not-found listing + the
        // matched topic's original casing in the confirmation; the
        // remove/validate/persist logic is the shared primitive.
        const { watchlist } = await loadWatchlist(ctx.userId);
        const match = watchlist.find((w) => w.topic.toLowerCase() === topic.toLowerCase());
        if (!match) {
          const current = watchlist.map((w) => `"${w.topic}"`).join(", ");
          return ok(
            watchlist.length === 0
              ? `"${topic}" isn't on your briefing watchlist — it's currently empty.`
              : `"${topic}" isn't on your briefing watchlist. Currently watching: ${current}.`,
            { notWatched: true, topic },
          );
        }

        const result = await removeWatchlistTopic(ctx.userId, match.topic);
        if (!result.ok) return err(result.error);

        log.info("watchlist topic removed via chat", { userId: ctx.userId, topic: match.topic });
        return ok(
          `Removed "${match.topic}" from your briefing watchlist — ${MANAGE_HINT}.`,
          { topic: match.topic, watchlistSize: watchlist.length - 1 },
        );
      } catch (e) {
        return err((e as Error)?.message ?? String(e));
      }
    },
  };
}

const WEEKDAY_PRESETS: ReadonlySet<string> = new Set(["daily", "weekdays", "weekends"]);

export function createConfigureBriefingTool(ctx: BriefingChatToolContext): BuiltinToolDef {
  return {
    name: "configure_briefing",
    label: "configure_briefing",
    description:
      'Configure the user\'s Daily Briefing from plain fields: enabled, time of day ("HH:MM" 24h), days preset ("daily" | "weekdays" | "weekends"), IANA timezone, and free-text instructions. Use when the user asks to set up / change / enable / disable their morning briefing. Only pass the fields the user asked to change.',
    category: "write",
    cardType: "default",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "Turn the daily briefing on or off." },
        time: { type: "string", description: '24h wall-clock delivery time, e.g. "07:00".' },
        days: {
          type: "string",
          enum: ["daily", "weekdays", "weekends"],
          description: "Which days the briefing fires.",
        },
        timezone: { type: "string", description: 'IANA timezone, e.g. "Europe/Berlin".' },
        instructions: {
          type: "string",
          description: "Free-text steering appended verbatim to the briefing agent's prompt.",
        },
      },
    }),
    execute: async (_toolCallId, params: unknown) => {
      try {
        const p = (params ?? {}) as Record<string, unknown>;
        const hasAny = ["enabled", "time", "days", "timezone", "instructions"].some(
          (k) => p[k] !== undefined,
        );
        if (!hasAny) {
          return err("nothing to change — pass at least one of enabled, time, days, timezone, instructions");
        }

        const input: Record<string, unknown> = {};
        if (p.enabled !== undefined) input.enabled = p.enabled;
        if (p.timezone !== undefined) input.timezone = p.timezone;
        if (p.instructions !== undefined) input.instructions = p.instructions;

        // Schedule mapping — the SAME cron logic as the settings UI
        // pickers. A partial change (only time, or only days) merges
        // with the stored schedule; an unparseable (hand-edited) stored
        // cron falls back to the UI defaults rather than mangling it
        // silently — the new picker-shaped cron replaces it, exactly
        // like saving from the settings page does.
        if (p.time !== undefined || p.days !== undefined) {
          if (p.time !== undefined && typeof p.time !== "string") {
            return err('time must be a "HH:MM" 24h string');
          }
          if (p.days !== undefined && (typeof p.days !== "string" || !WEEKDAY_PRESETS.has(p.days))) {
            return err('days must be one of "daily", "weekdays", "weekends"');
          }
          const existing = await getBriefingConfig(ctx.userId);
          const stored: BriefingSchedule = parseBriefingCron(
            existing?.cron ?? BRIEFING_CONFIG_DEFAULTS.cron,
          ) ?? { time: "07:00", preset: "daily" };
          const schedule: BriefingSchedule = {
            time: (p.time as string | undefined) ?? stored.time,
            preset: ((p.days as string | undefined) ?? stored.preset) as WeekdayPreset,
          };
          const cron = buildBriefingCron(schedule);
          if (!cron) return err(`invalid time "${schedule.time}" — use a 24h "HH:MM" value`);
          input.cron = cron;
        }

        const validated = validateBriefingConfigInput(input);
        if (!validated.ok) return err(validated.error);
        const row = await upsertBriefingConfig(ctx.userId, validated.input);

        // describeBriefingCron is null for hand-edited (API-written)
        // crons — fall back to showing the raw expression, mirroring
        // the settings UI's read-only raw-cron display.
        const scheduleDesc = describeBriefingCron(row.cron) ?? `cron "${row.cron}"`;
        const summary = [
          row.enabled ? "enabled" : "disabled",
          scheduleDesc,
          `timezone ${row.timezone}`,
        ].join(", ");
        log.info("briefing configured via chat", { userId: ctx.userId, enabled: row.enabled, cron: row.cron });
        return ok(`Daily briefing updated: ${summary} — ${MANAGE_HINT}.`, {
          enabled: row.enabled,
          cron: row.cron,
          timezone: row.timezone,
        });
      } catch (e) {
        return err((e as Error)?.message ?? String(e));
      }
    },
  };
}

/** Mirrors the settings UI's STATUS_LABELS — keep the wording aligned. */
const FIRE_STATUS_LABELS: Record<string, string> = {
  ok: "delivered",
  error: "failed",
  skipped: "skipped",
};

const MAX_STATUS_BRIEFINGS = 5;

export function createBriefingStatusTool(ctx: BriefingChatToolContext): BuiltinToolDef {
  return {
    name: "briefing_status",
    label: "briefing_status",
    description:
      "Read-only status of the user's Daily Briefing: whether it's enabled, the schedule, last/next delivery, the watchlist, and their most recent briefing conversations (by title). Use when the user asks about their briefing(s) — \"what's the latest on my briefings\", \"when is my next briefing\", \"what am I watching\".",
    category: "read",
    cardType: "default",
    parameters: Type.Unsafe({ type: "object", properties: {} }),
    execute: async (_toolCallId, _params: unknown) => {
      try {
        const config = await getBriefingConfig(ctx.userId);
        if (!config) {
          return ok(
            `The daily briefing isn't set up yet. Offer to set it up — configure_briefing can enable it with a delivery time, or the user can use Settings → Briefing.`,
            { configured: false },
          );
        }

        const lines: string[] = [];
        const scheduleDesc = describeBriefingCron(config.cron) ?? `cron "${config.cron}"`;
        lines.push(
          `Daily briefing is ${config.enabled ? "enabled" : "disabled"} — ${scheduleDesc}, timezone ${config.timezone}.`,
        );
        if (config.lastFireAt) {
          const label = FIRE_STATUS_LABELS[config.lastFireStatus ?? ""] ?? config.lastFireStatus ?? "unknown";
          lines.push(`Last run: ${label} at ${config.lastFireAt.toISOString()}.`);
        } else {
          lines.push("No briefing has run yet.");
        }
        if (config.enabled && config.nextFireAt) {
          lines.push(`Next run: ${config.nextFireAt.toISOString()}.`);
        }
        const watchlist = config.watchlist ?? [];
        lines.push(
          watchlist.length === 0
            ? "Watchlist: empty."
            : `Watchlist: ${watchlist.map((w) => `"${w.topic}"`).join(", ")}.`,
        );

        let briefings: Array<{ id: string; title: string; updatedAt: string }> = [];
        const agentConfigId = await getBriefingAgentConfigId();
        if (agentConfigId) {
          const recent = await listRecentConversationsForUser(ctx.userId, {
            onlyAgentConfigId: agentConfigId,
            limit: MAX_STATUS_BRIEFINGS,
          });
          briefings = recent.map((c) => ({
            id: c.id,
            title: c.title ?? "Daily Briefing",
            updatedAt: c.updatedAt.toISOString(),
          }));
        }
        lines.push(
          briefings.length === 0
            ? "No briefing conversations yet."
            : `Recent briefings: ${briefings.map((b) => `"${b.title}" (${b.updatedAt.slice(0, 10)})`).join(", ")}.`,
        );

        return ok(lines.join("\n"), {
          configured: true,
          enabled: config.enabled,
          cron: config.cron,
          timezone: config.timezone,
          lastFireAt: config.lastFireAt?.toISOString() ?? null,
          lastFireStatus: config.lastFireStatus ?? null,
          nextFireAt: config.nextFireAt?.toISOString() ?? null,
          watchlist: watchlist.map((w) => w.topic),
          briefings,
        });
      } catch (e) {
        return err((e as Error)?.message ?? String(e));
      }
    },
  };
}

export interface WireBriefingChatToolsParams {
  /** Per-turn agentTools array (mutated in place). */
  agentTools: AgentTool[];
  /** Per-turn BuiltinToolDef map so bridge/permission middleware can
   *  look up category + cardType (mirrors wireEzToolsForTurn). */
  builtinToolDefsMap?: Map<string, BuiltinToolDef>;
  conversationId: string;
  userId: string;
}

/**
 * Wire the three briefing chat tools into the per-turn agentTools
 * array. Dedup by name (defensive — mirrors ez-tools-host's posture).
 */
export function wireBriefingChatToolsForTurn(params: WireBriefingChatToolsParams): void {
  const { agentTools, builtinToolDefsMap, conversationId, userId } = params;
  const ctx: BriefingChatToolContext = { userId };

  const defs: BuiltinToolDef[] = [
    createBriefingWatchTool(ctx),
    createBriefingUnwatchTool(ctx),
    createConfigureBriefingTool(ctx),
    createBriefingStatusTool(ctx),
  ];

  const existingNames = new Set(agentTools.map((t) => t.name));
  let registered = 0;
  for (const def of defs) {
    if (existingNames.has(def.name)) continue;
    builtinToolDefsMap?.set(def.name, def);
    agentTools.push({
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: def.parameters,
      execute: def.execute,
    });
    registered++;
  }

  log.info("briefing chat tools wired for turn", {
    conversationId,
    userId,
    registered,
    expected: BRIEFING_CHAT_TOOL_NAMES.length,
  });
}
