#!/usr/bin/env bun
/**
 * Phase 52 UAT seeder — drops realistic audit rows so the new
 * audit pages have data to render.
 *
 * Usage:
 *   bun run scripts/seed-phase52-uat.ts
 *
 * Idempotent: deletes rows tagged with `seed-phase52-uat:*` before
 * inserting, so it's safe to re-run.
 *
 * Pages to UAT after running:
 *   /extensions                                     (Built-ins / Installed tabs)
 *   /extensions/seed-uat-bundled/audit              (per-extension drill-down)
 *   /extensions/seed-uat-installed/audit            (denial filter shows red rows)
 *   /audit                                          (admin global feed + 24h stats)
 *   /project/<projectId>/chat/<conversationId>/audit (per-conv timeline)
 *
 * The seeded extensions are flagged `kind: "local"` and have no real
 * subprocess on disk — they exist purely to satisfy the FK so audit
 * rows can attach. Delete the `extensions` rows manually if you want
 * the cards to disappear from /extensions.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/connection";
import {
  extensions,
  sdkCapabilityCalls,
  auditLog,
  messages,
} from "../src/db/schema";
import { EXT_AUDIT_ACTIONS } from "../src/extensions/audit-actions";

const BUNDLED_ID = "seed-uat-bundled";
const INSTALLED_ID = "seed-uat-installed";
const SEED_TAG = "seed-phase52-uat";

// Pick a real user + project + conversation if any exist; otherwise fall
// back to placeholder ids so the rows don't FK-fail. Audit rows tolerate
// `conversationId` being a string that doesn't resolve — the per-conv
// page just renders an empty header.
async function pickAnchorIds() {
  const db = getDb();
  const users = await db.execute(sql`SELECT id FROM users LIMIT 1`);
  const projects = await db.execute(sql`SELECT id FROM projects LIMIT 1`);
  const convs = await db.execute(sql`SELECT id, project_id FROM conversations LIMIT 1`);

  const userId = (users.rows[0]?.id as string) ?? "00000000-0000-0000-0000-000000000000";
  const conv = convs.rows[0] as { id: string; project_id: string } | undefined;
  const conversationId = conv?.id ?? null;
  const projectId = conv?.project_id ?? (projects.rows[0]?.id as string) ?? null;
  return { userId, conversationId, projectId };
}

async function clearOldSeed() {
  const db = getDb();
  await db.execute(sql`DELETE FROM sdk_capability_calls WHERE extension_id IN (${BUNDLED_ID}, ${INSTALLED_ID})`);
  await db.execute(sql`DELETE FROM audit_log WHERE target IN (${BUNDLED_ID}, ${INSTALLED_ID})`);
  await db.execute(sql`DELETE FROM messages WHERE metadata->>'seedTag' = ${SEED_TAG}`);
  await db.execute(sql`DELETE FROM extensions WHERE id IN (${BUNDLED_ID}, ${INSTALLED_ID})`);
}

async function ensureExtensionRows() {
  const db = getDb();
  const now = new Date();
  await db.insert(extensions).values([
    {
      id: BUNDLED_ID,
      name: "seed-uat-bundled",
      version: "1.0.0",
      installPath: "/dev/null/seed-uat-bundled",
      manifestJson: { name: "seed-uat-bundled", version: "1.0.0", schemaVersion: 2 },
      grantedPermissions: { llm: { allowedProviders: ["anthropic"], allowedModels: ["claude-3-*"] }, memory: { selfOnly: true } },
      enabled: true,
      isBundled: true,
      installedAt: now,
      updatedAt: now,
    },
    {
      id: INSTALLED_ID,
      name: "seed-uat-installed",
      version: "0.1.0",
      installPath: "/dev/null/seed-uat-installed",
      manifestJson: { name: "seed-uat-installed", version: "0.1.0", schemaVersion: 2 },
      grantedPermissions: { llm: { allowedProviders: ["openai"], allowedModels: ["gpt-4o-mini"] }, memory: { selfOnly: true } },
      enabled: true,
      isBundled: false,
      installedAt: now,
      updatedAt: now,
    },
  ]);
}

interface SeedRow {
  extensionId: string;
  capability: "llm" | "memory" | "lessons" | "schedule" | "events";
  action: string;
  success: boolean;
  durationMs: number;
  tokensUsed?: number;
  costUsd?: number;
  provider?: string;
  model?: string;
  resourceType?: string;
  resourceId?: string;
  errorCode?: string;
  errorMessage?: string;
  before?: unknown;
  after?: unknown;
  minutesAgo: number;
}

const SEED_ROWS: SeedRow[] = [
  // Bundled extension — happy LLM calls
  { extensionId: BUNDLED_ID, capability: "llm", action: "complete", success: true, durationMs: 845, tokensUsed: 1200, costUsd: 0.003, provider: "anthropic", model: "claude-3-haiku", minutesAgo: 5 },
  { extensionId: BUNDLED_ID, capability: "llm", action: "complete", success: true, durationMs: 1230, tokensUsed: 2400, costUsd: 0.012, provider: "anthropic", model: "claude-3-sonnet", minutesAgo: 14 },
  { extensionId: BUNDLED_ID, capability: "llm", action: "complete", success: true, durationMs: 720, tokensUsed: 800, costUsd: 0.002, provider: "anthropic", model: "claude-3-haiku", minutesAgo: 22 },

  // Bundled — memory writes (with safe before/after)
  { extensionId: BUNDLED_ID, capability: "memory", action: "write", success: true, durationMs: 12, resourceType: "memory", resourceId: "mem-uat-1", before: null, after: { content: "User prefers terse responses", category: "preferences" }, minutesAgo: 8 },
  { extensionId: BUNDLED_ID, capability: "memory", action: "read", success: true, durationMs: 3, resourceType: "memory", resourceId: "mem-uat-1", minutesAgo: 7 },

  // Bundled — schedule registration
  { extensionId: BUNDLED_ID, capability: "schedule", action: "register", success: true, durationMs: 5, resourceType: "schedule", resourceId: "sched-daily-digest", after: { cron: "0 9 * * *", maxRunsPerDay: 1 }, minutesAgo: 60 },
  { extensionId: BUNDLED_ID, capability: "schedule", action: "fire", success: true, durationMs: 1100, resourceType: "schedule", resourceId: "sched-daily-digest", minutesAgo: 30 },

  // Installed extension — mix of success + denials (so denial filter has data)
  { extensionId: INSTALLED_ID, capability: "llm", action: "complete", success: true, durationMs: 2100, tokensUsed: 4500, costUsd: 0.027, provider: "openai", model: "gpt-4o-mini", minutesAgo: 3 },
  { extensionId: INSTALLED_ID, capability: "llm", action: "complete", success: false, durationMs: 18, errorCode: "LLM_PROVIDER_NOT_GRANTED", errorMessage: "provider 'cohere' is not in allowedProviders", provider: "cohere", model: "command-r", minutesAgo: 11 },
  { extensionId: INSTALLED_ID, capability: "llm", action: "complete", success: false, durationMs: 12, errorCode: "LLM_QUOTA_EXCEEDED", errorMessage: "calls-per-hour quota exceeded", provider: "openai", model: "gpt-4o-mini", minutesAgo: 18 },
  { extensionId: INSTALLED_ID, capability: "memory", action: "write", success: false, durationMs: 8, errorCode: "MEMORY_SCOPE_DENIED", errorMessage: "selfOnly extension cannot write cross-extension memory", resourceType: "memory", minutesAgo: 25 },

  // Installed — events (sampled delivery)
  { extensionId: INSTALLED_ID, capability: "events", action: "subscribe", success: true, durationMs: 4, resourceType: "event", resourceId: "task.completed", minutesAgo: 90 },
];

async function seed() {
  const { userId, conversationId } = await pickAnchorIds();
  console.log(`Anchoring on user=${userId} conversation=${conversationId ?? "(none)"}`);

  await clearOldSeed();
  await ensureExtensionRows();

  const db = getDb();
  const now = Date.now();

  for (const row of SEED_ROWS) {
    const createdAt = new Date(now - row.minutesAgo * 60_000);
    await db.insert(sdkCapabilityCalls).values({
      extensionId: row.extensionId,
      onBehalfOf: userId,
      conversationId,
      capability: row.capability,
      action: row.action,
      resourceType: row.resourceType ?? null,
      resourceId: row.resourceId ?? null,
      before: row.before ?? null,
      after: row.after ?? null,
      success: row.success,
      durationMs: row.durationMs,
      errorCode: row.errorCode ?? null,
      errorMessage: row.errorMessage ?? null,
      tokensUsed: row.tokensUsed ?? null,
      costUsd: row.costUsd ?? null,
      provider: row.provider ?? null,
      model: row.model ?? null,
      createdAt,
    });
  }

  // Add a couple of governance audit-log rows so the global /audit feed
  // has mixed-source content (capability rows + governance rows).
  await db.insert(auditLog).values([
    {
      action: EXT_AUDIT_ACTIONS.PERMISSION_GRANTED,
      target: BUNDLED_ID,
      actor: userId,
      metadata: {
        extensionName: "seed-uat-bundled",
        permission: "llm",
        oldValue: null,
        newValue: { allowedProviders: ["anthropic"] },
      },
      createdAt: new Date(now - 120 * 60_000),
    },
    {
      action: EXT_AUDIT_ACTIONS.PERMISSION_REJECTED,
      target: INSTALLED_ID,
      actor: userId,
      metadata: {
        extensionName: "seed-uat-installed",
        permission: "shell",
        reason: "manifest does not declare shell",
      },
      createdAt: new Date(now - 45 * 60_000),
    },
  ]);

  // Insert a capability-event message so the in-chat pill renders, if a
  // conversation exists.
  if (conversationId) {
    const sdkRow = (await db
      .select({ id: sdkCapabilityCalls.id })
      .from(sdkCapabilityCalls)
      .where(sql`extension_id = ${BUNDLED_ID} AND capability = 'llm'`)
      .limit(1))[0];
    if (sdkRow) {
      await db.insert(messages).values({
        conversationId,
        role: "capability-event" as const,
        content: "",
        metadata: {
          seedTag: SEED_TAG,
          sdkCapabilityCallId: sdkRow.id,
          extensionId: BUNDLED_ID,
          extensionName: "seed-uat-bundled",
          capability: "llm",
          action: "complete",
          tokensUsed: 1200,
          costUsd: 0.003,
        },
        createdAt: new Date(now - 5 * 60_000),
      });
    }
  }

  console.log(`Seeded ${SEED_ROWS.length} sdk_capability_calls + 2 audit_log rows.`);
  console.log(`Bundled extension id: ${BUNDLED_ID}`);
  console.log(`Installed extension id: ${INSTALLED_ID}`);
  console.log("");
  console.log("UAT walkthrough:");
  console.log("  1. /extensions                                          → see Built-ins + Installed tabs");
  console.log(`  2. /extensions/${BUNDLED_ID}/audit                  → 7 happy rows, no red`);
  console.log(`  3. /extensions/${INSTALLED_ID}/audit                → mix of green + red; click "Denials" filter`);
  console.log("  4. /audit                                               → admin feed + 24h stats strip");
  if (conversationId) {
    console.log(`  5. open the seeded conversation                          → capability-event pill should render`);
  }
}

await seed();
process.exit(0);
