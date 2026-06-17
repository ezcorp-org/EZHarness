/**
 * Pure source-mutation helpers for an extension draft's
 * `ezcorp.config.ts` (Phase 4 authoring UX §5.3).
 *
 * The author flow edits raw files (file-tree + textarea); the
 * "Use other extensions" panel and the capability toggles need to write
 * `manifest.dependencies` and `permissions.<cap>` into the
 * `defineExtension({ … })` call WITHOUT a hand-edit. Rather than pull a
 * full TS parser, we do anchored, surgical edits against the scaffold's
 * known shape and fall back GRACEFULLY (return the source unchanged +
 * `recognized: false`) when the structure isn't parseable — the panel
 * then disables itself and tells the author to hand-edit. We never
 * corrupt the file.
 *
 * Generated blocks are delimited so a re-edit replaces them cleanly:
 *   // ezcorp:dependencies (managed)
 *   dependencies: { … },
 *   // ezcorp:dependencies:end
 *
 * No Svelte, no fetch — fully unit-testable.
 */

/** A declared dependency (name → {source, version}); mirrors
 *  `DependencySpec` in `src/extensions/types.ts`. */
export interface DependencyEntry {
  name: string;
  source: string;
  version: string;
}

/** The host capabilities the toggles row can opt into. */
export const TOGGLEABLE_CAPABILITIES = ["search", "memory", "llm"] as const;
export type ToggleableCapability = (typeof TOGGLEABLE_CAPABILITIES)[number];

const DEP_BEGIN = "// ezcorp:dependencies (managed)";
const DEP_END = "// ezcorp:dependencies:end";

/** Whether the source is a recognizable `defineExtension({ … })` config
 *  the surgical edits can safely operate on. */
export function isRecognizedConfig(source: string): boolean {
  // Must call defineExtension with an object literal AND declare a
  // top-level `permissions:` field (the scaffold always does) — that's
  // our insertion anchor.
  return /defineExtension\s*\(\s*\{/.test(source) && /\n\s*permissions\s*:/.test(source);
}

/** Indentation of the `permissions:` line (so inserted blocks line up). */
function permissionsIndent(source: string): string {
  const m = source.match(/\n([ \t]*)permissions\s*:/);
  return m ? m[1]! : "  ";
}

// ── Dependencies ────────────────────────────────────────────────────

/** Read the declared dependencies out of a managed block, for prefill.
 *  Only reads OUR managed block (a hand-written `dependencies:` outside it
 *  is left to the author and reported as unrecognized → panel read-only).
 */
export function parseDependencies(source: string): DependencyEntry[] {
  const block = extractManagedDepBlock(source);
  if (block === null) return [];
  const entries: DependencyEntry[] = [];
  // Match: "name": { source: "…", version: "…" }
  const re = /["']([^"']+)["']\s*:\s*\{\s*source\s*:\s*["']([^"']*)["']\s*,\s*version\s*:\s*["']([^"']*)["']\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    entries.push({ name: m[1]!, source: m[2]!, version: m[3]! });
  }
  return entries;
}

function extractManagedDepBlock(source: string): string | null {
  const start = source.indexOf(DEP_BEGIN);
  const end = source.indexOf(DEP_END);
  if (start === -1 || end === -1 || end < start) return null;
  return source.slice(start + DEP_BEGIN.length, end);
}

/** Render the managed dependencies block (delimited, indented). */
function renderDepBlock(deps: DependencyEntry[], indent: string): string {
  if (deps.length === 0) return "";
  const inner = deps
    .map((d) => `${indent}  ${JSON.stringify(d.name)}: { source: ${JSON.stringify(d.source)}, version: ${JSON.stringify(d.version)} },`)
    .join("\n");
  return `${indent}${DEP_BEGIN}\n${indent}dependencies: {\n${inner}\n${indent}},\n${indent}${DEP_END}\n`;
}

/**
 * Write the managed `dependencies` block into the config. Replaces an
 * existing managed block, or inserts a fresh one immediately BEFORE the
 * `permissions:` line. An empty `deps` removes the managed block.
 * Returns `{ source, recognized }`; on an unrecognized config the source
 * is returned UNCHANGED.
 */
export function setDependencies(
  source: string,
  deps: DependencyEntry[],
): { source: string; recognized: boolean } {
  if (!isRecognizedConfig(source)) return { source, recognized: false };
  const indent = permissionsIndent(source);

  // Strip any existing managed block first (idempotent re-edit).
  let next = stripManagedDepBlock(source);

  const block = renderDepBlock(deps, indent);
  if (block !== "") {
    next = next.replace(/(\n[ \t]*permissions\s*:)/, `\n${block}$1`);
  }
  return { source: next, recognized: true };
}

function stripManagedDepBlock(source: string): string {
  const start = source.indexOf(DEP_BEGIN);
  const end = source.indexOf(DEP_END);
  if (start === -1 || end === -1 || end < start) return source;
  // Remove from the start of the BEGIN line through the end of the END line
  // (including the trailing newline) — find the line boundaries.
  const lineStart = source.lastIndexOf("\n", start) + 1;
  const afterEnd = source.indexOf("\n", end);
  const lineEnd = afterEnd === -1 ? source.length : afterEnd + 1;
  return source.slice(0, lineStart) + source.slice(lineEnd);
}

// ── Unresolved-dependency warning (§5.3 — non-fatal) ────────────────

/** An installed extension, as far as dependency resolution cares. */
export interface InstalledExtensionRef {
  name: string;
  version: string;
}

/**
 * Which declared dependencies CANNOT be resolved against the installed
 * set — by NAME (the dominant unresolvable case; `buildDepRoutes`
 * silently drops these at runtime). This is a non-fatal AUTHORING /
 * install warning, NOT an enforcement: install still proceeds.
 *
 * Name-based to mirror the runtime's first resolution step (it matches a
 * candidate by `name` then checks the version range); a declared name
 * absent from every installed extension is the unambiguous "this will be
 * dropped" signal. Returns the unresolved dependency names (dedup,
 * declaration order).
 */
export function unresolvedDependencies(
  declared: DependencyEntry[],
  installed: InstalledExtensionRef[],
): string[] {
  const installedNames = new Set(installed.map((e) => e.name));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dep of declared) {
    if (!installedNames.has(dep.name) && !seen.has(dep.name)) {
      seen.add(dep.name);
      out.push(dep.name);
    }
  }
  return out;
}

// ── Capability permissions ──────────────────────────────────────────

/**
 * Read which toggleable host capabilities the config's `permissions`
 * block currently declares. A capability is "on" when the permissions
 * object has the key with a truthy value (`"inherit"`, an object, etc.);
 * `false` (explicitly disabled) reads as OFF for the toggle.
 */
export function parseCapabilities(source: string): Record<ToggleableCapability, boolean> {
  const out = { search: false, memory: false, llm: false };
  const perms = extractPermissionsBody(source);
  if (perms === null) return out;
  for (const cap of TOGGLEABLE_CAPABILITIES) {
    // key: <value> where value is not `false` and not absent.
    const re = new RegExp(`(?:["']?)${cap}(?:["']?)\\s*:\\s*([^,\\n}]+)`);
    const m = perms.match(re);
    if (m) {
      const val = m[1]!.trim();
      out[cap] = val !== "false";
    }
  }
  return out;
}

/** Locate the `permissions: { … }` block — the `{` and matching `}`
 *  offsets. Returns null when absent or brace-unbalanced. Single
 *  brace-walker shared by the read + write paths (no duplicated dead
 *  null-branch). */
function findPermissionsBraces(source: string): { open: number; close: number } | null {
  const m = source.match(/permissions\s*:\s*\{/);
  if (!m || m.index === undefined) return null;
  const open = source.indexOf("{", m.index);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return { open, close: i };
    }
  }
  return null;
}

