/**
 * Bundled extensions — auto-installed on first startup.
 */

import type { ExtensionManifestV2, ExtensionPermissions } from "./types";
import { getExtensionByName, updateExtension } from "../db/queries/extensions";
import { installFromLocal } from "./installer";
import { loadManifestFresh } from "./loader";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS, type ExtensionAuditMetadata } from "./audit-actions";
import { join, dirname } from "path";
import { logger } from "../logger";
const log = logger.child("extensions");
import { fileURLToPath } from "url";

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
      eventSubscriptions: ["claude-design:knob-change"],
      network: ["cdn.jsdelivr.net"],
      grantedAt: {
        filesystem: Date.now(),
        storage: Date.now(),
        eventSubscriptions: Date.now(),
        network: Date.now(),
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
          await detectAndLogManifestDrift(entry, existing.id, existing.manifest as ExtensionManifestV2);
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
        try {
          const diskDir = join(getProjectRoot(), entry.path);
          const diskManifest = await loadManifestFresh(diskDir);
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
      const installed = await installFromLocal(resolvedPath, entry.permissions, true);
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
      await writeBundledInstallAudit(installed.id, entry.permissions);
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
}

/**
 * Compare an on-disk manifest's `permissions` block against the
 * DB-stored manifest's permissions. Emits one WARN per differing field.
 * Intentionally does NOT mutate any state — the operator's job is to
 * either re-install (via admin UI or a future CI step) or revert the
 * on-disk change. Fail-closed guarantees that runtime enforcement
 * continues to use the DB grant, not the (possibly tampered) on-disk
 * declaration.
 *
 * This is the S6 invariant in the security plan — see
 * .claude/plans/mellow-floating-prism.md for the full security model.
 */
async function detectAndLogManifestDrift(
  entry: BundledExtension,
  extensionId: string,
  dbManifest: ExtensionManifestV2,
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

  // Permission-typed fields we care about. Anything else declared in the
  // manifest (description, version, tools list) does not affect the
  // runtime security boundary and so is not surfaced here.
  const fields = ["network", "filesystem", "shell", "env", "storage", "lifecycleHooks"] as const;
  for (const f of fields) {
    if (JSON.stringify(diskPerms[f]) !== JSON.stringify(dbPerms[f])) {
      diffs.push(
        `${f}: disk=${JSON.stringify(diskPerms[f])} vs db=${JSON.stringify(dbPerms[f])}`,
      );
    }
  }

  if (diffs.length === 0) return;

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

/**
 * Re-approval gate (S9). Compares on-disk manifest `version` and
 * `permissions` against the DB-stored copy. Returns `true` if the gate
 * engaged (version changed AND permissions changed), meaning the
 * caller should disable the extension and leave it disabled until an
 * admin re-approves. Also writes an `UPDATE_BLOCKED` audit row per
 * differing permission field so the admin UI can show exactly what
 * changed.
 *
 * Why gate on BOTH version and permissions changing? A pure version
 * bump with no permission change is a normal upgrade — no user-visible
 * security impact, so interrupting the upgrade with a manual approval
 * would just be friction. A pure permissions change with no version
 * bump is already caught by drift detection (S6). The pairing here
 * catches the specific attack: a dependency release that claims to be
 * a new version while quietly widening its permission surface.
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

  if (diskManifest.version === dbManifest.version) return false;

  const diskPerms = diskManifest.permissions ?? {};
  const dbPerms = dbManifest.permissions ?? {};
  const fields = ["network", "filesystem", "shell", "env", "storage", "lifecycleHooks"] as const;
  const diffs: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
  for (const f of fields) {
    const a = dbPerms[f];
    const b = diskPerms[f];
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ field: f, oldValue: a, newValue: b });
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
