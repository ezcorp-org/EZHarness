#!/usr/bin/env bun
/**
 * Shared coverage-gate configuration + helpers.
 *
 * Single source of truth for: the EXCLUDES list (paths NOT enforced),
 * the source-file classification (what counts as gateable product code),
 * the Bun `Glob` escaping quirk, and the lcov parser. Imported by
 * scripts/check-coverage.ts (the per-file gate), scripts/gate-integrity.ts
 * (anti-tamper meta-check), scripts/check-new-file-coverage.ts and
 * scripts/check-patch-coverage.ts so none of these re-derive the same
 * lists/parsers — keeping the gate definition DRY and consistent.
 *
 * REPO_ROOT is derived from this file's own location (scripts/..) so that
 * the spawn-in-a-sandbox tests (src/__tests__/coverage-gate.test.ts copies
 * the scripts into a temp dir) rebase onto the sandbox identically to the
 * old inline implementation.
 */
import { Glob } from "bun";
import { relative, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..");

// Files matching any of these globs are NOT enforced (generated / vendor / markup).
//
// GATE-INTEGRITY NOTE: this array is the un-gating surface. Adding an entry
// removes a file from coverage enforcement, so scripts/gate-integrity.ts
// fails any PR that GROWS this list unless a maintainer applies the
// `gate-change-approved` label. Keep one path (or wildcard) per line with a
// justification comment so the diff is reviewable.
export const EXCLUDES: readonly string[] = [
  "web/e2e/**",
  // Template-string files: lcov counts the interior of returned
  // template literals as "missed lines" even when every template
  // function is exercised end-to-end via sdk-scaffold.test.ts. There's
  // no executable code path inside the strings — they're literal output.
  "packages/@ezcorp/sdk/src/scaffold/templates/**",
  // Verbatim copied-into-the-extension skill runner: its `main()` +
  // stdin loop are process-level (only execute as a spawned
  // subprocess), so they can't be line-covered in-process. Behaviour
  // IS verified — `handleRequest` / `commandFor` are unit-tested
  // in-process, plus a real subprocess smoke test and the
  // import-wizard e2e exercise the spawned path. Same spirit as the
  // scaffold-templates exclusion above.
  "src/runtime/import/skill-runner.template.ts",
  // Declaration-only TypeScript types: no executable code to count.
  // Same justification as scaffold/templates/** above — lcov can't
  // measure pure `export interface` / `export type` files. The host
  // shim is a `export type *` re-export; the SDK file is the canonical
  // type surface. Both ship with byte-for-byte alignment enforced by
  // host-shim tests, not lcov.
  "packages/@ezcorp/sdk/src/types.ts",
  "src/extensions/sdk/types.ts",
  // Loop SDK public type surface — pure `export type` / `export interface`
  // (no executable code; compiles to empty), identical justification to the
  // two type files above. Flagged by the new-file gate as "no measured
  // coverage" because there is, by construction, nothing to line-measure.
  "packages/@ezcorp/sdk/src/runtime/loop-types.ts",
  // Stream-chat host/ctx type surface — two `export interface` blocks, no
  // `const`/`function`/`class`, compiles to empty. Identical justification to
  // the type files above. It was ALREADY unmeasured; it only became VISIBLE to
  // the patch gate when `PendingPermissionInfo` gained the optional
  // `runId?: string` that the per-run watchdog deferral reads. An interface
  // field has no executable line, so there is nothing a test could cover here.
  // The BEHAVIOUR that field drives is covered:
  // `src/__tests__/executor-watchdog-inflight-tools.test.ts` (run A's open gate
  // must not shield run B from the idle kill) and
  // `src/__tests__/permission-wrap.test.ts` (the wrapper populates it).
  "src/runtime/stream-chat/host.ts",
  // NOTE: the 9 web security helpers (bearer-auth, openai-extension-creds,
  // payload, internal-auth, system-user, bundled-creds, rate-limiter, api-keys,
  // resource-quotas) were REMOVED from this list. Their bun:test suites rely on
  // per-`beforeEach` `mock.module` re-registration (a bun-only feature, no
  // `vi.mock` equivalent) so they can't run in the v8/vitest leg — but
  // scripts/security-coverage.sh now measures them under `bun --coverage` and
  // FILTERS the lcov to exactly these 9 files (no web/src/lib union artifact),
  // uploaded as an `lcov-cov-*` artifact by the CI `web-security-coverage` job.
  // Each clears the `web/src/lib/**` 90% floor (measured 97.78–100%). Their
  // suites are ALSO run for pass/fail by the `web-bun-tests` job.
  // Compatibility barrel only: it re-exports the backend clamp implementation
  // so established `$lib` imports stay valid. The implementation's behavior is
  // measured in `src/__tests__/clamp-extension-permissions.test.ts` and the
  // route-level `web/src/__tests__/extension-helpers-clamp.server.test.ts`.
  // The barrel has no independently instrumentable statement.
  "web/src/lib/server/extension-helpers.ts",
  // Illustrative demo extensions whose index.ts is mostly narrative tool
  // handlers + a harness; exhaustive line coverage isn't a meaningful gate for
  // sample code (they're smoke-tested, not gated at 100 like real code). The
  // other examples that DO reach ≥90 stay gated via the examples threshold.
  "docs/extensions/examples/weather/index.ts",
  "docs/extensions/examples/auto-note/index.ts",
  "docs/extensions/examples/harness-smoke-test/index.ts",
  // Declarative example manifest (`defineExtension({…})`) — a config object,
  // not gateable product logic; same spirit as the example index.ts excludes
  // above. (The sample-loop index.ts IS covered by its own index.test.ts.)
  "docs/extensions/examples/sample-loop/ezcorp.config.ts",
  // Protected historical threshold coordinate. The path is absent in this
  // checkout, so it has no executable behaviour to measure. Keep this paired
  // exclusion until the exact threshold key receives separately reviewed
  // cleanup; otherwise the gate would report a false orphan.
  "web/src/routes/api/conversations/[id]/goal-state/+server.ts",
];

/**
 * Source-file globs: what counts as gateable product code for the
 * diff-scoped new-file / patch-coverage gates. Excludes test/spec files,
 * type-only declarations, and config. A file must match one of these AND
 * not be in EXCLUDES to be subject to the new-file 100% floor.
 */
export const SOURCE_GLOBS: readonly string[] = [
  "src/**/*.ts",
  "scripts/git-worktree-clean.ts",
  "web/src/**/*.ts",
  "web/src/**/*.svelte",
  "packages/@ezcorp/sdk/src/**/*.ts",
  "packages/@ezcorp/ai-kit/src/**/*.ts",
  "packages/@ezcorp/harness-client/src/**/*.ts",
  "packages/@ezcorp/extension-contract/src/**/*.ts",
  "packages/@ezcorp/extension-runner/src/**/*.ts",
  "docs/extensions/examples/**/*.ts",
  // First-party BUNDLED extensions (registered in src/extensions/bundled.ts).
  // They ship in the product exactly like `src/**` does — the reference
  // extensions under `docs/extensions/examples/**` were already gated while
  // this tree was not, so `extensions/**` was outside BOTH the new-file and
  // patch-coverage gates and its three test files ran in no CI job.
  "extensions/**/*.ts",
  // The Worker is a shipped execution target. Its source must receive the
  // same changed/new-file coverage checks as the host runtime.
  "worker/src/**/*.ts",
];

// Test/spec/type files are never "product code" for the new-file gate.
const NON_SOURCE_GLOBS: readonly string[] = [
  "**/*.test.ts",
  "**/*.spec.ts",
  "**/__tests__/**",
  "**/*.d.ts",
];

/**
 * Catch-all (ratchet-floor) threshold keys — wave 3. These gate the
 * previously-unkeyed remainder of a tree at its observed minimum so
 * coverage can only ratchet UP, but they are NOT an acceptable home for a
 * NEW file: check-new-file-coverage.ts ignores them when deciding whether
 * an added file "is gated", so every new source file still needs its own
 * (default-100) key. Keep this list in sync with the catch-all keys in
 * coverage-thresholds.json.
 */
/** Producer tags carried in LCOV `TN:` fields through every merge generation. */
export const NODE_V8_COVERAGE_PRODUCER = "ezcorp-node-v8";
export const BROWSER_V8_COVERAGE_PRODUCER = "ezcorp-browser-v8";

/**
 * These files have a canonical Node/V8 producer. Bun instruments their
 * TypeScript spans differently when it transitively imports them, so summing
 * the two line maps manufactures misses that neither producer observed.
 * The two settings sections are exercised to their exact floors by their
 * direct component tests; browser journeys deliberately cover only their
 * interactive slice. If Node/V8 evidence disappears, exact thresholds fail
 * for missing LCOV data rather than borrowing an incompatible map.
 */
export const V8_CANONICAL_SOURCES: readonly string[] = [
  "web/src/lib/mention-logic.ts",
  "web/src/lib/markdown.ts",
  "web/src/lib/chat-input-logic.ts",
  "web/src/lib/utils/relative-time.ts",
  "web/src/lib/server/http-errors.ts",
  "web/src/lib/server/shutdown.ts",
  "web/src/lib/server/auth/session-cookie.ts",
  "web/src/lib/server/preview/dispatch.ts",
  "web/src/lib/server/preview/ws-bridge.ts",
  "web/src/lib/components/settings/ProvidersSection.svelte",
  "web/src/lib/components/settings/TeamsSection.svelte",
  // Direct component and utility contracts own these maps. Native browser
  // journeys still run, but their different statement spans are not merged.
  "web/src/lib/invoke-inline-tool.ts",
  "web/src/lib/sub-conversation-store.svelte.ts",
  "web/src/lib/stores/extension-toolbar.svelte.ts",
  "web/src/lib/chat/page-handlers/panel-persistence.svelte.ts",
  "web/src/lib/components/message-toolbar-registry.ts",
  "web/src/lib/components/ShortcutHelp.svelte",
  "web/src/lib/components/InlineToolCard.svelte",
  "web/src/lib/components/InlineToolForm.svelte",
  "web/src/lib/components/SubConversationBlock.svelte",
  "web/src/lib/components/SubConvoInput.svelte",
  "web/src/lib/components/tool-cards/CopyButton.svelte",
  "web/src/lib/components/tool-cards/DefaultCard.svelte",
  "web/src/lib/components/tool-cards/SubstackReviewCard.svelte",
  "web/src/lib/components/tool-cards/weather-card-element.ts",
  "web/src/lib/components/ui/ComboBox.svelte",
  "web/src/lib/components/ui/TagInput.svelte",
  "web/src/lib/components/AgentConfigForm.svelte",
  "web/src/lib/components/AgentDetailPanel.svelte",
  "web/src/lib/components/AgentInputForm.svelte",
  "web/src/lib/components/AssignmentPicker.svelte",
  "web/src/lib/components/AssignmentPill.svelte",
  "web/src/lib/components/MetaAgentChat.svelte",
  "web/src/lib/components/ProjectPicker.svelte",
  "web/src/lib/components/ProjectForm.svelte",
  "web/src/lib/components/TaskLogsPanel.svelte",
  "web/src/lib/components/ExtensionPanel.svelte",
  "web/src/lib/components/PublishDialog.svelte",
  "web/src/lib/components/ShareAgentDialog.svelte",
  "web/src/lib/components/StuckRunBanner.svelte",
  "web/src/lib/components/MarketplaceDetail.svelte",
  "web/src/lib/components/FlagDialog.svelte",
  "web/src/lib/components/EntityFormModal.svelte",
  "web/src/lib/components/EntityTable.svelte",
  "web/src/lib/components/FileUpload.svelte",
  "web/src/lib/components/MemoryItem.svelte",
  "web/src/lib/components/FeatureIndex.svelte",
  "web/src/lib/components/ObservabilityPanel.svelte",
  "web/src/lib/components/PanelChatInput.svelte",
  "web/src/lib/components/TaskPanel.svelte",
  "web/src/lib/components/TeamBuilderForm.svelte",
  "web/src/lib/components/TeamChatPanel.svelte",
  "web/src/lib/components/SwipeDrawer.svelte",
  "web/src/lib/components/ez/EzPanel.svelte",
  "web/src/lib/components/tool-cards/ExtensionIframeCard.svelte",
];

/**
 * These shared UI sources are owned by Chromium AST/source-map coverage.
 * Their native browser journeys exercise focus, keyboard, pointer, layout,
 * and rendered-card behavior that an incidental Node component import cannot
 * measure with the same map. Each has a trusted browser receipt at its floor.
 */
export const BROWSER_CANONICAL_SOURCES: readonly string[] = [
  "web/src/lib/components/AgentSearchPicker.svelte",
  "web/src/lib/components/ChatInput.svelte",
  "web/src/lib/components/KnowledgeBaseTab.svelte",
  "web/src/lib/components/MentionPopover.svelte",
  "web/src/lib/components/ModeSearchPicker.svelte",
  "web/src/lib/components/PermissionModeIndicator.svelte",
  "web/src/lib/components/ProjectRail.svelte",
  "web/src/lib/components/ThemeToggle.svelte",
  "web/src/lib/components/ToolSearchPicker.svelte",
  "web/src/lib/components/WaterfallTimeline.svelte",
  "web/src/lib/components/chat/ConnectionBanner.svelte",
  "web/src/lib/components/ez/EzButton.svelte",
  "web/src/lib/components/tool-cards/SearchResultsCard.svelte",
  "web/src/lib/components/tool-cards/TerminalCard.svelte",
  "web/src/lib/components/ui/SearchBox.svelte",
  "web/src/lib/components/ui/SharedFilePicker.svelte",
];

/** Direct, isolated Bun utility tests have one bounded coverage leg. */
export const BUN_WEB_UTILITY_COVERAGE_PRODUCER = "ezcorp-bun-web-utility";
export const BUN_WEB_UTILITY_SOURCES: readonly string[] = [
  "web/src/lib/actions/hover-tooltip.ts",
  "web/src/lib/auth-keepalive.ts",
  "web/src/lib/chat-scroll-restore.ts",
  "web/src/lib/chat/attachment-client.ts",
  "web/src/lib/chat/chat-window-drop.ts",
  "web/src/lib/chat/page-handlers/inline-tool-handlers.ts",
  "web/src/lib/clipboard.ts",
  "web/src/lib/combobox-nav.ts",
  "web/src/lib/commands.ts",
  "web/src/lib/components/tool-cards/price-chart-logic.ts",
  "web/src/lib/ez/api.ts",
  "web/src/lib/ez/pill-visibility.ts",
  "web/src/lib/focus-trap.ts",
  "web/src/lib/last-model.ts",
  "web/src/lib/markdown-speech.ts",
  "web/src/lib/panel-persistence.ts",
  "web/src/lib/progressive-image.ts",
  "web/src/lib/select-mode.ts",
  "web/src/lib/shortcuts.ts",
  "web/src/lib/sub-agent-routing.ts",
  "web/src/lib/sub-convo-agent-state.ts",
  "web/src/lib/theme.ts",
  "web/src/lib/tool-display.ts",
  "web/src/lib/workers/agent-fuzzy-search-bridge.ts",
  "web/src/lib/workers/agent-fuzzy-search-worker.ts",
  "web/src/lib/workers/kokoro-tts-bridge.ts",
];

/** Bun-only contracts with source layouts that must not be mixed with V8 maps. */
export const BUN_CANONICAL_PRODUCERS = {
  "web/src/lib/api.ts": "ezcorp-bun-api",
  "web/src/lib/empty-node-shim.ts": "ezcorp-bun-shim",
  ...Object.fromEntries<string>(BUN_WEB_UTILITY_SOURCES.map(source => [source, BUN_WEB_UTILITY_COVERAGE_PRODUCER])),
} as const;

/** Paths with an explicit tagged Bun producer. Derived to prevent registry drift. */
export const BUN_CANONICAL_SOURCES: readonly string[] = Object.keys(BUN_CANONICAL_PRODUCERS);

/**
 * Return the sole trusted LCOV producer for source, if source maps must not
 * be merged across instrumenters. Keep the registries above as the reviewable
 * source-of-truth lists; consumers use this helper so tag checks cannot drift.
 */
export function canonicalCoverageProducer(source: string): string | undefined {
  if (V8_CANONICAL_SOURCES.includes(source)) return NODE_V8_COVERAGE_PRODUCER;
  if (BROWSER_CANONICAL_SOURCES.includes(source)) return BROWSER_V8_COVERAGE_PRODUCER;
  return BUN_CANONICAL_PRODUCERS[source as keyof typeof BUN_CANONICAL_PRODUCERS];
}

export const CATCHALL_THRESHOLD_KEYS: readonly string[] = [
  "src/**",
  "web/src/**",
  "packages/@ezcorp/ai-kit/src/**",
];

/**
 * Bun's `Glob` treats `[id]` as a character class — a literal SvelteKit
 * route segment like `[id]` would never match itself. Escape `[` and `]`
 * in a path/pattern before constructing the Glob so bracketed paths match
 * literally; non-bracketed keys are unaffected.
 */
export function escapeGlob(p: string): string {
  return p.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

const excludeGlobs = EXCLUDES.map((p) => new Glob(escapeGlob(p)));
const sourceGlobs = SOURCE_GLOBS.map((p) => new Glob(escapeGlob(p)));
const nonSourceGlobs = NON_SOURCE_GLOBS.map((p) => new Glob(escapeGlob(p)));

/** True if a repo-relative path matches any EXCLUDES pattern. */
export function isExcluded(relPath: string): boolean {
  return excludeGlobs.some((g) => g.match(relPath));
}

/**
 * True if a repo-relative path is gateable product code: matches a source
 * glob and is not a test/spec/type file. (EXCLUDES is applied separately by
 * callers so they can distinguish "not source" from "excluded source".)
 */
export function isSourceFile(relPath: string): boolean {
  if (nonSourceGlobs.some((g) => g.match(relPath))) return false;
  return sourceGlobs.some((g) => g.match(relPath));
}

/**
 * True if a repo-relative path is a test/spec/type artifact — regardless of
 * tree. Unlike isSourceFile it does NOT require SOURCE_GLOBS membership, so
 * trees outside the diff-gates' scope (e.g. harness-client) can still ask
 * "is this file the kind lcov could never legitimately contain coverage
 * for". Used by the wildcard whole-tree-dropout signal below.
 */
export function isTestOrTypeFile(relPath: string): boolean {
  return nonSourceGlobs.some((g) => g.match(relPath));
}

/**
 * Wildcard whole-tree-dropout signal (wave 3, used by check-coverage.ts): a
 * wildcard threshold key whose ENTIRE tree is missing from lcov used to be
 * indistinguishable from the benign shadowed-by-more-specific-keys case — a
 * coverage producer silently dying (dead leg / unwired set) could de-gate a
 * whole subtree while the gate stayed green. Cheap sound check, independent
 * of first-match-wins: violation iff the pattern matches >=1
 * non-test/non-type, non-EXCLUDED file on disk but lcov contains NONE of
 * its matches. Lives here (not check-coverage.ts) because that script runs
 * its gate at import time — unit tests import THIS module safely.
 */
export function wildcardTreeDropouts(
  wildcardPats: readonly string[],
  lcovFiles: readonly string[],
  repoFilesForPattern: (pat: string) => readonly string[],
): string[] {
  const out: string[] = [];
  for (const pat of wildcardPats) {
    const glob = new Glob(escapeGlob(pat));
    if (lcovFiles.some((f) => glob.match(f))) continue;
    const onDisk = repoFilesForPattern(pat).filter(
      (f) => !isTestOrTypeFile(f) && !isExcluded(f),
    );
    if (onDisk.length > 0) {
      out.push(
        `${pat}: wildcard threshold matches ${onDisk.length} repo file(s) (e.g. ${onDisk[0]}) ` +
          `but lcov contains NONE of them — a coverage producer for this whole tree dropped ` +
          `out (dead leg / unwired set). Fix the producer in scripts/test-coverage.sh; do not ` +
          `delete the key.`,
      );
    }
  }
  return out;
}

/**
 * TypeScript declarations compile to no JavaScript, so lcov cannot emit a
 * line record for them. Keep this structural: an enum, value export, or any
 * other runtime statement emits JavaScript and therefore remains gateable.
 */
export function isDeclarationOnlyTypeScript(source: string): boolean {
  return new Bun.Transpiler({ loader: "ts" }).transformSync(source).trim() === "";
}

/**
 * A wildcard threshold with *some* lcov data can still hide an omitted
 * executable sibling. This is the per-file complement to
 * {@link wildcardTreeDropouts}: every non-catchall wildcard source that has a
 * real runtime emit must have a producer record. Declaration-only TypeScript
 * is structurally exempt because it has no JavaScript line to measure.
 */
export async function wildcardSourceFileDropouts(
  wildcardPats: readonly string[],
  lcovFiles: readonly string[],
  repoFilesForPattern: (pat: string) => readonly string[],
  sourceForFile: (path: string) => Promise<string>,
): Promise<string[]> {
  const lcovSet = new Set(lcovFiles);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const pat of wildcardPats) {
    if (CATCHALL_THRESHOLD_KEYS.includes(pat)) continue;
    for (const file of repoFilesForPattern(pat)) {
      if (seen.has(file) || !isSourceFile(file) || isExcluded(file) || lcovSet.has(file)) continue;
      seen.add(file);
      if (file.endsWith(".ts") && isDeclarationOnlyTypeScript(await sourceForFile(file))) continue;
      out.push(
        `${file}: wildcard threshold ${pat} has no lcov record for this executable source — ` +
          `a coverage producer omitted an individual file. Add the owning test/producer; do not hide it.`,
      );
    }
  }
  return out;
}

export type FileCov = { totalLines: number; coveredLines: number; missed: number[] };

/**
 * Parse lcov text into a per-file map keyed by repo-relative path. Only DA
 * records are read — the gate derives totals from DA directly (matches the
 * historical inline parser in check-coverage.ts).
 */
export function parseLcov(lcovText: string): Map<string, FileCov> {
  const perFile = new Map<string, FileCov>();
  let curRec: FileCov | null = null;
  for (const line of lcovText.split("\n")) {
    if (line.startsWith("SF:")) {
      const abs = line.slice(3);
      const rel = relative(REPO_ROOT, abs);
      curRec = { totalLines: 0, coveredLines: 0, missed: [] };
      perFile.set(rel, curRec);
    } else if (!curRec) {
      // skip lines before the first SF record
    } else if (line === "end_of_record") {
      curRec = null;
    } else if (line.startsWith("DA:")) {
      const [lineNoStr, hitsStr] = line.slice(3).split(",");
      if (lineNoStr === undefined || hitsStr === undefined) continue;
      const hits = Number(hitsStr);
      curRec.totalLines++;
      if (hits > 0) curRec.coveredLines++;
      else curRec.missed.push(Number(lineNoStr));
    }
  }
  return perFile;
}

/**
 * Map of repo-relative path → set of line numbers with >0 hits. Used by the
 * patch-coverage gate to ask "is changed line N covered?".
 */
export function parseHitLines(lcovText: string): Map<string, Set<number>> {
  const hits = new Map<string, Set<number>>();
  let cur: Set<number> | null = null;
  for (const line of lcovText.split("\n")) {
    if (line.startsWith("SF:")) {
      const rel = relative(REPO_ROOT, line.slice(3));
      cur = hits.get(rel) ?? new Set<number>();
      hits.set(rel, cur);
    } else if (!cur) {
      // skip
    } else if (line === "end_of_record") {
      cur = null;
    } else if (line.startsWith("DA:")) {
      const [lineNoStr, hitsStr] = line.slice(3).split(",");
      if (lineNoStr === undefined || hitsStr === undefined) continue;
      if (Number(hitsStr) > 0) cur.add(Number(lineNoStr));
    }
  }
  return hits;
}
