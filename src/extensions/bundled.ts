/**
 * Bundled extensions — auto-installed on first startup.
 */

import type { ExtensionManifestV2, ExtensionPermissions } from "./types";
import { getExtensionByName, updateExtension } from "../db/queries/extensions";
import { installFromLocal } from "./installer";
import { loadManifestFresh } from "./loader";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS, type ExtensionAuditMetadata } from "./audit-actions";
import { clampToBundledCeiling, getCeiling } from "./bundled-ceiling";
import { canonicalizeAndHash, verifyManifestAgainstLock } from "./bundled-lock";
import { join, dirname } from "node:path";
import { logger } from "../logger";
const log = logger.child("extensions");
import { fileURLToPath } from "node:url";

interface BundledExtension {
  name: string;
  path: string;
  permissions: ExtensionPermissions;
}

/** Resolve project root — works in both direct Bun execution and SvelteKit bundled contexts. */
function getProjectRoot(): string {
  // import.meta.dir is reliable in direct Bun execution
  if (typeof import.meta.dir === "string" && import.meta.dir.includes("src/extensions")) {
    return join(import.meta.dir, "..", "..");
  }
  // Fallback: use import.meta.url for ESM contexts
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const thisDir = dirname(thisFile);
    if (thisDir.includes("src/extensions")) {
      return join(thisDir, "..", "..");
    }
  } catch { /* not a file URL */ }
  // Final fallback: process.cwd() (assumes server runs from project root)
  return process.cwd();
}

