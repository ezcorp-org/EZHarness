import { json } from "@sveltejs/kit";
import { getExecutor, getCommandRegistry, getWorkflows } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getDb } from "$server/db/connection";
import { extensions, agentConfigs } from "$server/db/schema";
import { eq, and, or, ilike } from "drizzle-orm";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as projectQueries from "$server/db/queries/projects";
import { fuzzyScore, bestFuzzyScore } from "$lib/fuzzy-match";
import { EXCLUDED_DIR_NAMES, listFilteredChildren } from "$server/runtime/fs/scan-fs";
import { parseGoalEnabled } from "$server/runtime/goal-host";
import type { RequestHandler } from "./$types";

const MAX_RESULTS = 10;

type FileType =
  | "ext"
  | "agent"
  | "team"
  | "EZ"
  | "workflow"
  | "path"
  | "cmd"
  | "feature"
  | "lesson"
  | "tool";

interface PathCandidate {
  name: string;
  description: string;
  kind: "file" | "dir";
}

/** One entry on the wire. Also the element type of the `results` accumulator. */
interface MentionSearchResult {
  name: string;
  description: string;
  kind:
    | "agent"
    | "extension"
    | "team"
    | "EZ"
    | "workflow"
    | "file"
    | "dir"
    | "command"
    | "feature"
    | "lesson"
    | "tool";
  source?: string;
  body?: string;
  fileCount?: number;
  /** For built-in literal commands (e.g. `/goal`): the raw text the
   *  composer inserts on selection, in place of a `/[cmd:name]` token.
   *  Such commands are handled by a server-side interceptor and must
   *  reach `body.content` as literal text. */
  insertText?: string;
  /** Phase 4: when the tool was auto-generated from an entity
   *  declaration, surface the entity type so the popover can
   *  group hand-rolled vs SDK-served tools (the v2 sigil
   *  affordance will use this to deep-link into a slug picker). */
  entityType?: string;
}

/**
 * Merge a GLOBAL, code/cache-defined kind into the bare-`!` fallback list.
 *
 * Shared by the EZ-action and workflow merges — both are global (no project
 * scope, no DB query), both stop at MAX_RESULTS, and both want the same
 * "typing the kind label itself surfaces everything" behaviour.
 *
 * `kindLabel` makes typing the label (`!`, `!e`, `!ez` / `!w`, `!work`)
 * surface ALL entries of that kind. Without it the substring match against
 * name/description would exclude everything when no entry happens to contain
 * the label — the live case for EZ actions (`distill`, "Force-trigger lesson
 * distillation"). Typing a kind's name should mean "show me this kind's
 * stuff," matching how the user thinks.
 */
function mergeGlobalBangKind(
  results: MentionSearchResult[],
  entries: ReadonlyArray<{ name: string; description: string }>,
  kindLabel: string,
  kind: "EZ" | "workflow",
  lowerQ: string,
): void {
  const isKindPrefix = !lowerQ || kindLabel.startsWith(lowerQ);
  for (const e of entries) {
    if (results.length >= MAX_RESULTS) break;
    if (
      isKindPrefix ||
      e.name.toLowerCase().includes(lowerQ) ||
      e.description.toLowerCase().includes(lowerQ)
    ) {
      results.push({ name: e.name, description: e.description, kind });
    }
  }
}

/**
 * Read a single directory's direct children and push matching entries into
 * `out`. Delegates the dotfile + EXCLUDED_DIR_NAMES + symlink-escape
 * filtering to the shared `listFilteredChildren` helper so the scanner
 * (`src/runtime/scan/feature-scan.ts`) and this autocomplete stay in
 * lockstep — adding a new exclusion in scan-fs.ts updates both call sites.
 */
async function readDirectChildren(
  realRoot: string,
  absDir: string,
  relDirPrefix: string,
  out: PathCandidate[],
): Promise<void> {
  const children = await listFilteredChildren(realRoot, absDir, relDirPrefix);
  for (const c of children) {
    out.push({ name: c.relPath, description: c.abs, kind: c.kind });
  }
}

