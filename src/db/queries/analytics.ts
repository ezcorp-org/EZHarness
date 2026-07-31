import { sql, desc, eq, gte, and, isNotNull, count, countDistinct, type SQL } from "drizzle-orm";
import { getDb } from "../connection";
import {
  messages,
  conversations,
  users,
  agentConfigs,
  extensions,
  conversationExtensions,
  auditLog,
  errorLogs,
  toolCalls,
} from "../schema";
import { listErrors } from "./error-logs";
import { nowMinusInterval } from "./sql-interval";
import { modelPrices, resolveModelObject, tierForModel } from "../../providers/registry";
import { priceSegment, type SegmentCost } from "../../runtime/usage/cache-stats";
import { isRoutingTier, strongestTier, type RoutingTier } from "../../runtime/tier-classifier";

// Top-N cap for each tool-usage ranking. Keeps the admin analytics payload
// bounded even on installations with thousands of distinct tool names.
const TOOL_USAGE_TOP_N = 50;

// ── Chat Activity ────────────────────────────────────────────────────

export async function getChatActivity(days = 30) {
  const db = getDb();
  const rows = await db
    .select({
      date: sql<string>`DATE(${messages.createdAt})`.as("date"),
      messageCount: count(messages.id).as("message_count"),
      conversationCount: countDistinct(messages.conversationId).as("conversation_count"),
    })
    .from(messages)
    .where(gte(messages.createdAt, nowMinusInterval(days, "days")))
    .groupBy(sql`DATE(${messages.createdAt})`)
    .orderBy(sql`DATE(${messages.createdAt})`);

  return rows.map((r: Record<string, unknown>) => ({
    date: String(r.date),
    messageCount: Number(r.messageCount),
    conversationCount: Number(r.conversationCount),
  }));
}

// ── Model Usage ──────────────────────────────────────────────────────

export async function getModelUsage(days = 30) {
  const db = getDb();
  const rows = await db
    .select({
      model: messages.model,
      provider: messages.provider,
      count: count(messages.id).as("count"),
    })
    .from(messages)
    .where(
      and(
        eq(messages.role, "assistant"),
        isNotNull(messages.model),
        gte(messages.createdAt, nowMinusInterval(days, "days")),
      ),
    )
    .groupBy(messages.model, messages.provider)
    .orderBy(desc(sql`count`));

  return rows.map((r: Record<string, unknown>) => ({
    model: r.model ?? "unknown",
    provider: r.provider ?? "unknown",
    count: Number(r.count),
  }));
}

// ── Agent Stats ──────────────────────────────────────────────────────

export async function getAgentStats() {
  const db = getDb();
  const rows = await db
    .select({
      name: agentConfigs.name,
      conversationCount: count(conversations.id).as("conversation_count"),
    })
    .from(conversations)
    .leftJoin(agentConfigs, eq(conversations.agentConfigId, agentConfigs.id))
    .where(isNotNull(conversations.agentConfigId))
    .groupBy(agentConfigs.name)
    .orderBy(desc(sql`conversation_count`))
    .limit(20);

  return rows.map((r: Record<string, unknown>) => ({
    name: r.name ?? "Unknown",
    conversationCount: Number(r.conversationCount),
  }));
}

// ── Extension Stats ──────────────────────────────────────────────────

export async function getExtensionStats() {
  const db = getDb();
  const rows = await db
    .select({
      name: extensions.name,
      installCount: count(conversationExtensions.id).as("install_count"),
    })
    .from(conversationExtensions)
    .leftJoin(extensions, eq(conversationExtensions.extensionId, extensions.id))
    .groupBy(extensions.name)
    .orderBy(desc(sql`install_count`))
    .limit(20);

  return rows.map((r: Record<string, unknown>) => ({
    name: r.name ?? "Unknown",
    installCount: Number(r.installCount),
  }));
}

// ── User Stats ───────────────────────────────────────────────────────

export async function getUserStats() {
  const db = getDb();

  // Total users
  const [totals] = await db
    .select({
      totalUsers: count(users.id).as("total_users"),
    })
    .from(users);

  // Active users (had conversations in last 30 days)
  const [active] = await db
    .select({
      activeUsers: countDistinct(conversations.userId).as("active_users"),
    })
    .from(conversations)
    .where(gte(conversations.createdAt, sql`NOW() - INTERVAL '30 days'`));

  // Signup trend (last 30 days)
  const signups = await db
    .select({
      date: sql<string>`DATE(${users.createdAt})`.as("date"),
      count: count(users.id).as("count"),
    })
    .from(users)
    .where(gte(users.createdAt, sql`NOW() - INTERVAL '30 days'`))
    .groupBy(sql`DATE(${users.createdAt})`)
    .orderBy(sql`DATE(${users.createdAt})`);

  return {
    totalUsers: Number(totals?.totalUsers ?? 0),
    activeUsers30d: Number(active?.activeUsers ?? 0),
    signupsLast30d: signups.map((r: Record<string, unknown>) => ({
      date: String(r.date),
      count: Number(r.count),
    })),
  };
}