const BUNDLED_EXTENSIONS: BundledExtension[] = [
  {
    // Ephemeral conversation-scoped KV store, converted from the built-in
    // tool formerly at src/runtime/tools/scratchpad.ts. Auto-wired into
    // a conversation by src/runtime/executor.ts when agents are mentioned
    // at depth 0 — see the S7 security gate in that call site.
    name: "scratchpad",
    path: "docs/extensions/examples/scratchpad",
    permissions: { storage: true, grantedAt: { storage: Date.now() } },
  },
  {
    // Multi-task planning and sub-agent coordination. Converted from the
    // built-in tool formerly at src/runtime/tools/task-tracking.ts in
    // Phase 3. Wire-on-first-use via task-tracking-host.ensureTaskTrackingWired —
    // no per-conversation wiring happens at install time.
    name: "task-tracking",
    path: "docs/extensions/examples/task-tracking",
    permissions: {
      storage: true,
      taskEvents: true,
      agentConfig: "read",
      spawnAgents: { maxPerHour: 200, maxConcurrent: 10 },
      eventSubscriptions: ["task:assignment_update"],
      grantedAt: {
        storage: Date.now(),
        taskEvents: Date.now(),
        agentConfig: Date.now(),
        spawnAgents: Date.now(),
        eventSubscriptions: Date.now(),
      },
    },
  },
  {
    // Multi-agent orchestration primitives — provides `invoke_agent`
    // for delegating to a sub-agent within a conversation. Phase 4
    // ported `invoke_agent` from the legacy built-in; Phase 2 of the
    // ask-user migration removed the `ask_human` tool that briefly
    // shipped alongside it (the bundled `ask-user` extension owns
    // human-in-the-loop now).
    // Wire-on-first-use via orchestration-host.ensureOrchestrationWired
    // — no per-conversation wiring happens at install time. As of
    // commit 5 the executor invokes this extension exclusively; no
    // dual-wired path.
    //
    // Migration note: dropping `orchestrator:human_response` from the
    // declared `eventSubscriptions` is a SHRINK, not a widening — the
    // S9 re-approval gate in `detectVersionBumpRequiringReapproval`
    // only checks `[network, filesystem, shell, env, storage,
    // lifecycleHooks]`, so existing installs are NOT auto-disabled.
    // The DB-stored grant retains the old `orchestrator:human_response`
    // entry until the next clean re-install, which is harmless because
    // the extension's subprocess no longer subscribes to that event.
    name: "orchestration",
    path: "docs/extensions/examples/orchestration",
    permissions: {
      agentConfig: "read",
      spawnAgents: { maxPerHour: 500, maxConcurrent: 25 },
      // `task:assignment_update` — required by `invoke_agent`'s two-hop
      //   bridge (Phase 4).
      eventSubscriptions: ["task:assignment_update"],
      grantedAt: {
        agentConfig: Date.now(),
        spawnAgents: Date.now(),
        eventSubscriptions: Date.now(),
      },
    },
  },
  {
    // Bundled human-in-the-loop tool. Provides `ask_user_question` —
    // the LLM-facing surface for pausing a run to ask the user a
    // question (free-text or multiple-choice). Auto-wired on every
    // turn by `src/runtime/stream-chat/setup-tools.ts` so it's always
    // available (the LLM cannot bootstrap a tool that requires its
    // own use to be wired). Subscribes to `ask-user:answer` so the
    // POST endpoint at `/api/ask-user/answer` can resolve the
    // pending-answer gate.
    name: "ask-user",
    path: "docs/extensions/examples/ask-user",
    permissions: {
      eventSubscriptions: ["ask-user:answer"],
      grantedAt: { eventSubscriptions: Date.now() },
    },
  },
  {
    name: "project-analyzer",
    path: "docs/extensions/examples/project-analyzer",
    permissions: { filesystem: ["$CWD"], shell: true, grantedAt: {} },
  },
  {
    name: "markdown-utils",
    path: "docs/extensions/examples/markdown-utils",
    permissions: { grantedAt: {} },
  },
  {
    name: "code-review-delegator",
    path: "docs/extensions/examples/code-review-delegator",
    permissions: { grantedAt: {} },
  },
  {
    name: "github-stats",
    path: "docs/extensions/examples/github-stats",
    permissions: { grantedAt: {} },
  },
  {
    name: "multi-agent-orchestrator",
    path: "docs/extensions/examples/multi-agent-orchestrator",
    permissions: { grantedAt: {} },
  },
  {
    name: "research-agent",
    path: "docs/extensions/examples/research-agent",
    permissions: { grantedAt: {} },
  },
  {
    name: "file-refactor",
    path: "docs/extensions/examples/file-refactor",
    permissions: { filesystem: ["$CWD"], shell: false, grantedAt: {} },
  },
  {
    name: "log-analyzer",
    path: "docs/extensions/examples/log-analyzer",
    permissions: { filesystem: ["$CWD"], shell: false, grantedAt: {} },
  },
  {
    name: "todo-tracker",
    path: "docs/extensions/examples/todo-tracker",
    permissions: { filesystem: ["$CWD"], shell: true, grantedAt: {} },
  },
  {
    name: "task-stack",
    path: "docs/extensions/examples/task-stack",
    permissions: { filesystem: ["$CWD"], shell: false, grantedAt: {} },
  },
  {
    name: "ai-kit",
    path: "packages/@ezcorp/ai-kit",
    permissions: {
      network: ["localhost", "127.0.0.1"],
      filesystem: ["$CWD"],
      env: ["EZCORP_BASE_URL", "EZCORP_API_KEY", "EZCORP_SESSION_COOKIE"],
      grantedAt: { network: Date.now(), filesystem: Date.now(), env: Date.now() },
    },
  },
  {
    name: "web-search",
    path: "docs/extensions/examples/web-search",
    permissions: {
      network: [
        "r.jina.ai",
        "s.jina.ai",
        "api.tavily.com",
        "api.search.brave.com",
        "api.exa.ai",
        "serpapi.com",
      ],
      env: [
        "TAVILY_API_KEY",
        "BRAVE_API_KEY",
        "EXA_API_KEY",
        "SERPAPI_API_KEY",
        "JINA_API_KEY",
      ],
      grantedAt: { network: Date.now(), env: Date.now() },
    },
  },
  {
    // OpenAI-only image generation (gpt-image-* models). Returns base64
    // images as data:image/ URIs so the markdown pipeline renders them
    // inline. `api.openai.com` is the ONLY external host; no filesystem
    // or shell. Credentials come from OPENAI_API_KEY (sk-...) or
    // OPENAI_ACCESS_TOKEN (OAuth bearer) — the extension refuses to run
    // without one.
    name: "openai-image-gen-2",
    path: "docs/extensions/examples/openai-image-gen-2",
    permissions: {
      network: ["api.openai.com", "chatgpt.com"],
      env: ["OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN"],
      // Grant $CWD so the extension can write generated images under
      // <projectRoot>/.ezcorp/extension-data/openai-image-gen-2/. The
      // bytes are served back to the UI via /api/ext-files/... so the
      // tool result stays small (URL, not base64).
      filesystem: ["$CWD"],
      grantedAt: { network: Date.now(), env: Date.now(), filesystem: Date.now() },
    },
  },
  {
    // Property Intelligence Agent — analyzes a commercial real-estate
    // portfolio (leases, AR, GL, budgets, work orders, loans, CAM recs,
    // compliance) and surfaces dollar-quantified risks + opportunities
    // with drafted follow-ups. Reads 10 bundled CSVs under ./data and
    // regenerates them in place via the `regenerate-data` tool — hence
    // the `filesystem: ["$CWD"]` grant. No network, no shell.
    name: "property-intelligence-agent",
    path: "docs/extensions/examples/property-intelligence-agent",
    permissions: {
      filesystem: ["$CWD"],
      grantedAt: { filesystem: Date.now() },
    },
  },
  {
    // claude-design — first consumer of the @ezcorp/sdk canvas primitives
    // (Phase B of the design-extension SDK initiative). Reads the project
    // codebase to extract a design system, generates HTML drafts honoring
    // it, and supports knob-based refinement via the canvas card.
    //
    // Subscribes to `claude-design:knob-change` so the canvas's knob
    // sliders can round-trip back into `tweak-design`. The grant MUST
    // be present for the generic `/api/extensions/claude-design/events/
    // knob-change` route to clear the manifest-clamp gate at boot
    // (Phase A2: pattern-matched event allowlist).
    name: "claude-design",
    path: "docs/extensions/examples/claude-design",
    permissions: {
      filesystem: ["$CWD"],
      storage: true,
      eventSubscriptions: [
        "claude-design:knob-change",
        "claude-design:brief-answer",
      ],
      network: ["cdn.jsdelivr.net"],
      grantedAt: {
        filesystem: Date.now(),
        storage: Date.now(),
        eventSubscriptions: Date.now(),
        network: Date.now(),
      },
    },
  },
  {
    // excel — first consumer of `acceptedAttachmentMimes`. Lets users
    // drag a `.xlsx` workbook into chat; the host emits a handle-only
    // `<file>` reference into the prompt and this extension's
    // `read-spreadsheet` tool fetches sheets/ranges on demand. Pure
    // in-process parser (ExcelJS); no network, filesystem, or shell.
    name: "excel",
    path: "docs/extensions/examples/excel",
    permissions: { grantedAt: {} },
  },
  {
    // In-browser Kokoro-TTS. Adds a speaker icon to the per-message
    // action toolbar via the `messageToolbar` extension point. Click
    // sends a `kokoro-tts:speak` event; the subprocess responds with
    // an `ezcorp/append-message` reverse-RPC call to insert an
    // excluded turn whose `kokoro-tts-player` card runs kokoro-js in
    // the browser to synthesize WAV. Persists the audio via a
    // `kokoro-tts:save` callback that finalises the tool call.
    name: "kokoro-tts",
    path: "docs/extensions/examples/kokoro-tts",
    permissions: {
      eventSubscriptions: ["kokoro-tts:speak", "kokoro-tts:save"],
      appendMessages: { excludedDefault: true },
      grantedAt: {
        eventSubscriptions: Date.now(),
        appendMessages: Date.now(),
      },
    },
  },
  {
    // Phase 53 Stage 1 — bundled port of the legacy lessons distiller
    // (src/runtime/lessons/distiller.ts). Lives at the milestone-spec'd
    // path `extensions/<name>/` rather than the docs/examples or
    // packages/@ezcorp paths used by older bundled extensions. The
    // `getProjectRoot()`-relative join handles any in-repo path.
    //
    // Shipped alongside the legacy implementation; Stage 2 (a separate
    // commit gated on UAT signoff) deletes the legacy code. The parity
    // test at `src/__tests__/distiller-port-parity.test.ts` proves both
    // pipelines produce identical outcomes during Stage 1.
    name: "lessons-distiller",
    path: "extensions/lessons-distiller",
    permissions: {
      llm: {
        providers: ["google", "openai", "anthropic", "ollama"],
        maxCallsPerHour: 30,
        maxCallsPerDay: 200,
        maxTokensPerCall: 1024,
        allowedModels: {
          google: ["gemini-2.0-flash-lite"],
          openai: ["gpt-4o-mini"],
          anthropic: ["claude-haiku-4-5-20250514"],
          ollama: ["gemma4:e2b", "gemma4:latest", "qwen3.6:35b"],
        },
      },
      lessons: {
        access: "write",
        maxWritesPerDay: 50,
        maxVisibility: "user",
      },
      eventSubscriptions: ["run:complete"],
      storage: true,
      grantedAt: {
        llm: Date.now(),
        lessons: Date.now(),
        eventSubscriptions: Date.now(),
        storage: Date.now(),
      },
    },
  },
];

