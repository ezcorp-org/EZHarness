/**
 * Savings-analytics queries (analytics workstream C1).
 *
 * Pulls assistant turns in range (messages ⋈ conversations for scope), prices
 * each row from the pi-ai model registry, and delegates ALL math to the pure
 * `src/runtime/usage/savings.ts` module. Both public entry points issue ONE
 * message select plus a handful of sequential settings reads — never fan out
 * with Promise.all (PGlite/Bun.sql pool hold-and-wait deadlock; see the
 * comment in web/src/routes/api/admin/analytics/+server.ts).
 *
 * Legacy tolerance: rows whose usage predates the cache meter / routing
 * provenance pass through with missing fields (⇒ 0 tokens, excluded from
 * hit-rate — the pure module owns that rule).
 *
 * SUBSCRIPTION CAVEAT: credential auth-type is NOT persisted per message, so
 * `subscriptionProviders` reflects the CURRENT credential configuration of
 * each distinct served provider at query time — not what was in effect when a
 * historical turn ran. Detection mirrors the default resolution chain in
 * src/providers/credentials.ts without touching tokens or the network:
 * OAuth-native provider ids are always subscription; an explicit
 * `provider:accessMode:<p>` preference decides directly; otherwise stored
 * OAuth credentials (`provider:oauth:<p>`) mean the default chain resolves
 * OAuth first ⇒ subscription-billed.
 */

import { and, eq, gte, type SQL } from "drizzle-orm";
import { getModel, type KnownProvider } from "@earendil-works/pi-ai";
import { getDb } from "../connection";
import { conversations, messages } from "../schema";
import { nowMinusInterval } from "./sql-interval";
import { getSetting } from "./settings";
import { findModelForProviderInTier } from "../../providers/registry";
import {
  aggregateSavings,
  type ModelCostLike,
  type PerModelSavings,
  type SavingsStats,
  type SavingsTurnInput,
} from "../../runtime/usage/savings";

/** Full response contract for both savings endpoints (C2 renders this). */
export interface SavingsReport {
  rangeDays: number;
  stats: SavingsStats;
  perModel: PerModelSavings[];
  /** Served providers whose $ figures are "not billed (subscription)". */
  subscriptionProviders: string[];
  /** $ figures are always estimates (registry prices × persisted tokens). */
  estimated: true;
}

/**
 * Pricing/credential lookups, injectable so tests can pin deterministic
 * prices without mocking the pi-ai registry. Production callers use
 * {@link defaultSavingsDeps}.
 */
export interface SavingsPricingDeps {
  /** $/1M cost of a SERVED provider+model, or null when unknown. */
  getModelCost(provider: string, model: string): ModelCostLike | null;
  /** $/1M cost of the balanced-tier counterfactual for a provider. */
  getCounterfactualCost(provider: string): ModelCostLike | null;
  /** Whether a provider's CURRENT credential is subscription-billed. */
  isSubscriptionProvider(provider: string): Promise<boolean>;
}

function realGetModelCost(provider: string, model: string): ModelCostLike | null {
  // pi-ai getModel is a pure Map lookup — undefined for unknown ids.
  return getModel(provider as KnownProvider, model as never)?.cost ?? null;
}

function realGetCounterfactualCost(provider: string): ModelCostLike | null {
  const entry = findModelForProviderInTier(provider, "balanced");
  if (!entry) return null;
  return realGetModelCost(provider, entry.id);
}

// Provider ids that ONLY exist behind a pi-managed OAuth (subscription) login.
const OAUTH_NATIVE_PROVIDERS = new Set(["openai-codex", "google-gemini-cli"]);

async function realIsSubscriptionProvider(provider: string): Promise<boolean> {
  if (OAUTH_NATIVE_PROVIDERS.has(provider)) return true;
  const mode = await getSetting(`provider:accessMode:${provider}`);
  if (mode === "oauth") return true;
  if (mode === "apikey") return false;
  // Default chain (credentials.ts getCredential): stored DB-OAuth creds are
  // tried before BYOK, so their presence means turns bill to the subscription.
  const oauth = await getSetting(`provider:oauth:${provider}`);
  return typeof oauth === "string" && oauth.length > 0;
}