// ── System Health ────────────────────────────────────────────────────

export async function getSystemHealth() {
  const db = getDb();

  // PGlite doesn't support pg_database_size; estimate from table counts
  let dbSizeBytes = 0;
  try {
    const sizeResult = await db.execute(sql`SELECT pg_database_size(current_database()) AS size`);
    dbSizeBytes = Number((sizeResult as any).rows?.[0]?.size ?? 0);
  } catch {
    dbSizeBytes = 0;
  }

  const uptimeSeconds = Math.floor(process.uptime());

  // Row counts for key tables
  const tables = [
    { name: "messages", table: messages },
    { name: "conversations", table: conversations },
    { name: "users", table: users },
    { name: "agent_configs", table: agentConfigs },
    { name: "extensions", table: extensions },
  ] as const;

  const tableRowCounts: Record<string, number> = {};
  for (const t of tables) {
    try {
      const [row] = await db.select({ count: count() }).from(t.table);
      tableRowCounts[t.name] = Number(row?.count ?? 0);
    } catch {
      tableRowCounts[t.name] = 0;
    }
  }

  return { dbSizeBytes, uptimeSeconds, tableRowCounts };
}

// ── Activity Feed ────────────────────────────────────────────────────

export async function getActivityFeed(limit = 50) {
  const db = getDb();
  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      target: auditLog.target,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
      userId: auditLog.userId,
      userName: users.name,
      userEmail: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.userId, users.id))
    .orderBy(desc(auditLog.createdAt))
    .limit(Math.min(limit, 200));

  return rows;
}

// ── Error Summary ────────────────────────────────────────────────────

export async function getErrorSummary(days = 7) {
  const db = getDb();

  // Error rate grouped by date
  const errorRate = await db
    .select({
      date: sql<string>`DATE(${errorLogs.createdAt})`.as("date"),
      count: count(errorLogs.id).as("count"),
    })
    .from(errorLogs)
    .where(gte(errorLogs.createdAt, nowMinusInterval(days, "days")))
    .groupBy(sql`DATE(${errorLogs.createdAt})`)
    .orderBy(sql`DATE(${errorLogs.createdAt})`);

  // Total errors in period
  const totalErrors = errorRate.reduce(
    (sum: number, r: Record<string, unknown>) => sum + Number(r.count),
    0,
  );

  // Recent errors
  const recentErrors = await listErrors({ limit: 20 });

  return {
    totalErrors,
    errorRate: errorRate.map((r: Record<string, unknown>) => ({
      date: String(r.date),
      count: Number(r.count),
    })),
    recentErrors,
  };
}

// ── Tool-Call Usage ──────────────────────────────────────────────────
//
// Aggregate tool_calls by each of four dimensions: tool, agent, user,
// model. All filters hit the denormalized user_id / agent_config_id /
// model columns on tool_calls (indexed on (dim, created_at)), so these
// queries don't need runtime joins except to project display names.

export type ToolUsageByTool = {
  toolName: string;
  extensionId: string;
  count: number;
  successCount: number;
  errorCount: number;
};

export type ToolUsageByAgent = {
  agentConfigId: string | null;
  agentName: string;
  toolName: string;
  count: number;
  successCount: number;
  errorCount: number;
};

export type ToolUsageByUser = {
  userId: string | null;
  userName: string;
  userEmail: string;
  toolName: string;
  count: number;
  successCount: number;
  errorCount: number;
};

export type ToolUsageByModel = {
  model: string;
  provider: string;
  toolName: string;
  count: number;
  successCount: number;
  errorCount: number;
};

function sinceDays(days: number) {
  // `nowMinusInterval` clamps `days` to a non-negative integer (non-finite
  // input falls back to 30), so a NaN/Infinity reaching this query-module
  // surface can never produce an `INTERVAL 'NaN days'` that throws. Upstream
  // API callers additionally clamp the query-param to [1, 365].
  return gte(toolCalls.createdAt, nowMinusInterval(days, "days"));
}

export async function getToolUsageByTool(days = 30): Promise<ToolUsageByTool[]> {
  const db = getDb();
  const rows = await db
    .select({
      toolName: toolCalls.toolName,
      extensionId: toolCalls.extensionId,
      count: count(toolCalls.id).as("count"),
      successCount: sql<number>`SUM(CASE WHEN ${toolCalls.success} THEN 1 ELSE 0 END)`.as("success_count"),
    })
    .from(toolCalls)
    .where(sinceDays(days))
    .groupBy(toolCalls.toolName, toolCalls.extensionId)
    .orderBy(desc(sql`count`))
    .limit(TOOL_USAGE_TOP_N);

  return rows.map((r: Record<string, unknown>) => {
    const total = Number(r.count);
    const ok = Number(r.successCount ?? 0);
    return {
      toolName: String(r.toolName ?? ""),
      extensionId: String(r.extensionId ?? ""),
      count: total,
      successCount: ok,
      errorCount: total - ok,
    };
  });
}