/** Opt-OUT switches: each maps a bundled-extension name to the env var that
 *  disables it. Present to let operators turn off a bundled extension without
 *  editing code. Names not in this map are always installed. */
const DISABLE_FLAGS: Readonly<Record<string, string>> = {
  "ai-kit": "EZCORP_DISABLE_AI_KIT",
};

/** Returns the list of bundled extensions to install on this startup —
 *  BUNDLED_EXTENSIONS minus any entry whose opt-out env flag is set to "1".
 *  Exported for testing the opt-out gate without touching the DB. */
export function resolveBundledExtensions(
  env: NodeJS.ProcessEnv = process.env,
): BundledExtension[] {
  return BUNDLED_EXTENSIONS.filter((entry) => {
    const flag = DISABLE_FLAGS[entry.name];
    return !flag || env[flag] !== "1";
  });
}

/** Names of every extension that ships WITH the EZCorp codebase (bundled),
 *  regardless of opt-out flags. Consulted by ExtensionRegistry at spawn
 *  time to skip the runtime integrity check — bundled extensions live in
 *  the same repository as the server itself, so their files legitimately
 *  change whenever the repo does (dev edits, pulls, upgrades). Gating
 *  them on checksum parity would brick every subsequent spawn after any
 *  commit that touches the extension's directory.
 *
 *  User-installed (non-bundled) extensions still get the full integrity
 *  check — a file changing under a git-cloned or marketplace-installed
 *  extension is almost always tampering.
 *
 *  This list is computed once at module load. Opt-out flags intentionally
 *  do NOT remove a name here — if the operator sets
 *  `EZCORP_DISABLE_AI_KIT=1` AFTER an install, the extension still has
 *  integrity-skip semantics until it's uninstalled; the flag only
 *  governs fresh installs. */
const BUNDLED_EXTENSION_NAMES: ReadonlySet<string> = new Set(
  BUNDLED_EXTENSIONS.map((e) => e.name),
);

export function isBundledExtensionName(name: string): boolean {
  return BUNDLED_EXTENSION_NAMES.has(name);
}

