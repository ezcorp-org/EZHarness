// ── config.ts — per-folder config schema + validation ──────────────
//
// Pure config logic. `config.json` is the single source of truth for
// which folders are watched, in what mode, with which presets/rules and
// ignores. The host daemon reads it each tick; the chat agent and the
// events route write it. No IO here — validation + normalization only.

import { isAbsolute, normalize, sep } from "node:path";
import type { Rule } from "./rules";
import { PRESET_NAMES } from "./rules";

/** Per-folder + global organization mode. */
export type Mode = "ask-everything" | "approve-non-destructive-only" | "fully-auto";

export const MODES: Mode[] = ["ask-everything", "approve-non-destructive-only", "fully-auto"];

/** First-run policy for a newly-added folder. */
export type BacklogPolicy = "new-only" | "include-existing";

/** A single watched folder's configuration. */
export interface FolderConfig {
  id: string;
  /** Absolute, normalized path. */
  path: string;
  /** Per-folder mode override; falls back to global `default_mode` setting. */
  mode?: Mode;
  presets: string[];
  customRules: Rule[];
  ignore: string[];
  backlogPolicy: BacklogPolicy;
  /** Epoch (ms) set at add-time for `new-only` — files older are skipped. */
  epochMs?: number;
}

export interface Config {
  folders: FolderConfig[];
  globalIgnore: string[];
  schemaVersion: number;
}

export const CONFIG_SCHEMA_VERSION = 1;

/** Ignores that can NEVER be removed — always excluded from any watch. */
export const NON_REMOVABLE_IGNORES = [".ezcorp/data", ".git", "node_modules"] as const;

/** Default empty config — first-run state (ask-everything, zero folders). */
export function emptyConfig(): Config {
  return { folders: [], globalIgnore: [...NON_REMOVABLE_IGNORES], schemaVersion: CONFIG_SCHEMA_VERSION };
}

// ── Path helpers ────────────────────────────────────────────────────

/** Normalize an absolute path: collapse `..`/`.`, strip trailing slash
 *  (except root). Returns null for non-absolute or control-char paths. */
export function normalizeFolderPath(p: string): string | null {
  if (typeof p !== "string" || p.length === 0) return null;
  // Reject NUL/newline embedded in paths (defense-in-depth).
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c === 0 || c === 0x0a || c === 0x0d) return null;
  }
  if (!isAbsolute(p)) return null;
  let n = normalize(p);
  if (n.length > 1 && n.endsWith(sep)) n = n.slice(0, -1);
  return n;
}

/** Is `child` the same path as, or nested under, `parent`? Both must be
 *  pre-normalized absolute paths. */