export async function getToolUsageByAgent(days = 30): Promise<ToolUsageByAgent[]> {
  const db = getDb();
  const rows = await db
    .select({
      agentConfigId: toolCalls.agentConfigId,
      agentName: agentConfigs.name,
      toolName: toolCalls.toolName,
      count: count(toolCalls.id).as("count"),
      successCount: sql<number>`SUM(CASE WHEN ${toolCalls.success} THEN 1 ELSE 0 END)`.as("success_count"),
    })
    .from(toolCalls)
    .leftJoin(agentConfigs, eq(toolCalls.agentConfigId, agentConfigs.id))
    .where(and(sinceDays(days), isNotNull(toolCalls.agentConfigId)))
    .groupBy(toolCalls.agentConfigId, agentConfigs.name, toolCalls.toolName)
    .orderBy(desc(sql`count`))
    .limit(TOOL_USAGE_TOP_N);

  return rows.map((r: Record<string, unknown>) => {
    const total = Number(r.count);
    const ok = Number(r.successCount ?? 0);
    return {
      agentConfigId: (r.agentConfigId as string | null) ?? null,
      agentName: String(r.agentName ?? "Unknown"),
      toolName: String(r.toolName ?? ""),
      count: total,
      successCount: ok,
      errorCount: total - ok,
    };
  });
}

export async function getToolUsageByUser(days = 30): Promise<ToolUsageByUser[]> {
  const db = getDb();
  const rows = await db
    .select({
      userId: toolCalls.userId,
      userName: users.name,
      userEmail: users.email,
      toolName: toolCalls.toolName,
      count: count(toolCalls.id).as("count"),
      successCount: sql<number>`SUM(CASE WHEN ${toolCalls.success} THEN 1 ELSE 0 END)`.as("success_count"),
    })
    .from(toolCalls)
    .leftJoin(users, eq(toolCalls.userId, users.id))
    .where(and(sinceDays(days), isNotNull(toolCalls.userId)))
    .groupBy(toolCalls.userId, users.name, users.email, toolCalls.toolName)
    .orderBy(desc(sql`count`))
    .limit(TOOL_USAGE_TOP_N);

  return rows.map((r: Record<string, unknown>) => {
    const total = Number(r.count);
    const ok = Number(r.successCount ?? 0);
    return {
      userId: (r.userId as string | null) ?? null,
      userName: String(r.userName ?? "Unknown"),
      userEmail: String(r.userEmail ?? ""),
      toolName: String(r.toolName ?? ""),
      count: total,
      successCount: ok,
      errorCount: total - ok,
    };
  });
}

export async function getToolUsageByModel(days = 30): Promise<ToolUsageByModel[]> {
  const db = getDb();
  const rows = await db
    .select({
      model: toolCalls.model,
      provider: toolCalls.provider,
      toolName: toolCalls.toolName,
      count: count(toolCalls.id).as("count"),
      successCount: sql<number>`SUM(CASE WHEN ${toolCalls.success} THEN 1 ELSE 0 END)`.as("success_count"),
    })
    .from(toolCalls)
    .where(and(sinceDays(days), isNotNull(toolCalls.model)))
    .groupBy(toolCalls.model, toolCalls.provider, toolCalls.toolName)
    .orderBy(desc(sql`count`))
    .limit(TOOL_USAGE_TOP_N);

  return rows.map((r: Record<string, unknown>) => {
    const total = Number(r.count);
    const ok = Number(r.successCount ?? 0);
    return {
      model: String(r.model ?? "unknown"),
      provider: String(r.provider ?? "unknown"),
      toolName: String(r.toolName ?? ""),
      count: total,
      successCount: ok,
      errorCount: total - ok,
    };
  });
}

// ── Routing & Cost ───────────────────────────────────────────────────
//
// Answers the one question that decides whether configurable model routing
// pays for itself: how many assistant turns were actually ROUTED (the router
// picked the model) rather than PINNED (the user picked it), and what the
// served models cost. Everything is derived from the `messages.usage` jsonb
// plus the `model`/`provider` columns — no new table and no migration (see
// the canonical-shape comment on `messages.usage` in ../schema.ts).
//
// PROVENANCE IS THREE-WAY, NOT TWO. `usage->>'requestedModel' IS NULL` is
// true both for a routed turn (key present, JSON `null`) AND for a LEGACY row
// written before routing provenance existed (key absent entirely) — the
// writer uses a conditional spread, so a pinned turn and a pre-WS5 turn are
// distinguishable only by key EXISTENCE (stream-chat/subscribe-bridge.ts).
// Collapsing the two would report every pre-routing installation as 100%
// routed, which is the exact miscount this split exists to prevent:
//
//   routed  — key present AND JSON null  ⇒ the router chose the model
//   pinned  — key present AND a string   ⇒ the user pinned the model
//   legacy  — key absent, or no usage    ⇒ no provenance recorded
//
// `routedShare` divides by routed+pinned only, so legacy rows can neither
// dilute nor inflate the headline number; they are reported on their own.