export async function ensureBundledExtensions(): Promise<void> {
  for (const entry of resolveBundledExtensions()) {
    try {
      const existing = await getExtensionByName(entry.name);
      if (existing) {
        // Backfill: rows created before the is_bundled column existed
        // report `isBundled=false` even though they were installed via
        // this path. Flip the flag so the registry's integrity-skip
        // check (which now reads the DB flag rather than matching on
        // name) keeps working across the upgrade. Idempotent — no-op
        // once set. The (existing as any) cast covers the narrow window
        // where a DB row predates the column; new rows always carry it.
        if ((existing as { isBundled?: boolean }).isBundled !== true) {
          try {
            await updateExtension(existing.id, { isBundled: true });
          } catch (backfillErr) {
            log.warn("isBundled backfill failed", {
              name: entry.name,
              error: String(backfillErr),
            });
          }
        }
        // Drift detection (S6): if the on-disk manifest's declared
        // permissions differ from the DB-stored manifest permissions,
        // emit a WARN and DO NOT mutate the grant. Fail-closed — the
        // operator (or future CI check) must resolve the divergence.
        // This catches two scenarios:
        //   (1) a dev changed the extension's `permissions:` block in
        //       `ezcorp.config.ts` without re-approving at install time
        //       — the fix is to re-install (or let the update-gate in
        //       installer.ts:S9 handle it on version bump);
        //   (2) tampering under a git-cloned bundled path where the
        //       integrity check is (intentionally) skipped for bundled
        //       exts — this is our only structural signal.
        try {
          await detectAndLogManifestDrift(
            entry,
            existing.id,
            existing.manifest as ExtensionManifestV2,
            (existing as { grantedPermissions?: ExtensionPermissions }).grantedPermissions,
          );
        } catch (driftErr) {
          // Drift detection must never block startup — log and continue.
          log.warn("Manifest-drift check failed", { name: entry.name, error: String(driftErr) });
        }

        // Re-approval gate (S9): when a bundled extension's on-disk
        // version differs from the DB-recorded version AND its
        // permissions also changed, we flip `enabled=false` and write
        // an UPDATE_BLOCKED audit row. The operator must re-approve
        // via the admin UI before the tools become available again.
        // This closes the attack window where a malicious dependency
        // bump could quietly widen permissions under an existing grant.
        let versionBlockedUpdate = false;
        try {
          versionBlockedUpdate = await detectVersionBumpRequiringReapproval(
            entry,
            existing.id,
            existing.manifest as ExtensionManifestV2,
          );
        } catch (versionErr) {
          log.warn("Version-bump check failed", { name: entry.name, error: String(versionErr) });
        }
        if (versionBlockedUpdate) {
          // Skip the re-enable branch below: a version bump with
          // permission changes must fail-closed until re-approved.
          log.warn("Bundled extension version bumped with permission changes — disabled pending re-approval", {
            name: entry.name,
          });
          await updateExtension(existing.id, { enabled: false });
          continue;
        }

        // Refresh the stored manifest from on-disk for bundled extensions.
        // The DB copy of a bundled extension's manifest can go stale after
        // an ezcorp.config.ts edit (e.g. fixing a tool schema) because
        // `ensureBundledExtensions` used to just log drift + skip. Net
        // effect: the LLM saw the old broken schema until the row was
        // manually reinstalled. Source-of-truth for bundled extensions is
        // the repo, so pull the on-disk manifest and write it back —
        // EXCEPT preserve the stored `permissions` block. That keeps the
        // S6 drift check (§detectAndLogManifestDrift) and S9 version gate
        // (§detectVersionBumpRequiringReapproval) as the sole escalation
        // paths for permission changes. Non-permission fields (tools,
        // description, version-unless-gated, entrypoint) track source.
        //
        // Phase 5: gate the refresh on `manifest.lock.json`. A
        // mismatch on tool-list / entrypoint / version means either
        // a maintainer forgot to regenerate the lockfile or the file
        // was tampered with. Either way, fail-closed: disable the
        // extension, write an audit row, do NOT proceed with refresh.
        try {
          const diskDir = join(getProjectRoot(), entry.path);
          const diskManifest = await loadManifestFresh(diskDir);

          const lockResult = await verifyManifestAgainstLock(entry.name, diskManifest);
          if (!lockResult.ok) {
            log.error("Manifest tamper detected for bundled extension", {
              name: entry.name,
              extensionId: existing.id,
              reason: lockResult.reason,
              expected: lockResult.expected,
              actual: lockResult.actual,
            });
            await writeBundledManifestTamperAudit(
              existing.id,
              entry.name,
              lockResult.reason,
              lockResult.expected,
              lockResult.actual,
            );
            // Disable the extension. The DB-stored manifest + grant
            // remain intact so a future re-approval can re-enable
            // without losing user state.
            await updateExtension(existing.id, { enabled: false });
            continue;
          }

          const refreshed: ExtensionManifestV2 = {
            ...diskManifest,
            permissions: (existing.manifest as ExtensionManifestV2).permissions ?? diskManifest.permissions,
          };
          const currentJson = JSON.stringify(existing.manifest);
          const refreshedJson = JSON.stringify(refreshed);
          if (currentJson !== refreshedJson) {
            await updateExtension(existing.id, { manifest: refreshed });
            log.info("Refreshed bundled extension manifest from disk", {
              name: entry.name,
              extensionId: existing.id,
            });
          }
        } catch (refreshErr) {
          // Non-fatal: drift check already ran. Next boot retries.
          log.warn("Bundled manifest refresh failed", {
            name: entry.name,
            error: String(refreshErr),
          });
        }

        // If a bundled extension was disabled by a prior runtime check
        // (e.g. the now-removed integrity gate) or by an operator toggling
        // it off outside the opt-out env flag, re-enable it on the next
        // startup — we're the source of truth for "bundled default on".
        // Operators who genuinely want it off should set the disable flag,
        // which keeps the extension out of this loop entirely.
        if (!existing.enabled) {
          await updateExtension(existing.id, {
            enabled: true,
            consecutiveFailures: 0,
          });
          log.info("Re-enabled bundled extension", { name: entry.name });
          await writeBundledRegrantAudit(existing.id, entry.permissions);
        } else {
          log.info("Already installed, skipping", { name: entry.name });
        }
        continue;
      }

      const resolvedPath = join(getProjectRoot(), entry.path);

      // Phase 5: clamp the bundled install request to the hardcoded
      // capability ceiling. The ceiling is independent of the manifest
      // — a compromised `BUNDLED_EXTENSIONS` entry that requests wider
      // perms cannot exceed `bundled-ceiling.ts`. Persist the CLAMPED
      // grant; audit when narrowing occurred.
      const { effective: clampedPerms, clamped } = clampToBundledCeiling(
        entry.name,
        entry.permissions,
      );
      if (clamped) {
        log.warn("Bundled install grant clamped to ceiling", {
          name: entry.name,
          requested: entry.permissions,
          effective: clampedPerms,
        });
      }

      const installed = await installFromLocal(resolvedPath, clampedPerms, true);
      // Mark provenance AFTER the row exists. installFromLocal is shared
      // with the user install path (which must default isBundled=false),
      // so bundled trust is granted here, in the one place that knows.
      try {
        await updateExtension(installed.id, { isBundled: true });
      } catch (flagErr) {
        log.warn("Failed to set isBundled on fresh bundled install", {
          name: entry.name,
          error: String(flagErr),
        });
      }
      log.info("Installed extension", { name: entry.name });
      await writeBundledInstallAudit(installed.id, clampedPerms);
      if (clamped) {
        await writeBundledCeilingClampAudit(installed.id, entry.name, entry.permissions, clampedPerms);
      }
    } catch (error) {
      log.error("Failed to install extension", { name: entry.name, error: String(error) });
    }
  }

  // Phase 3 commit-5: rehome `extensionId="builtin"` task-tracking
  // storage rows under the real bundled extension id so users' existing
  // tasks survive the cutover. Runs exactly once per install via the
  // migration's own sentinel; safe to call on every boot.
  try {
    const taskTrackingRow = await getExtensionByName("task-tracking");
    if (taskTrackingRow) {
      const { migrateBuiltinTaskStorage } = await import("./migrations/task-tracking-storage");
      await migrateBuiltinTaskStorage(taskTrackingRow.id);
    }
  } catch (migrationErr) {
    log.warn("task-tracking storage migration threw during ensureBundledExtensions", {
      error: String(migrationErr),
    });
  }

  // Phase 53 Stage 1: migrate `global:lessonDistillerEnabled` into the
  // bundled lessons-distiller extension's per-extension `enabled`
  // setting. Idempotent via a `migrated_at` sentinel; safe on every boot.
  try {
    const lessonsDistillerRow = await getExtensionByName("lessons-distiller");
    if (lessonsDistillerRow) {
      const { migrateDistillerEnabledSetting } = await import("./migrations/distiller-enabled");
      await migrateDistillerEnabledSetting(lessonsDistillerRow.id);
    }
  } catch (migrationErr) {
    log.warn("lessons-distiller settings migration threw during ensureBundledExtensions", {
      error: String(migrationErr),
    });
  }

  // Phase 53 Stage 2: backfill `conversation_extensions` rows for the
  // bundled lessons-distiller extension across every existing
  // conversation. Without this, the dispatcher's wired-set gate would
  // silently drop `run:complete` for legacy conversations after the
  // host-side listener is removed. Idempotent via a `migrated_at`
  // sentinel; honours user-driven unwirings (sentinel = no replay).
  try {
    const lessonsDistillerRow = await getExtensionByName("lessons-distiller");
    if (lessonsDistillerRow) {
      const { migrateLessonsDistillerConversationWiring } = await import(
        "./migrations/lessons-distiller-conversation-wiring"
      );
      await migrateLessonsDistillerConversationWiring(lessonsDistillerRow.id);
    }
  } catch (migrationErr) {
    log.warn(
      "lessons-distiller wiring migration threw during ensureBundledExtensions",
      { error: String(migrationErr) },
    );
  }
}