/**
 * List candidate paths for `@[file|dir:…]` autocomplete.
 *
 * Query semantics (enables folder-tree navigation):
 *   - **No slash in query** (e.g. `""` or `"src"`) → list project root +
 *     one-level-deep entries (files & dirs), fuzzy-ranked by the query.
 *     Unchanged from the flat-listing behaviour.
 *   - **Slash in query** (e.g. `"src/"` or `"src/ne"` or `"src/nested/"`) →
 *     "descent" mode. Let `dirPrefix` = everything up to & including the
 *     last `/`, and `tail` = everything after. List the direct children of
 *     `<project>/<dirPrefix>`; if `tail` is non-empty, fuzzy-match it
 *     against the child `basename`. Result entries carry the full
 *     relative path (e.g. `src/nested`, `src/app.ts`).
 *
 * In descent mode we do **not** recurse further — the user can keep
 * selecting folders to walk deeper level-by-level.
 *
 * Symlinks that escape the project root are filtered out. Results are
 * sliced to `limit` after ranking.
 */
async function listProjectFiles(
  projectPath: string,
  query: string,
  limit: number,
): Promise<PathCandidate[]> {
  let realRoot: string;
  try {
    realRoot = await realpath(projectPath);
  } catch {
    return [];
  }

  const candidates: PathCandidate[] = [];
  const lastSlash = query.lastIndexOf("/");

  if (lastSlash >= 0) {
    // Descent mode: walk ONE specific folder.
    const dirPrefix = query.slice(0, lastSlash); // e.g. "src/nested"
    const tail = query.slice(lastSlash + 1); // e.g. "ap" or ""

    // Honour the exclusion policy in descent mode too: if any segment of
    // the descent prefix is an excluded dir (node_modules / .git /
    // .ezcorp) or a hidden dotfile, return []. Prevents the user from
    // typing `@node_modules/` to sidestep the root-level filter.
    const segments = dirPrefix.split("/").filter((s) => s.length > 0);
    for (const seg of segments) {
      if (seg.startsWith(".")) return [];
      if (EXCLUDED_DIR_NAMES.has(seg)) return [];
    }

    const absDir = dirPrefix ? join(realRoot, dirPrefix) : realRoot;
    await readDirectChildren(realRoot, absDir, dirPrefix, candidates);

    if (!tail) return candidates.slice(0, limit);

    const scored: Array<{ c: PathCandidate; score: number }> = [];
    for (const c of candidates) {
      // Match against the *basename* so the user's typed tail doesn't
      // have to duplicate the prefix they just descended into.
      const lastIdx = c.name.lastIndexOf("/");
      const basename = lastIdx >= 0 ? c.name.slice(lastIdx + 1) : c.name;
      const s = fuzzyScore(tail, basename);
      if (s !== null) scored.push({ c, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.c);
  }

  // No slash: original flat listing (root + one level deep).
  await readDirectChildren(realRoot, realRoot, "", candidates);
  // Descend one level for each root-level dir and add its children.
  const rootDirs = candidates.filter((c) => c.kind === "dir").map((c) => c.name);
  for (const sub of rootDirs) {
    await readDirectChildren(realRoot, join(realRoot, sub), sub, candidates);
  }

  if (!query) return candidates.slice(0, limit);

  const scored: Array<{ c: PathCandidate; score: number }> = [];
  for (const c of candidates) {
    const s = fuzzyScore(query, c.name);
    if (s !== null) scored.push({ c, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.c);
}

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const q = url.searchParams.get("q") ?? "";
  const type = url.searchParams.get("type") as FileType | null;
  const projectId = url.searchParams.get("projectId");
  const results: MentionSearchResult[] = [];
  const lowerQ = q.toLowerCase();
  const pattern = `%${q}%`;

  // Slash-command searches are mutually exclusive with other kinds.
  // The registry merges filesystem + DB sources; we fuzzy-rank by name
  // (or description) and return at most MAX_RESULTS entries. Unlike
  // `type=path`, missing projectId is tolerated — registry falls back
  // to home + DB commands only.
  if (type === "cmd") {
    let projectPath: string | null = null;
    if (projectId) {
      const project = await projectQueries.getProject(projectId);
      projectPath = project?.path ? resolve(project.path) : null;
    }
    const registry = getCommandRegistry();
    const cmds = await registry.listCommands({
      userId: user.id,
      projectId: projectId ?? "global",
      projectPath,
    });

    // Rank registry commands (filesystem + DB). Empty query → natural
    // order; otherwise fuzzy-rank by name or description.
    let ranked: typeof cmds;
    if (!q) {
      ranked = cmds;
    } else {
      const scored: Array<{ c: (typeof cmds)[number]; score: number }> = [];
      for (const c of cmds) {
        const best = bestFuzzyScore([fuzzyScore(q, c.name), fuzzyScore(q, c.description)]);
        if (best !== null) scored.push({ c, score: best });
      }
      scored.sort((a, b) => b.score - a.score);
      ranked = scored.map((s) => s.c);
    }
    for (const c of ranked) {
      results.push({
        name: c.name,
        description: c.description,
        kind: "command",
        source: c.source,
        body: c.body,
      });
    }

    // Surface the built-in `/goal` autopilot as a first-class, discoverable
    // entry. It's a server-side text interceptor (src/runtime/goal-host.ts),
    // NOT a registry command, so we inject it here — gated on the SAME
    // kill-switch the messages route honors, so a disabled server never
    // advertises it. Selecting it inserts LITERAL `/goal ` via `insertText`
    // (a `/[cmd:goal]` token would never match `isGoalCommand()`).
    if (
      parseGoalEnabled(process.env.EZCORP_GOAL_ENABLED) &&
      (!q || fuzzyScore(q, "goal") !== null)
    ) {
      results.unshift({
        name: "goal",
        description: "Set an autonomous goal — the AI keeps working until it's met",
        kind: "command",
        source: "builtin",
        insertText: "/goal ",
      });
    }

    return json(results.slice(0, MAX_RESULTS));
  }

  // EZ Actions searches are mutually exclusive with other kinds — the
  // `!EZ:` prefix's popover lists only EZ actions from the in-memory
  // registry (`src/runtime/ez-actions/registry.ts`). No DB query, no
  // project scope — actions are global, code-defined.
  //
  // Substring match on `name` AND `description` (case-insensitive) so
  // users can find an action by what it does as well as what it's
  // called. Fuzzy ranking is overkill given the tiny registry size in
  // v1 (single digits) — substring is plenty and easier to test.
  //
  // The wire format intentionally surfaces ONLY `name` + `description`
  // + `kind: "EZ"`. The handler function is kept inside the registry
  // — see `listEzActions()`'s contract. This is defense-in-depth: even
  // if the registry shape ever grew more fields, the route would have
  // to be updated explicitly to leak them.
  if (type === "EZ") {
    const { listEzActions } = await import("$server/runtime/ez-actions/registry");
    const actions = listEzActions();
    const matched = q
      ? actions.filter(
          (a) =>
            a.name.toLowerCase().includes(lowerQ) || a.description.toLowerCase().includes(lowerQ),
        )
      : actions;
    for (const a of matched.slice(0, MAX_RESULTS)) {
      results.push({ name: a.name, description: a.description, kind: "EZ" });
    }
    return json(results);
  }

  // Feature-Index searches are mutually exclusive with other kinds —
  // the `$` sigil's popover shows only Feature Index entries scoped to
  // the active project. If no active project (or unknown project),
  // return an empty list instead of falling through to agent/ext/team
  // results. Mirrors the `type === "path"` branch directly below.
  if (type === "feature") {
    if (!projectId) return json([]);
    const project = await projectQueries.getProject(projectId);
    if (!project) return json([]);
    const { listFeatures } = await import("$server/db/queries/features");
    const features = await listFeatures(projectId);

    const matched = q
      ? features
          .map((f) => ({
            f,
            score: bestFuzzyScore([fuzzyScore(q, f.name), fuzzyScore(q, f.description)]),
          }))
          .filter((x): x is { f: (typeof features)[number]; score: number } => x.score !== null)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.f)
      : features;

    for (const f of matched.slice(0, MAX_RESULTS)) {
      results.push({
        name: f.name,
        description: f.description,
        kind: "feature",
        fileCount: f.fileCount,
      });
    }
    return json(results);
  }

  // Lesson searches are mutually exclusive with other kinds — the `%`
  // sigil's popover shows only lesson entries, scoped to the active
  // project AND the requesting user (visibility precedence is enforced
  // inside `searchLessons`: user-scoped beats project-scoped beats
  // global at the same slug). Mirrors the `type === "feature"` branch.
  if (type === "lesson") {
    if (!projectId) return json([]);
    const project = await projectQueries.getProject(projectId);
    if (!project) return json([]);
    const { searchLessons } = await import("$server/db/queries/lessons");
    const lessons = await searchLessons(projectId, user.id, q, MAX_RESULTS);
    for (const lesson of lessons) {
      // Body excerpt drives the popover preview (Builder A's spec).
      // 60-char cap keeps the chip compact; the full body is
      // rendered server-side at expansion time, not here. Append `…`
      // when the body was actually truncated so the user can see
      // there's more content beyond the excerpt — CSS `truncate` on
      // the popover row handles overflow visually but doesn't signal
      // truncation. We slice to 59 + "…" to keep the total at 60.
      const description = lesson.body.length > 60 ? lesson.body.slice(0, 59) + "…" : lesson.body;
      results.push({
        name: lesson.slug,
        description,
        kind: "lesson",
      });
    }
    return json(results);
  }

  // Workflow searches are mutually exclusive with other kinds — the
  // `!workflow:` prefix's popover lists workflows from the merged
  // in-memory cache (`getWorkflows()`: extension + YAML + DB, in that
  // precedence order).
  //
  // NO project gate, unlike `feature` / `lesson`: `workflow_definitions`
  // has no project column — workflows are global. Gating on projectId here
  // would return [] for every global-project chat and read as a scoping
  // control that nothing downstream enforces.
  //
  // Fuzzy-ranked on name + description, mirroring the `feature` branch.
  if (type === "workflow") {
    const workflows = getWorkflows();
    const matched = q
      ? workflows
          .map((w) => ({
            w,
            score: bestFuzzyScore([fuzzyScore(q, w.name), fuzzyScore(q, w.description)]),
          }))
          .filter((x): x is { w: (typeof workflows)[number]; score: number } => x.score !== null)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.w)
      : workflows;

    for (const w of matched.slice(0, MAX_RESULTS)) {
      results.push({ name: w.name, description: w.description, kind: "workflow" });
    }
    return json(results);
  }

  // Phase 4 — tool listing for a specific extension. Used by the
  // `![ext:<name>/` autocomplete path to surface every tool the
  // extension exposes: hand-rolled (manifest `tools[]`) AND auto-
  // generated entity CRUD tools (declared via `entities[]` and merged
  // into the registry's tool surface at load time — see
  // `src/extensions/registry.ts:buildEntityRegisteredTools`).
  //
  // Query shape: `?type=tool&extension=<name>&q=<filter>`. The
  // extension query param is required — without it the result set
  // would explode across every installed extension. Missing param =>
  // empty array (mirrors the empty-projectId fallback for path/feature
  // searches).
  if (type === "tool") {
    const extensionName = url.searchParams.get("extension");
    if (!extensionName) return json([]);
    const { ExtensionRegistry } = await import("$server/extensions/registry");
    const registry = ExtensionRegistry.getInstance();
    const manifest = registry.getManifestByName(extensionName);
    if (!manifest) return json([]);

    // Tool list = hand-rolled tools (already stored on the manifest)
    // + the SDK-auto-generated entity tools the registry surfaces.
    // Pull the latter via the registry's normalized RegisteredTool
    // list so any future changes to the registry's auto-tool shape
    // propagate here without a second derivation site.
    //
    // `getToolsForExtension` returns RegisteredTool[], keyed by the
    // DB id; we need to find that id from the manifest's name first.
    let allTools: Array<{
      name: string;
      description: string;
      entityType?: string;
    }> = [];
    for (const [extId, m] of registry.getAllManifests()) {
      if (m.name !== extensionName) continue;
      const registered = registry.getToolsForExtension(extId);
      allTools = registered.map((t) => ({
        // originalName is the unnamespaced tool name (what the
        // LLM/composer references after `!ext:<name>/`); skip
        // the namespaced form (`<ext>__<tool>`) — that's the
        // LLM-call shape, not the autocomplete shape.
        name: t.originalName,
        description: t.description,
        ...(t.entityType ? { entityType: t.entityType } : {}),
      }));
      break;
    }

    const matched = q
      ? allTools.filter(
          (t) =>
            t.name.toLowerCase().includes(lowerQ) || t.description.toLowerCase().includes(lowerQ),
        )
      : allTools;
    for (const t of matched.slice(0, MAX_RESULTS)) {
      results.push({
        name: t.name,
        description: t.description,
        kind: "tool",
        ...(t.entityType ? { entityType: t.entityType } : {}),
      });
    }
    return json(results);
  }

  // Path searches are mutually exclusive with other kinds — when the `@`
  // sigil is active the popover lists files + dirs only. If no active
  // project (or unknown project), return an empty list instead of falling
  // through to agent/ext/team results.
  if (type === "path") {
    if (!projectId) return json([]);
    const project = await projectQueries.getProject(projectId);
    const projectPath = project?.path ? resolve(project.path) : null;
    if (!projectPath) return json([]);
    const paths = await listProjectFiles(projectPath, q, MAX_RESULTS);
    for (const p of paths) {
      results.push({ name: p.name, description: p.description, kind: p.kind });
    }
    return json(results);
  }

  // Search teams first (unless filtered to agents or extensions only)
  if (type !== "agent" && type !== "ext") {
    const teamConditions = [eq(agentConfigs.category, "team")];
    if (q) {
      teamConditions.push(
        or(ilike(agentConfigs.name, pattern), ilike(agentConfigs.description, pattern))!,
      );
    }
    const teams = await getDb()
      .select({ name: agentConfigs.name, description: agentConfigs.description })
      .from(agentConfigs)
      .where(and(...teamConditions))
      .limit(MAX_RESULTS);
    for (const t of teams) {
      results.push({ name: t.name, description: t.description, kind: "team" });
      if (results.length >= MAX_RESULTS) break;
    }
  }

  // Search agents (unless filtered to extensions or teams only)
  if (type !== "ext" && type !== "team" && results.length < MAX_RESULTS) {
    const teamNames = new Set(results.filter((r) => r.kind === "team").map((r) => r.name));
    const executor = getExecutor();
    const agents = executor.listAgents();
    for (const a of agents) {
      if (teamNames.has(a.name)) continue;
      if (
        !q ||
        a.name.toLowerCase().includes(lowerQ) ||
        a.description.toLowerCase().includes(lowerQ)
      ) {
        results.push({ name: a.name, description: a.description, kind: "agent" });
      }
      if (results.length >= MAX_RESULTS) break;
    }
  }

  // Search extensions (unless filtered to agents or teams only)
  if (type !== "agent" && type !== "team" && results.length < MAX_RESULTS) {
    const remaining = MAX_RESULTS - results.length;
    const conditions = [eq(extensions.enabled, true)];
    if (q) {
      conditions.push(or(ilike(extensions.name, pattern), ilike(extensions.description, pattern))!);
    }
    const exts = await getDb()
      .select({ name: extensions.name, description: extensions.description })
      .from(extensions)
      .where(and(...conditions))
      .limit(remaining);
    for (const e of exts) {
      results.push({ name: e.name, description: e.description, kind: "extension" });
    }
  }

  // Search built-in tool categories (unless filtered to agents or teams only)
  if (type !== "agent" && type !== "team" && results.length < MAX_RESULTS) {
    const { getBuiltInCategories } = await import("$server/runtime/tools/builtin-registry");
    const existingNames = new Set(results.map((r) => r.name));
    for (const cat of getBuiltInCategories()) {
      if (existingNames.has(cat.name)) continue;
      if (
        !q ||
        cat.name.toLowerCase().includes(lowerQ) ||
        cat.description.toLowerCase().includes(lowerQ)
      ) {
        results.push({ name: cat.name, description: cat.description, kind: "extension" });
      }
      if (results.length >= MAX_RESULTS) break;
    }
  }

  // Merge the two GLOBAL `!`-family kinds into the no-colon `!` fallback.
  // `type === "EZ"` / `type === "workflow"` are already handled by their
  // dedicated branches above, so these fire only when the user typed bare
  // `!` / `!e` / `!wo` etc. — discoverability parity with agent/ext/team.
  // Skipped when explicitly filtering to a sibling kind (`!agent:` /
  // `!ext:` / `!team:`).
  if (type !== "agent" && type !== "ext" && type !== "team") {
    const { listEzActions } = await import("$server/runtime/ez-actions/registry");
    mergeGlobalBangKind(results, listEzActions(), "ez", "EZ", lowerQ);
    mergeGlobalBangKind(results, getWorkflows(), "workflow", "workflow", lowerQ);
  }

  return json(results);
};