/**
 * Cap on each returned sample list (mid-conversation model switches, A/B retry
 * groups) and on the spend-segment table — same bounded-payload reasoning as
 * `TOOL_USAGE_TOP_N`. Every COUNT, RATE and DOLLAR TOTAL beside a list is
 * aggregated UNCAPPED, so a truncated sample list can never distort them.
 *
 * For spend that means the cap is applied in JS to the returned `segments`
 * array AFTER the totals are summed — never as a SQL `LIMIT` on the aggregate
 * the totals read from. Moving it back into the query would understate
 * `totalUsd`, because the rows it drops are the lowest-volume ones and volume
 * does not track cost. `spend.segmentsTruncated` tells the UI the table is
 * partial while the totals are whole.
 */
const ROUTING_SAMPLE_CAP = 50;

/** One assistant turn's three-way routing provenance (see the section note). */
export type RoutingProvenance = "routed" | "pinned" | "legacy";

/** How a mid-conversation model change moved across the tier ladder. */
export type RoutingSwitchKind = "escalation" | "downgrade" | "lateral";

export type RoutingTierShare = { tier: RoutingTier; count: number };

/** Priced spend for one provider+model+provenance bucket. */
export type RoutingSpendSegment = {
  provider: string;
  model: string;
  provenance: RoutingProvenance;
  turnCount: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    /** ALL cache-creation tokens (the 1h subset included). */
    cacheWrite: number;
    /** SUBSET of `cacheWrite` written with 1h retention — never summed into totals. */
    cacheWrite1h: number;
  };
  /**
   * USD breakdown, or `null` for an UNPRICED model. `null` is deliberately
   * NOT a `total` of 0: OAuth subscription models (Claude Pro/Max, Codex) are
   * rate-limited rather than billed per token, so pi-ai reports an all-zero
   * `cost` and `priceSegment` returns null. A caller MUST render `tokens` for
   * those instead of a fabricated "$0.00" that reads like a measured price.
   */
  cost: SegmentCost | null;
};

/** One adjacent-turn model change inside a single conversation. */
export type RoutingModelSwitch = {
  conversationId: string;
  /** 1-based assistant-turn ordinal of the LATER row — the turn the switch took effect on. */
  turnIndex: number;
  fromProvider: string;
  fromModel: string;
  fromTier: RoutingTier;
  toProvider: string;
  toModel: string;
  toTier: RoutingTier;
  kind: RoutingSwitchKind;
};

/** One user turn that received more than one assistant answer (an A/B retry). */
export type RoutingRetryGroup = {
  conversationId: string;
  parentMessageId: string;
  siblingCount: number;
  /** The sibling the branch continued through (it has children), or null if none did. */
  continuedThroughMessageId: string | null;
};

export type RoutingStats = {
  days: number;
  turns: {
    total: number;
    routed: number;
    pinned: number;
    /** Rows carrying NO provenance key — excluded from every rate's denominator. */
    legacy: number;
  };
  /** routed / (routed + pinned). 0 when nothing carries provenance yet. */
  routedShare: number;
  /** Only routed turns stamp a tier, so this mix is over routed turns. */
  tierMix: RoutingTierShare[];
  /**
   * WS7 bounded exploration. `turns` counts routed turns that were deliberately
   * served one rung BELOW the classifier's tier to gather unbiased
   * counterfactual data (`provider:explorationRate`, default off). Reported so
   * the tradeoff is never silent: an operator who turned it on can see exactly
   * how many answers paid for the data.
   */
  exploration: {
    turns: number;
    /** turns / routed. 0 when nothing was routed. */
    rate: number;
  };
  /**
   * WS7d shadow mode. A CANDIDATE routing policy (`provider:routingShadow`) is
   * evaluated on every routed turn it could have moved, and what it would have
   * done is recorded without ever being served. This is the online half of the
   * sweep→shadow→promote loop: `scripts/routing-sweep.ts` proposes thresholds
   * from history, and these numbers say how that proposal behaves on live
   * traffic before anyone promotes it.
   *
   * `turns` is 0 when shadow mode is off — treat that as "not configured",
   * NOT as 0% agreement.
   */
  shadow: {
    turns: number;
    agreed: number;
    disagreed: number;
    /** agreed / turns. 0 when nothing was shadowed. */
    agreementRate: number;
  };
  failover: {
    count: number;
    /** Over provenance-carrying turns — the same writer stamps both keys. */
    rate: number;
  };
  switches: {
    /** Adjacent assistant pairs where BOTH turns carry an explicit pin. */
    pairs: number;
    total: number;
    escalations: number;
    downgrades: number;
    lateral: number;
    /** total / pairs. 0 when there are no comparable pairs. */
    rate: number;
    samples: RoutingModelSwitch[];
  };
  retries: {
    /** Distinct user turns that got at least one assistant answer. */
    answeredTurns: number;
    retriedTurns: number;
    /** Answers beyond the first, summed over retried turns. */
    extraSiblings: number;
    /** retriedTurns / answeredTurns. 0 when nothing was answered. */
    rate: number;
    samples: RoutingRetryGroup[];
  };
  spend: {
    /** The busiest segments, capped at `ROUTING_SAMPLE_CAP` for payload size.
     *  A DISPLAY list — never the basis of any total below, which are summed
     *  uncapped so a truncated table can never understate spend. */
    segments: RoutingSpendSegment[];
    /** True when the window had more segments than `segments` shows, so the
     *  panel can say the table is partial while the totals are not. */
    segmentsTruncated: boolean;
    routedUsd: number;
    pinnedUsd: number;
    legacyUsd: number;
    totalUsd: number;
    /** Turns served by an UNPRICED model, and their tokens — the only honest
     *  unit for a subscription model, which has no per-token dollar cost. */
    unpricedTurns: number;
    unpricedTokens: number;
    /** Distinct conversations that produced an assistant turn in the window. */
    conversations: number;
    /** totalUsd / conversations — cost per resolved CONVERSATION, not per
     *  call. `null` when no conversation resolved, or when nothing in the
     *  window was priced at all (so an all-subscription install never sees a
     *  fake $0.00 per conversation). */
    usdPerConversation: number | null;
  };
};