/**
 * Compare an on-disk manifest's `permissions` block against the
 * DB-stored manifest's permissions AND the runtime `granted_permissions`
 * column. Emits one WARN per differing safety-boundary field
 * (network/filesystem/shell/env/storage/lifecycleHooks) and DOES NOT
 * mutate them — those are privacy/safety boundaries; the operator's job
 * is to either re-install (via admin UI or a future CI step) or revert
 * the on-disk change. Fail-closed guarantees that runtime enforcement
 * continues to use the DB grant, not the (possibly tampered) on-disk
 * declaration.
 *
 * Exception: `eventSubscriptions`. This field is infrastructure
 * plumbing (which canvas-style POST routes the extension can receive),
 * NOT a privacy/safety boundary. Failing closed here would brick the
 * canvas knob round-trip for any bundled extension that adds a new
 * event after its first install — exactly the 400 captured in the
 * test suite for this code path. The chosen policy:
 *
 *   - eventSubscriptions: AUTO-HEAL. If the on-disk manifest declares
 *     subscriptions that are missing from `granted_permissions.eventSubscriptions`
 *     OR the DB-stored manifest's `permissions.eventSubscriptions`, the
 *     host UNION-merges the disk additions in (never removes — removal
 *     is the operator's job via re-install) and writes a
 *     `BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED` audit row.
 *   - everything else: WARN-AND-FAIL-CLOSED (legacy behavior).
 *
 * Tradeoff: auto-heal sacrifices the strict drift signal for
 * eventSubscriptions specifically, in exchange for avoiding the
 * "bundled extension declares a new event but the runtime can't
 * deliver it" footgun. Anyone who can edit the bundled extension's
 * source can already widen its event surface — the bundled-trust model
 * is "code review is the approval gate" — so auto-heal here is
 * equivalent in security posture to the existing BUNDLED_REGRANTED
 * audit behavior.
 *
 * This is the S6 invariant in the security plan — see
 * .claude/plans/mellow-floating-prism.md for the full security model.
 */
