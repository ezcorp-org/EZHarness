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
 * Locate a top-level `<cap>:` key inside a permissions BODY and return
 * the span of its value — BRACE-AWARE so an object value (`{ … }`) is
 * captured whole, not truncated at its first nested `}`. `keyStart` is
 * the offset of the key; `valStart`/`valEnd` bound the trimmed value;
 * `entryEnd` is the offset just past the trailing comma (if any).
 * Returns null when the cap key isn't present.
 */
function findCapValueSpan(
  body: string,
  cap: string,
): { keyStart: number; valStart: number; valEnd: number; entryEnd: number } | null {
  const keyRe = new RegExp(`(?:^|[\\s,{])(["']?)${cap}\\1\\s*:`, "g");
  const km = keyRe.exec(body);
  if (km === null) return null;
  const keyStart = km.index + (km[0]!.match(/^[\s,{]/) ? 1 : 0);
  // Value starts after the colon.
  let i = body.indexOf(":", keyStart) + 1;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  const valStart = i;
  // Walk the value: a `{`-opened value consumes to its matching `}`;
  // otherwise to the next top-level `,` or `}` or end.
  if (body[i] === "{") {
    let depth = 0;
    for (; i < body.length; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
  } else {
    while (i < body.length && body[i] !== "," && body[i] !== "}" && body[i] !== "\n") i++;
  }
  const valEnd = i;
  // Consume a trailing comma (and the whitespace before it stays put).
  let entryEnd = valEnd;
  while (entryEnd < body.length && /\s/.test(body[entryEnd]!) && body[entryEnd] !== "\n") entryEnd++;
  if (body[entryEnd] === ",") entryEnd++;
  return { keyStart, valStart, valEnd, entryEnd };
}

/** The raw (trimmed) value text of a cap key, or null when absent. */
function capValueText(body: string, cap: string): string | null {
  const span = findCapValueSpan(body, cap);
  return span === null ? null : body.slice(span.valStart, span.valEnd).trim();
}

/**
 * A cap value the simple on/off toggle CANNOT faithfully represent: an
 * OBJECT (`{ … }` — a custom field-level ceiling) or an explicit `false`.
 * These are UNMANAGED — the toggle leaves them byte-for-byte untouched
 * (mirrors the Phase-3 multi-provider preserve-guard: never corrupt, and
 * never silently widen a hand-set ceiling to "inherit").
 */
function isUnmanagedCapValue(val: string | null): boolean {
  if (val === null) return false;
  return val.startsWith("{") || val === "false";
}

/**
 * Which toggleable caps carry an UNMANAGED value (object / `false`) the
 * panel must show read-only — toggling them is disabled so the on/off
 * control can't corrupt or widen a hand-written ceiling.
 */
export function unmanagedCapabilities(source: string): ToggleableCapability[] {
  const body = extractPermissionsBody(source);
  if (body === null) return [];
  return TOGGLEABLE_CAPABILITIES.filter((cap) => isUnmanagedCapValue(capValueText(body, cap)));
}

/**
 * Read which toggleable host capabilities the config's `permissions`
 * block currently declares. A capability is "on" when present with a
 * truthy value (`"inherit"`, an object ceiling, etc.); `false` (or
 * absent) reads as OFF. Brace-aware so an object value is read whole.
 */
export function parseCapabilities(source: string): Record<ToggleableCapability, boolean> {
  const out = { search: false, memory: false, llm: false };
  const body = extractPermissionsBody(source);
  if (body === null) return out;
  for (const cap of TOGGLEABLE_CAPABILITIES) {
    const val = capValueText(body, cap);
    if (val !== null) out[cap] = val !== "false";
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
 * (managed) capability is written as `<cap>: "inherit"` (the §3.1 grant
 * shape `clampSearchPermission` admits); a disabled one is REMOVED (absent
 * = not requested). Other permission fields are left untouched.
 *
 * UNMANAGED caps — those whose CURRENT value is an OBJECT ceiling or
 * `false` — are left BYTE-FOR-BYTE untouched regardless of `caps[cap]`:
 * the simple on/off toggle can't faithfully represent (or safely rewrite)
 * a hand-set ceiling, so we never corrupt it AND never silently widen it
 * to "inherit" (mirrors the Phase-3 multi-provider preserve-guard). The
 * panel disables the toggle for these (`unmanagedCapabilities`).
 *
 * The cap-entry removal is BRACE-AWARE (`findCapValueSpan`), so an object
 * value is handled whole — the file always stays valid TS.
 *
 * Returns the source unchanged on an unrecognized / brace-unbalanced
 * config.
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

  const unmanaged = new Set(
    TOGGLEABLE_CAPABILITIES.filter((c) => isUnmanagedCapValue(capValueText(body, c))),
  );

  // Remove only the MANAGED toggleable cap entries (brace-aware so an
  // object value is excised whole, never truncated). Unmanaged entries
  // stay exactly where they are. Re-find the span each pass since offsets
  // shift after a removal.
  for (const cap of TOGGLEABLE_CAPABILITIES) {
    if (unmanaged.has(cap)) continue;
    const span = findCapValueSpan(body, cap);
    if (span !== null) {
      // Also swallow the leading whitespace/newline of the removed entry.
      let lineStart = span.keyStart;
      while (lineStart > 0 && /[ \t]/.test(body[lineStart - 1]!)) lineStart--;
      if (lineStart > 0 && body[lineStart - 1] === "\n") lineStart--;
      body = body.slice(0, lineStart) + body.slice(span.entryEnd);
    }
  }

  const indent = permissionsIndent(source);
  // Only ADD enabled caps that aren't unmanaged (an unmanaged cap keeps
  // its hand-written ceiling — the toggle is a no-op for it).
  const enabled = TOGGLEABLE_CAPABILITIES.filter((c) => caps[c] && !unmanaged.has(c));
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