export function isWithin(parent: string, child: string): boolean {
  if (parent === child) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

/**
 * Does any path in `ignores` cover `target`? An ignore matches when it is
 * a path-segment-bounded substring of the target. Both relative segment
 * names (`node_modules`) and absolute prefixes are supported. Ignore
 * ALWAYS wins over watch.
 */
export function isIgnored(target: string, ignores: string[]): boolean {
  const segments = target.split(sep).filter(Boolean);
  for (const ig of ignores) {
    if (ig.length === 0) continue;
    if (isAbsolute(ig)) {
      if (isWithin(normalize(ig), target)) return true;
      continue;
    }
    // Relative ignore: match as a contiguous run of path segments.
    const igSegs = ig.split("/").filter(Boolean);
    for (let i = 0; i + igSegs.length <= segments.length; i++) {
      let all = true;
      for (let j = 0; j < igSegs.length; j++) {
        if (segments[i + j] !== igSegs[j]) { all = false; break; }
      }
      if (all) return true;
    }
  }
  return false;
}

/** Does a path contain a `.ezcorp/data` segment? Such folders are refused
 *  (the host computes this — never config-steerable). */
export function containsEzcorpData(p: string): boolean {
  return isIgnored(p, [".ezcorp/data"]) || normalize(p).includes(`.ezcorp${sep}data`);
}

// ── Reachability (container-visibility) probe ───────────────────────

export type ReachabilityResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/** The canonical "mount it + restart" message shown when a host folder
 *  isn't visible inside the EZCorp container. */
export const NOT_VISIBLE_MESSAGE =
  "That path isn't visible to the EZCorp container — mount it under your watch root (or via docker-compose.override.yml) and restart.";

/**
 * Validate a candidate watched-folder path against a visibility probe.
 * Pure: the IO probe (`exists`) is injected. Combines the static guards
 * (absolute, control-char-free, not `.ezcorp/data`) with a container
 * exists-probe — an unreachable path returns the "mount it + restart"
 * message instead of silently watching nothing.
 */
export function checkReachability(
  rawPath: string,
  exists: (p: string) => boolean,
): ReachabilityResult {
  const path = normalizeFolderPath(rawPath);
  if (path === null) return { ok: false, error: "Path must be an absolute, valid filesystem path." };
  if (containsEzcorpData(path)) return { ok: false, error: "Refusing to watch a folder containing .ezcorp/data." };
  if (!exists(path)) return { ok: false, error: NOT_VISIBLE_MESSAGE };
  return { ok: true, path };
}

// ── Folder add / validation ─────────────────────────────────────────

export type AddFolderResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

/**
 * Add a watched folder to the config, applying all guards:
 *   - path must be absolute + normalizable + control-char-free
 *   - refuse a folder that contains `.ezcorp/data`
 *   - normalize ancestor/descendant overlaps: if the new folder is an
 *     ancestor of an existing one, the descendant is dropped (keep
 *     ancestor); if it's a descendant of an existing one, it's refused
 *     (already covered)
 *   - presets validated against the known set
 *
 * Pure — returns a new Config or an error. `epochMs` is stamped for ALL
 * backlog policies — it marks "watch start" (when this folder began being
 * watched). `new-only` uses it to skip pre-existing files for rule-matching;
 * `include-existing` still rule-processes existing files, but `epochMs`
 * additionally defines which unmatched files are "new" enough to flag as
 * `unclassified`.
 */
export function addFolder(
  config: Config,
  input: {
    path: string;
    mode?: Mode;
    presets?: string[];
    ignore?: string[];
    backlogPolicy: BacklogPolicy;
    now: number;
    idGen: () => string;
  },
): AddFolderResult {
  const path = normalizeFolderPath(input.path);
  if (path === null) return { ok: false, error: "Path must be an absolute, valid filesystem path." };
  if (containsEzcorpData(path)) {
    return { ok: false, error: "Refusing to watch a folder containing .ezcorp/data." };
  }

  // Descendant of an existing watched folder → already covered.
  for (const f of config.folders) {
    if (f.path === path) return { ok: false, error: "That folder is already being watched." };
    if (isWithin(f.path, path)) {
      return { ok: false, error: `Already covered by watched folder ${f.path}.` };
    }
  }

  // New folder is an ancestor of existing folders → drop the descendants.
  const survivors = config.folders.filter((f) => !isWithin(path, f.path));

  const presets = (input.presets ?? []).filter((p) => PRESET_NAMES.includes(p));
  const folder: FolderConfig = {
    id: input.idGen(),
    path,
    ...(input.mode ? { mode: input.mode } : {}),
    presets,
    customRules: [],
    ignore: input.ignore ?? [],
    backlogPolicy: input.backlogPolicy,
    epochMs: input.now,
  };
  return { ok: true, config: { ...config, folders: [...survivors, folder] } };
}

/** Remove a folder by id (cancels nothing here — that's the caller's job).
 *  Returns a new Config; no-op if id absent. */
export function removeFolder(config: Config, folderId: string): Config {
  return { ...config, folders: config.folders.filter((f) => f.id !== folderId) };
}

/** Set a folder's mode. Returns new Config; no-op if id absent or mode invalid. */
export function setFolderMode(config: Config, folderId: string, mode: Mode): Config {
  if (!MODES.includes(mode)) return config;
  return {
    ...config,
    folders: config.folders.map((f) => (f.id === folderId ? { ...f, mode } : f)),
  };
}

/** Toggle a preset on a folder. Returns new Config; unknown presets ignored. */
export function toggleFolderPreset(config: Config, folderId: string, preset: string): Config {
  if (!PRESET_NAMES.includes(preset)) return config;
  return {
    ...config,
    folders: config.folders.map((f) => {
      if (f.id !== folderId) return f;
      const has = f.presets.includes(preset);
      return { ...f, presets: has ? f.presets.filter((p) => p !== preset) : [...f.presets, preset] };
    }),
  };
}

/** Set a folder's backlog policy; stamps/clears `epochMs` accordingly. */
export function setBacklogPolicy(
  config: Config,
  folderId: string,
  policy: BacklogPolicy,
  now: number,
): Config {
  return {
    ...config,
    folders: config.folders.map((f) => {
      if (f.id !== folderId) return f;
      return policy === "new-only"
        ? { ...f, backlogPolicy: policy, epochMs: f.epochMs ?? now }
        : { ...f, backlogPolicy: policy, epochMs: undefined };
    }),
  };
}

/** Add an ignore entry to a folder (deduped). Returns new Config. */
export function addFolderIgnore(config: Config, folderId: string, entry: string): Config {
  if (entry.trim().length === 0) return config;
  return {
    ...config,
    folders: config.folders.map((f) => {
      if (f.id !== folderId) return f;
      return f.ignore.includes(entry) ? f : { ...f, ignore: [...f.ignore, entry] };
    }),
  };
}

/** Add a custom rule to a folder (deduped by rule id). Returns new Config. */
export function addFolderRule(config: Config, folderId: string, rule: Rule): Config {
  return {
    ...config,
    folders: config.folders.map((f) => {
      if (f.id !== folderId) return f;
      return f.customRules.some((r) => r.id === rule.id)
        ? f
        : { ...f, customRules: [...f.customRules, rule] };
    }),
  };
}

/** Effective ignore list for a folder = non-removable + global + per-folder. */
export function effectiveIgnores(config: Config, folder: FolderConfig): string[] {
  return Array.from(
    new Set([...NON_REMOVABLE_IGNORES, ...config.globalIgnore, ...folder.ignore]),
  );
}

// ── Validation / migration ──────────────────────────────────────────

/**
 * Validate + normalize a raw config object (e.g. parsed from disk or
 * written by the agent). Drops malformed folders, re-applies the
 * non-removable ignores, normalizes paths, and removes overlaps. Always
 * returns a usable Config (never throws).
 */
export function validateConfig(raw: unknown): Config {
  if (!raw || typeof raw !== "object") return emptyConfig();
  const r = raw as Partial<Config>;
  const folders: FolderConfig[] = [];
  const seen: string[] = [];

  for (const f of Array.isArray(r.folders) ? r.folders : []) {
    if (!f || typeof f !== "object") continue;
    const fc = f as Partial<FolderConfig>;
    const path = typeof fc.path === "string" ? normalizeFolderPath(fc.path) : null;
    if (path === null || containsEzcorpData(path)) continue;
    // Skip descendants of an already-kept folder; drop kept descendants of this one.
    if (seen.some((s) => isWithin(s, path) && s !== path) || seen.includes(path)) continue;
    // Remove any previously-kept folder nested under this new ancestor.
    for (let i = folders.length - 1; i >= 0; i--) {
      if (isWithin(path, folders[i]!.path) && folders[i]!.path !== path) {
        seen.splice(seen.indexOf(folders[i]!.path), 1);
        folders.splice(i, 1);
      }
    }
    folders.push({
      id: typeof fc.id === "string" && fc.id.length > 0 ? fc.id : `f-${seen.length}`,
      path,
      ...(typeof fc.mode === "string" && MODES.includes(fc.mode) ? { mode: fc.mode } : {}),
      presets: Array.isArray(fc.presets) ? fc.presets.filter((p) => PRESET_NAMES.includes(p)) : [],
      customRules: Array.isArray(fc.customRules) ? (fc.customRules as Rule[]) : [],
      ignore: Array.isArray(fc.ignore) ? fc.ignore.filter((x) => typeof x === "string") : [],
      backlogPolicy: fc.backlogPolicy === "include-existing" ? "include-existing" : "new-only",
      ...(typeof fc.epochMs === "number" ? { epochMs: fc.epochMs } : {}),
    });
    seen.push(path);
  }

  const globalIgnore = Array.from(
    new Set([
      ...NON_REMOVABLE_IGNORES,
      ...(Array.isArray(r.globalIgnore) ? r.globalIgnore.filter((x) => typeof x === "string") : []),
    ]),
  );

  return { folders, globalIgnore, schemaVersion: CONFIG_SCHEMA_VERSION };
}