async function detectAndLogManifestDrift(
  entry: BundledExtension,
  extensionId: string,
  dbManifest: ExtensionManifestV2,
  dbGranted?: ExtensionPermissions,
): Promise<void> {
  const diskDir = join(getProjectRoot(), entry.path);
  let diskManifest: ExtensionManifestV2;
  try {
    diskManifest = await loadManifestFresh(diskDir);
  } catch (e) {
    log.warn("Could not load on-disk manifest for drift check", {
      name: entry.name,
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }

  const diskPerms = diskManifest.permissions ?? {};
  const dbPerms = dbManifest.permissions ?? {};
  const diffs: string[] = [];

  // Permission-typed fields we care about for the FAIL-CLOSED branch.
  // Anything else declared in the manifest (description, version, tools
  // list) does not affect the runtime security boundary and so is not
  // surfaced here. eventSubscriptions is handled separately below
  // because we auto-heal that field.
  const fields = ["network", "filesystem", "shell", "env", "storage", "lifecycleHooks"] as const;
  for (const f of fields) {
    if (JSON.stringify(diskPerms[f]) !== JSON.stringify(dbPerms[f])) {
      diffs.push(
        `${f}: disk=${JSON.stringify(diskPerms[f])} vs db=${JSON.stringify(dbPerms[f])}`,
      );
    }
  }

  if (diffs.length > 0) {
    log.warn("Bundled extension manifest permissions drifted — DB grant unchanged (fail-closed)", {
      name: entry.name,
      extensionId,
      diffs,
    });
    // Best-effort audit log — a durable record for post-hoc review.
    try {
      for (const f of fields) {
        const oldValue = dbPerms[f];
        const newValue = diskPerms[f];
        if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
        const meta: ExtensionAuditMetadata = {
          permission: f,
          oldValue,
          newValue,
          actor: "system",
          reason: "bundled-manifest-drifted: on-disk declaration diverges from DB",
        };
        await insertAuditEntry(null, EXT_AUDIT_ACTIONS.MANIFEST_DRIFTED, extensionId, meta);
      }
    } catch { /* audit write failure is non-fatal — the WARN is the primary signal */ }
  }

  // ── eventSubscriptions auto-heal branch ──────────────────────────
  //
  // Compare the on-disk declaration against BOTH the DB manifest's
  // permissions block AND the runtime grant. If the disk declares any
  // subscription not present in either, union-merge it into
  // `granted_permissions.eventSubscriptions` and the DB manifest's
  // `permissions.eventSubscriptions`, then audit. Pure additions only
  // — disk-only removals are not propagated (operator's job at
  // re-install time, mirroring the network/filesystem fail-closed
  // policy).
  const diskEvents = Array.isArray(diskPerms.eventSubscriptions)
    ? diskPerms.eventSubscriptions
    : [];
  const dbManifestEvents = Array.isArray(dbPerms.eventSubscriptions)
    ? dbPerms.eventSubscriptions
    : [];
  const dbGrantedEvents = Array.isArray(dbGranted?.eventSubscriptions)
    ? (dbGranted!.eventSubscriptions as string[])
    : [];

  // Union of "what's already on the row". Merging via Set so duplicates
  // don't accumulate when the disk and grant both declare the same entry.
  const existing = new Set<string>([...dbManifestEvents, ...dbGrantedEvents]);
  const additions = diskEvents.filter((e) => !existing.has(e));

  if (additions.length === 0) return;

  // Compose the new grant + manifest so the union holds across both
  // columns. Idempotent — same on-disk additions on the next boot
  // produce no further diffs.
  const newGrantedEvents = Array.from(new Set<string>([...dbGrantedEvents, ...additions]));
  const newManifestEvents = Array.from(new Set<string>([...dbManifestEvents, ...additions]));

  try {
    const updates: Partial<{
      grantedPermissions: ExtensionPermissions;
      manifest: ExtensionManifestV2;
    }> = {};
    if (dbGranted) {
      updates.grantedPermissions = {
        ...dbGranted,
        eventSubscriptions: newGrantedEvents,
        grantedAt: {
          ...(dbGranted.grantedAt ?? {}),
          eventSubscriptions: Date.now(),
        },
      };
    }
    const newManifest: ExtensionManifestV2 = {
      ...dbManifest,
      permissions: {
        ...dbPerms,
        eventSubscriptions: newManifestEvents,
      },
    };
    updates.manifest = newManifest;
    await updateExtension(extensionId, updates);
    // ALSO mutate the in-memory snapshot the caller is holding so the
    // downstream "refresh manifest from disk" branch in
    // `ensureBundledExtensions` (which reads `existing.manifest.permissions`
    // and would otherwise overwrite our backfill with the pre-backfill
    // snapshot) sees the merged state. Without this, the manifest column
    // would oscillate every boot; the grant column survives because the
    // refresh only touches `manifest`, but cosmetic drift would re-fire.
    if (dbManifest.permissions == null) {
      (dbManifest as { permissions: Record<string, unknown> }).permissions = {
        eventSubscriptions: newManifestEvents,
      };
    } else {
      (dbManifest.permissions as { eventSubscriptions?: string[] }).eventSubscriptions =
        newManifestEvents;
    }
  } catch (writeErr) {
    log.warn("eventSubscriptions backfill write failed", {
      name: entry.name,
      extensionId,
      error: String(writeErr),
    });
    return;
  }

  log.info("Backfilled bundled extension eventSubscriptions from disk manifest", {
    name: entry.name,
    extensionId,
    additions,
  });

  try {
    const meta: ExtensionAuditMetadata = {
      permission: "eventSubscriptions",
      oldValue: dbGrantedEvents,
      newValue: newGrantedEvents,
      actor: "system",
      reason:
        "bundled-event-subscriptions-backfilled: on-disk manifest declared additions not " +
        "present in the DB grant. Auto-heal — eventSubscriptions are infrastructure plumbing, " +
        "not a privacy/safety boundary.",
    };
    await insertAuditEntry(
      null,
      EXT_AUDIT_ACTIONS.BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED,
      extensionId,
      meta,
    );
  } catch { /* non-fatal — the info log is the primary signal */ }
}

/**
 * Re-approval gate (S9). Compares on-disk manifest `version`,
 * `permissions`, and tool-list signature against the DB-stored copy.
 * Returns `true` if the gate engaged, meaning the caller should
 * disable the extension and leave it disabled until an admin
 * re-approves. Also writes an `UPDATE_BLOCKED` audit row per
 * differing field so the admin UI can show exactly what changed.
 *
 * Trigger conditions (any one suffices):
 *   1. Version changed AND permissions changed (the original S9
 *      gate — catches a dependency release that quietly widens
 *      its permission surface under a new version number).
 *   2. Tool-list signature changed (Phase 5, regardless of version
 *      or permissions). Adding, removing, renaming, or modifying
 *      a tool's `inputSchema` requires explicit re-approval — a
 *      new tool that exercises existing grants in unforeseen ways
 *      is exactly the supply-chain attack Phase 5 closes.
 *
 * A pure version bump with no permission AND no tool change is a
 * normal upgrade and does NOT engage the gate. A pure permissions
 * change with no version bump is caught by drift detection (S6).
 * Tool-list signature drift is caught here.
 */
async function detectVersionBumpRequiringReapproval(
  entry: BundledExtension,
  extensionId: string,
  dbManifest: ExtensionManifestV2,
): Promise<boolean> {
  const diskDir = join(getProjectRoot(), entry.path);
  let diskManifest: ExtensionManifestV2;
  try {
    diskManifest = await loadManifestFresh(diskDir);
  } catch {
    // Can't read disk → don't block. The drift check already warned.
    return false;
  }

  // Tool-list signature: canonical-JSON SHA-256. Drift on this signal
  // is independent of the version-vs-permissions trigger and ALWAYS
  // requires re-approval (Phase 5).
  const dbToolHash = canonicalizeAndHash(dbManifest.tools ?? []);
  const diskToolHash = canonicalizeAndHash(diskManifest.tools ?? []);
  const toolListChanged = dbToolHash !== diskToolHash;

  // Version + permissions trigger (legacy S9).
  const versionChanged = diskManifest.version !== dbManifest.version;

  const diskPerms = diskManifest.permissions ?? {};
  const dbPerms = dbManifest.permissions ?? {};
  const fields = ["network", "filesystem", "shell", "env", "storage", "lifecycleHooks"] as const;
  const diffs: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
  for (const f of fields) {
    const a = dbPerms[f];
    const b = diskPerms[f];
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ field: f, oldValue: a, newValue: b });
  }

  // No trigger: pure version bump, pure cosmetic refresh, or a
  // permission-only change that's already caught by drift detection.
  if (!toolListChanged && (!versionChanged || diffs.length === 0)) {
    return false;
  }

  // Tool-list change adds a synthetic diff entry so the admin UI
  // surfaces it next to the permissions diffs.
  if (toolListChanged) {
    diffs.push({
      field: "tools",
      oldValue: dbToolHash,
      newValue: diskToolHash,
    });
  }
  if (diffs.length === 0) return false;

  // Audit each differing field so the admin UI can render a readable diff.
  try {
    for (const d of diffs) {
      const meta: ExtensionAuditMetadata = {
        permission: d.field,
        oldValue: d.oldValue,
        newValue: d.newValue,
        actor: "system",
        reason: `version-bump-blocked: ${dbManifest.version} → ${diskManifest.version} changed permissions`,
      };
      await insertAuditEntry(null, EXT_AUDIT_ACTIONS.UPDATE_BLOCKED, extensionId, meta);
    }
  } catch { /* non-fatal */ }

  return true;
}

