import { getSetting, upsertSetting } from "$server/db/queries/settings";

const DEFAULT_LIMITS: Record<string, number> = {
  dailyTokens: 100_000,
  maxConversations: 500,
  maxMemories: 10_000,
  maxKnowledgeBase: 100,
};

interface BudgetResult {
  allowed: boolean;
  resetsAt?: string;
}

interface QuotaResult {
  allowed: boolean;
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

export async function checkTokenBudget(userId: string): Promise<BudgetResult> {
  const key = `usage:tokens:${userId}:${today()}`;
  const used = ((await getSetting(key)) as number) ?? 0;
  const limit = ((await getSetting("limits:dailyTokens")) as number) ?? DEFAULT_LIMITS.dailyTokens;

  if (used < limit) return { allowed: true };

  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return { allowed: false, resetsAt: tomorrow.toISOString() };
}

export async function recordTokenUsage(userId: string, tokens: number): Promise<void> {
  const key = `usage:tokens:${userId}:${today()}`;
  const current = ((await getSetting(key)) as number) ?? 0;
  await upsertSetting(key, current + tokens);
}

export async function checkStorageQuota(
  userId: string,
  resource: "Conversations" | "Memories" | "KnowledgeBase",
  currentCount: number,
): Promise<QuotaResult> {
  const limitKey = `limits:max${resource}`;
  const limit = ((await getSetting(limitKey)) as number) ?? DEFAULT_LIMITS[`max${resource}`];
  return { allowed: currentCount <= limit };
}