export const defaultSavingsDeps: SavingsPricingDeps = {
  getModelCost: realGetModelCost,
  getCounterfactualCost: realGetCounterfactualCost,
  isSubscriptionProvider: realIsSubscriptionProvider,
};

type MessageUsage = NonNullable<(typeof messages.$inferSelect)["usage"]>;

type UsageRow = {
  provider: string | null;
  model: string | null;
  usage: (typeof messages.$inferSelect)["usage"];
};

function turnFromRow(
  row: UsageRow,
  deps: SavingsPricingDeps,
  costMemo: Map<string, ModelCostLike | null>,
  counterfactualMemo: Map<string, ModelCostLike | null>,
): SavingsTurnInput {
  const provider = row.provider ?? "unknown";
  const model = row.model ?? "unknown";
  // Legacy/null-usage rows flow through as all-undefined fields (⇒ 0 tokens,
  // hit-rate-ineligible — the pure module owns those rules).
  const u: Partial<MessageUsage> = row.usage ?? {};

  const costKey = JSON.stringify([provider, model]);
  let servedCost = costMemo.get(costKey);
  if (servedCost === undefined) {
    servedCost = deps.getModelCost(provider, model);
    costMemo.set(costKey, servedCost);
  }

  // Routed = no user pin (explicit null) AND the router recorded a tier —
  // only these rows need (and get) a counterfactual lookup.
  const routed = u.requestedModel === null && u.routedTier !== undefined;
  let counterfactualCost: ModelCostLike | null = null;
  if (routed) {
    let cf = counterfactualMemo.get(provider);
    if (cf === undefined) {
      cf = deps.getCounterfactualCost(provider);
      counterfactualMemo.set(provider, cf);
    }
    counterfactualCost = cf;
  }

  return {
    provider,
    model,
    usage: {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      cacheWrite1hTokens: u.cacheWrite1hTokens,
      cacheHitRate: u.cacheHitRate,
    },
    requestedModel: u.requestedModel,
    routedTier: u.routedTier,
    failover: u.failover === true,
    servedCost,
    counterfactualCost,
  };
}

async function computeSavingsReport(
  scope: SQL,
  days: number,
  deps: SavingsPricingDeps,
): Promise<SavingsReport> {
  const db = getDb();
  const rows: UsageRow[] = await db
    .select({
      provider: messages.provider,
      model: messages.model,
      usage: messages.usage,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(messages.role, "assistant"),
        scope,
        gte(messages.createdAt, nowMinusInterval(days, "days")),
      ),
    );

  const costMemo = new Map<string, ModelCostLike | null>();
  const counterfactualMemo = new Map<string, ModelCostLike | null>();
  const turns = rows.map((r) => turnFromRow(r, deps, costMemo, counterfactualMemo));
  const { stats, perModel } = aggregateSavings(turns);

  // Distinct SERVED providers, resolved SEQUENTIALLY (pool discipline).
  const distinctProviders = [
    ...new Set(rows.map((r) => r.provider).filter((p): p is string => p !== null)),
  ].sort();
  const subscriptionProviders: string[] = [];
  for (const provider of distinctProviders) {
    if (await deps.isSubscriptionProvider(provider)) subscriptionProviders.push(provider);
  }

  return { rangeDays: days, stats, perModel, subscriptionProviders, estimated: true };
}

/** Savings across ALL of a user's conversations (any project), last `days`. */
export async function getSavingsForUser(
  userId: string,
  days = 30,
  deps: SavingsPricingDeps = defaultSavingsDeps,
): Promise<SavingsReport> {
  return computeSavingsReport(eq(conversations.userId, userId), days, deps);
}

/**
 * Savings across a project's conversations, last `days`. When
 * `scopeToUserId` is set (non-admin callers), the aggregate covers ONLY that
 * user's conversations within the project — members never see other users'
 * spend (mirrors the memories-list scoping precedent).
 */
export async function getSavingsForProject(
  projectId: string,
  days = 30,
  scopeToUserId?: string,
  deps: SavingsPricingDeps = defaultSavingsDeps,
): Promise<SavingsReport> {
  const scope = scopeToUserId
    ? and(eq(conversations.projectId, projectId), eq(conversations.userId, scopeToUserId))!
    : eq(conversations.projectId, projectId);
  return computeSavingsReport(scope, days, deps);
}
