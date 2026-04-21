import { sql, desc, eq, gte, and, isNotNull, count, countDistinct } from "drizzle-orm";
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
} from "../schema";
import { listErrors } from "./error-logs";

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
    .where(gte(messages.createdAt, sql`NOW() - INTERVAL '${sql.raw(String(days))} days'`))
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
        gte(messages.createdAt, sql`NOW() - INTERVAL '${sql.raw(String(days))} days'`),
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
    .where(gte(errorLogs.createdAt, sql`NOW() - INTERVAL '${sql.raw(String(days))} days'`))
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