/** Postgres hands COUNT/SUM back as a bigint/numeric STRING — coerce, treating
 *  a missing or NULL aggregate (and any non-finite result) as 0. */
function aggNum(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** The window every routing query shares: assistant turns inside `days`. */
function assistantTurnsSince(days: number): SQL {
  // `nowMinusInterval` clamps `days` to a safe integer (see sql-interval.ts),
  // so a NaN/Infinity reaching here can never emit `INTERVAL 'NaN days'`.
  return sql`${messages.role} = 'assistant' AND ${messages.createdAt} >= ${nowMinusInterval(days, "days")}`;
}

// `jsonb_exists` (the function form of the `?` operator — spelled out so no
// driver's placeholder parser can mistake a bare `?` for a bind marker) is
// what separates "key present and JSON null" (routed) from "key absent"
// (legacy). `usage IS NULL` makes jsonb_exists return NULL, which a FILTER
// clause drops — hence the explicit IS NULL disjunct in IS_LEGACY.
const HAS_REQUESTED_MODEL = sql`jsonb_exists(${messages.usage}, 'requestedModel')`;
const IS_ROUTED = sql`(${HAS_REQUESTED_MODEL} AND ${messages.usage}->'requestedModel' = 'null'::jsonb)`;
const IS_PINNED = sql`(${HAS_REQUESTED_MODEL} AND ${messages.usage}->'requestedModel' <> 'null'::jsonb)`;
const IS_LEGACY = sql`(${messages.usage} IS NULL OR NOT ${HAS_REQUESTED_MODEL})`;
// WS7: an EXPLORED turn stamps `routingSignals.exploration = true`. Matched on
// the jsonb `true` literal (not `->>'exploration' = 'true'`) so a string
// `"true"` written by some future non-boolean writer can't count as one.
const IS_EXPLORED = sql`${messages.usage}->'routingSignals'->'exploration' = 'true'::jsonb`;

// WS7d shadow mode. A turn carries `routingSignals.shadow` ONLY when a candidate
// policy was configured AND the turn was one the candidate could have moved
// (threshold-immune turns stamp nothing — see routing/shadow.ts). So the
// denominator here is "shadowed turns", never "all routed turns": counting
// unmovable turns as agreement would flatter every candidate.
const IS_SHADOWED = sql`${messages.usage}->'routingSignals'->'shadow' IS NOT NULL`;
const SHADOW_AGREED = sql`${messages.usage}->'routingSignals'->'shadow'->'agreed' = 'true'::jsonb`;
const PROVENANCE = sql`CASE WHEN ${IS_ROUTED} THEN 'routed' WHEN ${IS_PINNED} THEN 'pinned' ELSE 'legacy' END`;

/**
 * Per-conversation assistant turns tagged with the REQUESTED pin and the
 * previous turn's pin, so a mid-conversation model change is one row
 * comparison. `requestedProvider` falls back to the served `provider` column
 * for rows written before that key existed.
 *
 * `->>` yields SQL NULL for both JSON null (a routed turn) and an absent key
 * (a legacy row), so requiring both sides non-null restricts switches to real
 * pin→pin changes and drops legacy rows without a second predicate.
 */
function turnPinsCte(days: number): SQL {
  return sql`
    SELECT
      ${messages.conversationId} AS conversation_id,
      ROW_NUMBER() OVER w AS turn_index,
      ${messages.usage}->>'requestedModel' AS req_model,
      COALESCE(${messages.usage}->>'requestedProvider', ${messages.provider}) AS req_provider,
      LAG(${messages.usage}->>'requestedModel') OVER w AS prev_model,
      LAG(COALESCE(${messages.usage}->>'requestedProvider', ${messages.provider})) OVER w AS prev_provider
    FROM ${messages}
    WHERE ${assistantTurnsSince(days)}
    WINDOW w AS (PARTITION BY ${messages.conversationId} ORDER BY ${messages.createdAt}, ${messages.id})
  `;
}

const COMPARABLE_PAIR = sql`prev_model IS NOT NULL AND req_model IS NOT NULL`;

/**
 * Routing tier of a model IDENTIFIED BY provider + id (the form the DB stores).
 * Composes the two existing single-source-of-truth lookups rather than adding
 * tier math: `resolveModelObject` never throws (it synthesizes a stand-in for
 * an unknown id) and `tierForModel` is the public wrapper over the registry's
 * one `inferTier` heuristic.
 */
function tierForModelId(provider: string, modelId: string): RoutingTier {
  return tierForModel(resolveModelObject(provider, modelId));
}

/** Which way a pin change moved on the ladder, via the exported `strongestTier`
 *  ranking (no second copy of the tier order lives here). */
function switchKind(from: RoutingTier, to: RoutingTier): RoutingSwitchKind {
  if (from === to) return "lateral";
  return strongestTier([from, to]) === to ? "escalation" : "downgrade";
}

/**
 * Routing + cost analytics for the last `days`.
 *
 * Issues its queries SEQUENTIALLY, never via `Promise.all` — same reason the
 * admin analytics route does (see the long comment there): fanned-out pooled
 * connections hold-and-wait deadlock the default Bun.sql pool. Each query here
 * is a single aggregate scan, so the lost parallelism is negligible.
 */
export async function getRoutingStats(days = 30): Promise<RoutingStats> {
  const db = getDb();

  // ── Headline counts: provenance split, failover, conversation reach ──
  const headlineRes = await db.execute(sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE ${IS_ROUTED}) AS routed,
      COUNT(*) FILTER (WHERE ${IS_PINNED}) AS pinned,
      COUNT(*) FILTER (WHERE ${IS_LEGACY}) AS legacy,
      COUNT(*) FILTER (WHERE ${messages.usage}->'failover' = 'true'::jsonb) AS failover,
      COUNT(*) FILTER (WHERE ${IS_EXPLORED}) AS explored,
      COUNT(*) FILTER (WHERE ${IS_SHADOWED}) AS shadowed,
      COUNT(*) FILTER (WHERE ${IS_SHADOWED} AND ${SHADOW_AGREED}) AS shadow_agreed,
      COUNT(DISTINCT ${messages.conversationId}) AS conversations,
      COUNT(DISTINCT ${messages.parentMessageId}) AS answered_turns
    FROM ${messages}
    WHERE ${assistantTurnsSince(days)}
  `);
  const headline = (headlineRes.rows[0] ?? {}) as Record<string, unknown>;
  const routed = aggNum(headline.routed);
  const pinned = aggNum(headline.pinned);
  const provenanceTurns = routed + pinned;
  const failoverCount = aggNum(headline.failover);
  const exploredTurns = aggNum(headline.explored);
  const shadowedTurns = aggNum(headline.shadowed);
  const shadowAgreedTurns = aggNum(headline.shadow_agreed);
  const answeredTurns = aggNum(headline.answered_turns);
  const conversations = aggNum(headline.conversations);

  // ── Tier mix (routed turns are the only ones that stamp a tier) ──
  const tierRes = await db.execute(sql`
    SELECT ${messages.usage}->>'routedTier' AS tier, COUNT(*) AS count
    FROM ${messages}
    WHERE ${assistantTurnsSince(days)} AND jsonb_exists(${messages.usage}, 'routedTier')
    GROUP BY 1
    ORDER BY 2 DESC
  `);
  const tierMix: RoutingTierShare[] = [];
  for (const row of tierRes.rows as Record<string, unknown>[]) {
    // A tier string the current vocabulary doesn't know (a renamed tier in an
    // old row) is DROPPED rather than widened into the union — the mix must
    // stay typed, and an unknown tier is not evidence about a known one.
    if (isRoutingTier(row.tier)) tierMix.push({ tier: row.tier, count: aggNum(row.count) });
  }

  // ── Mid-conversation model switches ──
  const switchAggRes = await db.execute(sql`
    WITH turns AS (${turnPinsCte(days)})
    SELECT
      COUNT(*) FILTER (WHERE ${COMPARABLE_PAIR}) AS pairs,
      COUNT(*) FILTER (WHERE ${COMPARABLE_PAIR} AND prev_model <> req_model) AS switches
    FROM turns
  `);
  const switchAgg = (switchAggRes.rows[0] ?? {}) as Record<string, unknown>;
  const switchPairs = aggNum(switchAgg.pairs);
  const switchTotal = aggNum(switchAgg.switches);

  const switchRes = await db.execute(sql`
    WITH turns AS (${turnPinsCte(days)})
    SELECT conversation_id, turn_index, prev_provider, prev_model, req_provider, req_model
    FROM turns
    WHERE ${COMPARABLE_PAIR} AND prev_model <> req_model
    ORDER BY conversation_id, turn_index
    LIMIT ${ROUTING_SAMPLE_CAP}
  `);
  const switchSamples: RoutingModelSwitch[] = (switchRes.rows as Record<string, unknown>[]).map((r) => {
    const fromProvider = String(r.prev_provider ?? "unknown");
    const fromModel = String(r.prev_model);
    const toProvider = String(r.req_provider ?? "unknown");
    const toModel = String(r.req_model);
    const fromTier = tierForModelId(fromProvider, fromModel);
    const toTier = tierForModelId(toProvider, toModel);
    return {
      conversationId: String(r.conversation_id),
      turnIndex: aggNum(r.turn_index),
      fromProvider,
      fromModel,
      fromTier,
      toProvider,
      toModel,
      toTier,
      kind: switchKind(fromTier, toTier),
    };
  });
  // The kind tallies come from the sample list, so they describe exactly the
  // switches shown. `total` above is the uncapped count; when it exceeds the
  // cap the tallies are a floor, not a contradiction.
  let escalations = 0;
  let downgrades = 0;
  let lateral = 0;
  for (const s of switchSamples) {
    if (s.kind === "escalation") escalations += 1;
    else if (s.kind === "downgrade") downgrades += 1;
    else lateral += 1;
  }

  // ── A/B retries: same-role assistant siblings under one parent ──
  const retryAggRes = await db.execute(sql`
    SELECT
      COUNT(*) AS retried_turns,
      COALESCE(SUM(sibling_count) - COUNT(*), 0) AS extra_siblings
    FROM (
      SELECT COUNT(*) AS sibling_count
      FROM ${messages}
      WHERE ${assistantTurnsSince(days)} AND ${messages.parentMessageId} IS NOT NULL
      GROUP BY ${messages.parentMessageId}
      HAVING COUNT(*) > 1
    ) g
  `);
  const retryAgg = (retryAggRes.rows[0] ?? {}) as Record<string, unknown>;
  const retriedTurns = aggNum(retryAgg.retried_turns);

  const retryRes = await db.execute(sql`
    WITH siblings AS (
      SELECT
        ${messages.id} AS id,
        ${messages.conversationId} AS conversation_id,
        ${messages.parentMessageId} AS parent_message_id,
        ${messages.createdAt} AS created_at
      FROM ${messages}
      WHERE ${assistantTurnsSince(days)} AND ${messages.parentMessageId} IS NOT NULL
    ),
    groups AS (
      SELECT conversation_id, parent_message_id, COUNT(*) AS sibling_count
      FROM siblings
      GROUP BY conversation_id, parent_message_id
      HAVING COUNT(*) > 1
    )
    SELECT
      g.conversation_id,
      g.parent_message_id,
      g.sibling_count,
      (
        -- The sibling the branch CONTINUED THROUGH: the one something was
        -- chained onto. The child lookup is deliberately NOT window-bounded
        -- (the continuation can be newer than the window); newest wins when
        -- the user continued through more than one sibling over time.
        SELECT s.id
        FROM siblings s
        WHERE s.parent_message_id = g.parent_message_id
          AND EXISTS (SELECT 1 FROM ${messages} c WHERE c.parent_message_id = s.id)
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT 1
      ) AS continued_id
    FROM groups g
    ORDER BY g.sibling_count DESC, g.parent_message_id
    LIMIT ${ROUTING_SAMPLE_CAP}
  `);
  const retrySamples: RoutingRetryGroup[] = (retryRes.rows as Record<string, unknown>[]).map((r) => ({
    conversationId: String(r.conversation_id),
    parentMessageId: String(r.parent_message_id),
    siblingCount: aggNum(r.sibling_count),
    continuedThroughMessageId: r.continued_id == null ? null : String(r.continued_id),
  }));

  // ── Priced spend per provider+model+provenance ──
  // Deliberately NOT capped in SQL. Every USD figure below is summed from these
  // rows, so a `LIMIT` here would silently truncate the money numbers rather
  // than a display list — and `ORDER BY turn_count DESC` drops the lowest-
  // VOLUME groups, which are emphatically NOT the lowest-COST ones (a handful
  // of opus turns outweighs thousands of haiku ones). That would understate a
  // figure the UI presents as a TOTAL, breaking this module's stated invariant
  // that every count and rate beside a list is aggregated uncapped.
  //
  // ROUTING_SAMPLE_CAP is a bounded-PAYLOAD rule, so it is applied to the
  // returned `segments` list instead — after the totals are complete. Row count
  // here is bounded by (models actually used × 3 provenances): tens in
  // practice, and hard-bounded by the catalog, so there is no unbounded scan.
  const spendRes = await db.execute(sql`
    SELECT
      ${messages.provider} AS provider,
      ${messages.model} AS model,
      ${PROVENANCE} AS provenance,
      COUNT(*) AS turn_count,
      COALESCE(SUM((${messages.usage}->>'inputTokens')::numeric), 0) AS input,
      COALESCE(SUM((${messages.usage}->>'outputTokens')::numeric), 0) AS output,
      COALESCE(SUM((${messages.usage}->>'cacheReadTokens')::numeric), 0) AS cache_read,
      COALESCE(SUM((${messages.usage}->>'cacheWriteTokens')::numeric), 0) AS cache_write,
      COALESCE(SUM((${messages.usage}->>'cacheWrite1hTokens')::numeric), 0) AS cache_write_1h
    FROM ${messages}
    WHERE ${assistantTurnsSince(days)}
      AND ${messages.usage} IS NOT NULL
      AND ${messages.model} IS NOT NULL
    GROUP BY 1, 2, 3
    ORDER BY 4 DESC
  `);

  const segments: RoutingSpendSegment[] = [];
  let routedUsd = 0;
  let pinnedUsd = 0;
  let legacyUsd = 0;
  let pricedTurns = 0;
  let unpricedTurns = 0;
  let unpricedTokens = 0;
  for (const row of spendRes.rows as Record<string, unknown>[]) {
    const provider = String(row.provider ?? "unknown");
    const model = String(row.model ?? "unknown");
    const raw = String(row.provenance ?? "legacy");
    const provenance: RoutingProvenance =
      raw === "routed" || raw === "pinned" ? raw : "legacy";
    const tokens = {
      input: aggNum(row.input),
      output: aggNum(row.output),
      cacheRead: aggNum(row.cache_read),
      cacheWrite: aggNum(row.cache_write),
      cacheWrite1h: aggNum(row.cache_write_1h),
    };
    const turnCount = aggNum(row.turn_count);
    // WS1 owns every arithmetic decision including "is this priced at all?" —
    // `priceSegment` returns null for an all-zero rate table, which is exactly
    // how an OAuth subscription model arrives.
    const cost = priceSegment(tokens, modelPrices(provider, model));
    if (cost === null) {
      unpricedTurns += turnCount;
      // cacheWrite1h is a SUBSET of cacheWrite — never added in.
      unpricedTokens += tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    } else {
      pricedTurns += turnCount;
      if (provenance === "routed") routedUsd += cost.total;
      else if (provenance === "pinned") pinnedUsd += cost.total;
      else legacyUsd += cost.total;
    }
    segments.push({ provider, model, provenance, turnCount, tokens, cost });
  }
  const totalUsd = routedUsd + pinnedUsd + legacyUsd;

  return {
    days,
    turns: {
      total: aggNum(headline.total),
      routed,
      pinned,
      legacy: aggNum(headline.legacy),
    },
    routedShare: provenanceTurns > 0 ? routed / provenanceTurns : 0,
    tierMix,
    // Over ROUTED turns, not all turns: only a routed turn can be explored, so
    // a pinned-heavy install must not have its exploration share diluted.
    exploration: {
      turns: exploredTurns,
      rate: routed > 0 ? exploredTurns / routed : 0,
    },
    // Agreement is over SHADOWED turns only (see IS_SHADOWED). 0 shadowed turns
    // means shadow mode is off — the panel renders that as "not configured",
    // never as 0% agreement, which would read as a catastrophically bad
    // candidate rather than an absent one.
    shadow: {
      turns: shadowedTurns,
      agreed: shadowAgreedTurns,
      disagreed: shadowedTurns - shadowAgreedTurns,
      agreementRate: shadowedTurns > 0 ? shadowAgreedTurns / shadowedTurns : 0,
    },
    failover: {
      count: failoverCount,
      rate: provenanceTurns > 0 ? failoverCount / provenanceTurns : 0,
    },
    switches: {
      pairs: switchPairs,
      total: switchTotal,
      escalations,
      downgrades,
      lateral,
      rate: switchPairs > 0 ? switchTotal / switchPairs : 0,
      samples: switchSamples,
    },
    retries: {
      answeredTurns,
      retriedTurns,
      extraSiblings: aggNum(retryAgg.extra_siblings),
      rate: answeredTurns > 0 ? retriedTurns / answeredTurns : 0,
      samples: retrySamples,
    },
    spend: {
      // Payload cap applied HERE, not in SQL — the totals above are complete.
      // Rows arrive ordered by turn_count DESC, so this keeps the busiest
      // segments, which is what the panel's table is for.
      segments: segments.slice(0, ROUTING_SAMPLE_CAP),
      segmentsTruncated: segments.length > ROUTING_SAMPLE_CAP,
      routedUsd,
      pinnedUsd,
      legacyUsd,
      totalUsd,
      unpricedTurns,
      unpricedTokens,
      conversations,
      usdPerConversation:
        conversations > 0 && pricedTurns > 0 ? totalUsd / conversations : null,
    },
  };
}
