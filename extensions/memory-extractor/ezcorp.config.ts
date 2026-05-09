// Memory-extractor — bundled extension manifest (Phase 53.4 Stage 1).
//
// Ports the legacy host-side memory pipeline (src/memory/extraction.ts +
// src/memory/compaction.ts) onto the SDK capability surfaces. Each
// completed chat run triggers an LLM-driven fact extraction; the
// resulting memories flow through `ctx.memory.write` (audited,
// host-side dedup applied before insert). A 6-hour cron schedule
// triggers compaction via `ctx.invoke("runtime.memory.compact", …)`,
// which delegates to the host's existing decay-and-merge pipeline.
//
// Stage 1 ships alongside the legacy implementation; the parity test
// at `src/__tests__/memory-extractor-port-parity.test.ts` proves both
// pipelines produce identical memory rows (same dedup, same provenance
// classes) before Stage 2 deletes the legacy code.
//
// CROSS-EXTENSION VISIBILITY (`permissions.memory.selfOnly = false`):
// This is the ONLY bundled extension granted `selfOnly: false`. The
// extractor MUST be able to dedup against memories authored by the
// host's pre-existing pipeline (and any future first-party extension
// extracting memories) — without cross-extension visibility, every
// extension would re-extract the same fact and the memory table would
// fill with near-duplicates. User-installed extensions default to
// `selfOnly: true`; this exception is an explicit decision documented
// in tasks/v1.3-phase-53-bundled-extension-ports.md (53.4.1) and
// reviewed at install time via the bundled-trust audit.
//
// `permissions.llm` mirrors `EXTRACTION_MODELS` from the legacy file
// (claude-haiku-4-5-20250514, gpt-4o-mini, gemini-2.0-flash-lite) plus
// Ollama parity with the lessons-distiller (added in Phase 53.1).

import { defineExtension } from "../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "memory-extractor",
  version: "1.0.0",
  description:
    "Extracts durable facts from completed chat runs (preferences, biographical, technical, decisions/goals) and runs a 6-hour compaction sweep.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  // Phase 53.6 — event-only extension; idle-out would silently drop run:complete after 5min
  persistent: true,

  permissions: {
    llm: {
      providers: ["google", "openai", "anthropic", "ollama"],
      maxCallsPerHour: 30,
      maxCallsPerDay: 200,
      // Memory extraction asks the LLM for an array of facts which can
      // be longer than a single lesson; bump from 1024 → 2048 to match
      // the legacy `extractMemories` call shape.
      maxTokensPerCall: 2048,
      allowedModels: {
        google: ["gemini-2.0-flash-lite"],
        openai: ["gpt-4o-mini"],
        anthropic: ["claude-haiku-4-5-20250514"],
        // Mirror the lessons-distiller's Ollama defaults; user-installed
        // models are reachable via the `model` text override.
        ollama: ["gemma4:e2b", "gemma4:latest", "qwen3.6:35b"],
      },
    },
    memory: {
      access: "write",
      categories: ["preferences", "biographical", "technical", "decisions_goals"],
      maxWritesPerDay: 100,
      // INTENTIONAL — see file-leading comment. The only bundled
      // extension allowed cross-extension memory visibility for dedup.
      selfOnly: false,
    },
    eventSubscriptions: ["run:complete"],
    schedule: {
      // v1.4 — manifest declares the full set of legal compaction
      // cadences so the SDK's "manifest must declare the cron" check
      // passes regardless of the user's `compaction_interval_hours`
      // setting. The extension's `index.ts` reads the setting at boot
      // and registers `Schedule.on(<chosen-cron>, ...)` against
      // exactly one of these. Any setting value not in this list
      // falls back to `0 */6 * * *` and logs a warning.
      //
      // Why the small fixed set: spec § Phase 2.2 says "manifest
      // stays declarative as `["0 */<H> * * *"]`" but the SDK
      // silently drops `Schedule.on()` for crons not in the manifest
      // (`packages/@ezcorp/sdk/src/runtime/schedule.ts:36`), and the
      // host's `clampSchedulePermission` slices to 8 max
      // (`src/extensions/clamp-permissions.ts:228`). v1.4 narrows
      // the spec's "integer ≥ 1, ≤ 168" range to the {1, 3, 6, 12,
      // 24} hour set covered by these 5 crons (within the 8-slot
      // cap). Documented in the Phase 2 commit body. Wider cadences
      // can land alongside the v1.5+ live-rescheduling work without
      // a new migration.
      //
      // `maxRunsPerDay: 24` covers the every-1h floor (24 fires/day);
      // bumped from 4 because the user can now opt into hourly
      // sweeps. The `missedRunPolicy: fire-once` semantics still hold
      // — at most one catch-up regardless of cadence.
      crons: [
        "0 */1 * * *",
        "0 */3 * * *",
        "0 */6 * * *",
        "0 */12 * * *",
        "0 0 * * *",
      ],
      maxRunsPerDay: 24,
      missedRunPolicy: "fire-once",
      purpose: "memory compaction sweep",
    },
    storage: true,
  },

  // Tools array intentionally empty — this extension is purely
  // event/cron driven. Compaction is invoked by the schedule daemon;
  // extraction by the run:complete event subscription. There is no
  // user-callable manual entry point in v1.3 (deferred to v1.4).
  tools: [],

  settings: {
    enabled: {
      type: "boolean",
      label: "Enabled",
      description: "Auto-extract memories when a chat run completes.",
      default: true,
    },
    provider: {
      type: "select",
      label: "Model provider",
      description:
        "Which provider to call for the extraction LLM. Falls back to Google if no preference.",
      options: [
        { value: "google", label: "Google" },
        { value: "openai", label: "OpenAI" },
        { value: "anthropic", label: "Anthropic" },
        { value: "ollama", label: "Ollama (local)" },
      ],
      default: "google",
    },
    model: {
      type: "text",
      label: "Model id (override)",
      description:
        "Leave blank to use the provider default (gemini-2.0-flash-lite / gpt-4o-mini / claude-haiku-4-5 / gemma4:e2b for Ollama).",
      default: "",
    },
    compaction_enabled: {
      type: "boolean",
      label: "Run periodic compaction sweep",
      description:
        "Periodically merge similar memories. Disable to skip the cron-driven sweep without disabling extraction.",
      default: true,
    },
    compaction_interval_hours: {
      // v1.4 — surfaces the cadence as a per-extension setting. v1
      // ships a small fixed set; the manifest's declarative cron list
      // covers exactly these values (see comment on
      // `permissions.schedule.crons` above). Wider cadences land in
      // v1.5+ alongside live-rescheduling.
      type: "select",
      label: "Compaction interval (hours)",
      description:
        "How often the memory compaction sweep runs. Changes apply on next host restart — live re-scheduling lands in v1.5+.",
      options: [
        { value: "1", label: "Every hour" },
        { value: "3", label: "Every 3 hours" },
        { value: "6", label: "Every 6 hours (default)" },
        { value: "12", label: "Every 12 hours" },
        { value: "24", label: "Daily" },
      ],
      default: "6",
    },
  },
});
