/**
 * Daily Briefing — config input validation (pure logic, no DB).
 *
 * Consumed by PUT /api/briefing/config. Reuses `validateCron` from
 * src/extensions/cron.ts as-is (5-field expressions, 5-minute minimum
 * interval — DRY with the ScheduleDaemon's validation). Timezone is
 * validated against the runtime's bundled IANA database via Intl.
 *
 * Returns a normalized `BriefingConfigInput` on success so the route
 * never writes un-normalized values (trimmed strings, deduped
 * watchlist) to the DB.
 */
import { validateCron } from "../../extensions/cron";
import type { BriefingConfigInput } from "../../db/queries/briefing-configs";

export const MAX_INSTRUCTIONS_LENGTH = 10_000;
export const MAX_WATCHLIST_TOPICS = 25;
export const MAX_TOPIC_LENGTH = 200;

export type ValidationResult =
  | { ok: true; input: BriefingConfigInput }
  | { ok: false; error: string };

export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== "string" || tz.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function fail(error: string): ValidationResult {
  return { ok: false, error };
}

/**
 * Validate a PUT /api/briefing/config body. Every field is optional
 * (partial update); unknown fields are ignored. `projectId`, `model`,
 * and `provider` accept explicit `null` (= clear the override).
 */
export function validateBriefingConfigInput(raw: unknown): ValidationResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  const input: BriefingConfigInput = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return fail("enabled must be a boolean");
    input.enabled = body.enabled;
  }

  if (body.cron !== undefined) {
    if (typeof body.cron !== "string") return fail("cron must be a string");
    const cron = body.cron.trim();
    const v = validateCron(cron);
    if (!v.ok) return fail(`invalid cron: ${v.reason}`);
    input.cron = cron;
  }

  if (body.timezone !== undefined) {
    if (typeof body.timezone !== "string") return fail("timezone must be a string");
    const tz = body.timezone.trim();
    if (!isValidTimezone(tz)) return fail(`invalid timezone: ${tz || "(empty)"}`);
    input.timezone = tz;
  }

  if (body.projectId !== undefined) {
    if (body.projectId !== null && (typeof body.projectId !== "string" || body.projectId.length === 0)) {
      return fail("projectId must be a non-empty string or null");
    }
    input.projectId = body.projectId as string | null;
  }

  if (body.instructions !== undefined) {
    if (typeof body.instructions !== "string") return fail("instructions must be a string");
    if (body.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      return fail(`instructions too long (max ${MAX_INSTRUCTIONS_LENGTH} chars)`);
    }
    input.instructions = body.instructions;
  }

  if (body.watchlist !== undefined) {
    if (!Array.isArray(body.watchlist)) return fail("watchlist must be an array");
    if (body.watchlist.length > MAX_WATCHLIST_TOPICS) {
      return fail(`watchlist too long (max ${MAX_WATCHLIST_TOPICS} topics)`);
    }
    const seen = new Set<string>();
    const normalized: Array<{ topic: string; addedAt: string }> = [];
    for (const entry of body.watchlist) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return fail("watchlist entries must be objects with a topic");
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.topic !== "string" || e.topic.trim().length === 0) {
        return fail("watchlist entries must carry a non-empty topic string");
      }
      const topic = e.topic.trim();
      if (topic.length > MAX_TOPIC_LENGTH) {
        return fail(`watchlist topic too long (max ${MAX_TOPIC_LENGTH} chars)`);
      }
      const key = topic.toLowerCase();
      if (seen.has(key)) continue; // dedupe silently
      seen.add(key);
      const addedAt = typeof e.addedAt === "string" && !Number.isNaN(Date.parse(e.addedAt))
        ? e.addedAt
        : new Date().toISOString();
      normalized.push({ topic, addedAt });
    }
    input.watchlist = normalized;
  }

  for (const key of ["model", "provider"] as const) {
    if (body[key] !== undefined) {
      if (body[key] !== null && (typeof body[key] !== "string" || (body[key] as string).trim().length === 0)) {
        return fail(`${key} must be a non-empty string or null`);
      }
      input[key] = body[key] === null ? null : (body[key] as string).trim();
    }
  }

  return { ok: true, input };
}