/** Extract the text BETWEEN the `permissions: {` and its matching `}`. */
function extractPermissionsBody(source: string): string | null {
  const b = findPermissionsBraces(source);
  return b === null ? null : source.slice(b.open + 1, b.close);
}

/**
 * Set the toggleable capabilities on the `permissions` block. An enabled
 * capability is written as `<cap>: "inherit"` (the §3.1 grant shape that
 * `clampSearchPermission` admits); a disabled one is REMOVED (absent =
 * not requested, the manifest default). Other permission fields are left
 * untouched. Returns the source unchanged on an unrecognized config.
 */
export function setCapabilityPermissions(
  source: string,
  caps: Record<ToggleableCapability, boolean>,
): { source: string; recognized: boolean } {
  if (!isRecognizedConfig(source)) return { source, recognized: false };
  const braces = findPermissionsBraces(source);
  // Unbalanced / absent permissions braces — degrade safely.
  if (braces === null) return { source, recognized: false };
  let body = source.slice(braces.open + 1, braces.close);

  // Remove any existing managed capability lines, then re-add the enabled
  // ones. We only manage the toggleable keys — never touch others.
  for (const cap of TOGGLEABLE_CAPABILITIES) {
    body = body.replace(new RegExp(`\\n?[ \\t]*(?:["']?)${cap}(?:["']?)\\s*:\\s*[^,\\n}]+,?`, "g"), "");
  }
  const indent = permissionsIndent(source);
  const enabled = TOGGLEABLE_CAPABILITIES.filter((c) => caps[c]);
  const added = enabled.map((c) => `${indent}  ${c}: "inherit",`).join("\n");

  // Rebuild the permissions inner body: keep existing (trimmed) content +
  // the managed capability lines, normalized (no leading/trailing blank
  // lines). An empty result yields `permissions: {}`.
  const kept = body.replace(/^\s*\n/, "").replace(/\n\s*$/, "").trim();
  const parts: string[] = [];
  if (kept.length > 0) parts.push(`${indent}  ${kept}`);
  if (added.length > 0) parts.push(added);
  const newBody = parts.length > 0 ? `\n${parts.join("\n")}\n${indent}` : "";

  const rebuilt = source.slice(0, braces.open + 1) + newBody + source.slice(braces.close);
  return { source: rebuilt, recognized: true };
}