async function writeBundledInstallAudit(
  extensionId: string,
  permissions: ExtensionPermissions,
): Promise<void> {
  const fields = ["network", "filesystem", "shell", "env", "storage"] as const;
  try {
    for (const f of fields) {
      const v = permissions[f];
      if (v === undefined || v === false || (Array.isArray(v) && v.length === 0)) continue;
      const meta: ExtensionAuditMetadata = {
        permission: f,
        oldValue: undefined,
        newValue: v,
        actor: "system",
        reason: "bundled-install: code-review is the approval gate",
      };
      await insertAuditEntry(null, EXT_AUDIT_ACTIONS.BUNDLED_INSTALLED, extensionId, meta);
    }
    // Phase 51: governance — emit `ext:env-key-leak-warning` for any
    // env names that match `*_API_KEY|TOKEN|SECRET`. Migration path:
    // ctx.llm (host-brokered). Soft today; hard in v1.4.
    const { emitEnvKeyLeakWarnings } = await import("./clamp-permissions");
    await emitEnvKeyLeakWarnings(extensionId, permissions.env);
  } catch { /* audit write failure is non-fatal */ }
}

async function writeBundledRegrantAudit(
  extensionId: string,
  permissions: ExtensionPermissions,
): Promise<void> {
  const fields = ["network", "filesystem", "shell", "env", "storage"] as const;
  try {
    for (const f of fields) {
      const v = permissions[f];
      if (v === undefined || v === false || (Array.isArray(v) && v.length === 0)) continue;
      const meta: ExtensionAuditMetadata = {
        permission: f,
        oldValue: undefined,
        newValue: v,
        actor: "system",
        reason: "bundled-regrant: operator-disabled bundled ext re-enabled on startup",
      };
      await insertAuditEntry(null, EXT_AUDIT_ACTIONS.BUNDLED_REGRANTED, extensionId, meta);
    }
  } catch { /* audit write failure is non-fatal */ }
}

