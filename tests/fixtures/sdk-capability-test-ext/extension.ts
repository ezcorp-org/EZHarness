/**
 * Phase 51 integration fixture — minimal stubs exercising all five
 * SDK capability surfaces so the cross-capability test has a real
 * on-disk extension to point at (spec § 51.6.1).
 *
 * Phase 53 will repurpose this as the lessons-distiller / memory-
 * extractor port reference. Today the body is intentionally minimal:
 * each handler does one operation against its capability, returns,
 * and that's the whole contract.
 *
 * The host loads `manifest.json`; this `extension.ts` is the
 * subprocess entrypoint. The integration test still inlines mocked
 * grants — the fixture exists so spec § 51.6.1's "real on-disk
 * fixture" requirement is satisfied literally.
 */

import { Llm, Memory, Lessons, Schedule } from "@ezcorp/sdk/runtime";

const llm = new Llm();
const memory = new Memory();
const lessons = new Lessons();
const schedule = new Schedule();

/** Stub: invoke ctx.llm.complete() once. */
export async function callLlm(): Promise<{ content: string }> {
  const r = await llm.complete({
    provider: "anthropic",
    model: "claude-sonnet-4",
    messages: [{ role: "user", content: "fixture: noop" }],
    maxTokens: 32,
  });
  return { content: r.content };
}

/** Stub: write one memory. */
export async function writeMemory(): Promise<{ memoryId: string }> {
  const m = await memory.write({
    content: "fixture-memory",
    category: "technical",
  });
  return { memoryId: m.id };
}

/** Stub: write one lesson. */
export async function writeLesson(projectId: string): Promise<{ lessonId: string | null; created: boolean }> {
  const r = await lessons.write({
    slug: "fixture-lesson",
    title: "Fixture",
    body: "Fixture body",
    projectId,
  });
  return { lessonId: r.lesson?.id ?? null, created: r.created };
}

/** Stub: register a no-op handler for the manifest-declared cron.
 *  The integration test invokes via fireNow. */
schedule.on("*/5 * * * *", async () => {
  // No-op body; the test only asserts the audit trail.
});

/** Stub: fire the declared cron immediately. */
export async function fireScheduleNow(): Promise<void> {
  await schedule.fireNow("*/5 * * * *");
}