/**
 * Phase 5: write an audit row for a bundled-install grant clamped to
 * the hardcoded ceiling. The metadata captures the FULL requested vs.
 * effective grant so an admin reviewing the audit log can reconstruct
 * exactly which fields were narrowed without consulting `bundled.ts`
 * source.
 */
async function writeBundledCeilingClampAudit(
  extensionId: string,
  extensionName: string,
  requested: ExtensionPermissions,
  effective: ExtensionPermissions,
): Promise<void> {
  const ceiling = getCeiling(extensionName);
  const meta: ExtensionAuditMetadata = {
    permission: "ceiling-clamp",
    oldValue: requested,
    newValue: effective,
    actor: "system",
    reason: `bundled-ceiling-clamp: bundled '${extensionName}' install request narrowed by hardcoded ceiling`,
    extensionName,
    requested,
    effective,
    ceiling,
  };
  try {
    await insertAuditEntry(null, EXT_AUDIT_ACTIONS.BUNDLED_CEILING_CLAMP, extensionId, meta);
  } catch { /* audit write failure is non-fatal */ }
}

/**
 * Phase 5: write an audit row when `verifyManifestAgainstLock` returns
 * `ok: false`. Captures the lockfile-vs-disk diff so an admin can
 * confirm whether the mismatch was a maintainer's missed lockfile
 * regenerate or a tampering signal.
 */
async function writeBundledManifestTamperAudit(
  extensionId: string,
  extensionName: string,
  reason: string,
  expected: unknown,
  actual: unknown,
): Promise<void> {
  const meta: ExtensionAuditMetadata = {
    permission: "manifest-tamper",
    oldValue: expected,
    newValue: actual,
    actor: "system",
    reason: `bundled-manifest-tamper: ${reason}`,
    extensionName,
    expected,
    actual,
  };
  try {
    await insertAuditEntry(null, EXT_AUDIT_ACTIONS.BUNDLED_MANIFEST_TAMPER, extensionId, meta);
  } catch { /* audit write failure is non-fatal */ }
}
