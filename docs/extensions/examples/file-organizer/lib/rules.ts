// ── rules.ts — rule schema, presets, matchers, mini-DSL ─────────────
//
// Pure matching logic. A `Rule` decides whether a candidate file should
// be moved/routed or quarantined as garbage. All matchers are pure
// functions over a `FileFacts` snapshot — no IO, no fs.
//
// Garbage recognition is split across four matcher families: junk
// (regex/glob on name), duplicate (sha256), stale (age), and
// size/clutter (byte threshold). Routing rules send new files to a
// destination subfolder.

import { extname } from "node:path";

/** What a rule does when it matches. */
export type RuleAction = "quarantine" | "route" | "rename";

/** Facts about a candidate file the matchers read. Snapshot-derived. */
export interface FileFacts {
  /** Absolute path of the file. */
  path: string;
  /** Basename (last path segment). */
  name: string;
  /** Lowercased extension WITHOUT the dot (e.g. "tmp"), or "". */
  ext: string;
  size: number;
  mtimeMs: number;
  /** sha256 hex, when available (small files / cache hit). */
  sha256?: string;
  isSymlink: boolean;
  nlink: number;
}

/** A single rule. `predicate` is the structured matcher spec. */
export interface Rule {
  id: string;
  label: string;
  action: RuleAction;
  predicate: RulePredicate;
  /** For `route`/`rename`: destination subfolder (relative to watched root). */
  dest?: string;
  /** True for the built-in destructive-garbage presets. */
  destructive: boolean;
}

/** Structured matcher spec. A rule matches when ALL present clauses match. */
export interface RulePredicate {
  /** Glob-ish name pattern, e.g. `*.tmp`. Compiled to a safe regex. */
  glob?: string;
  /** Match files older than this many ms (now - mtimeMs > olderThanMs). */
  olderThanMs?: number;
  /** Match files larger than this many bytes. */
  largerThanBytes?: number;
  /** Match exact extension (without dot, lowercase). */
  ext?: string;
  /** Mark as duplicate-by-content (resolved against a hash index elsewhere). */
  duplicate?: boolean;
}

// ── ReDoS guard + glob compilation ──────────────────────────────────

/** Max input length a name-matcher will consider — names beyond this are
 *  treated as non-matching (defense against pathological inputs). */
export const MAX_NAME_LENGTH = 1024;

/**
 * Compile a `*.tmp`-style glob into an ANCHORED regex over the basename.
 * Only `*` (any run) and `?` (single char) are special; everything else
 * is escaped. No alternation, backreferences, or nested quantifiers — so
 * the result is linear-time (ReDoS-safe by construction).
 */
export function compileGlob(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${pattern}$`, "i");
}

/** Test a name against a glob with the length guard. */
export function globMatches(glob: string, name: string): boolean {
  if (name.length > MAX_NAME_LENGTH) return false;
  return compileGlob(glob).test(name);
}

/** True if `s` contains any ASCII control character (NUL, newline, etc.).
 *  Used to reject malformed mini-DSL globs without an inline control regex. */
export function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

// ── Circuit breaker ─────────────────────────────────────────────────

/** Default circuit-breaker threshold: if a single rule would act on more
 *  than this FRACTION of a folder's files in one tick, pause it. */
export const CIRCUIT_BREAKER_FRACTION = 0.5;

/**
 * Given how many files a rule matched out of how many were scanned in a
 * folder this tick, decide whether the rule should be PAUSED (circuit
 * tripped) rather than acted on — a guard against a too-broad rule
 * nuking a whole folder.
 */
export function circuitTripped(
  matched: number,
  scanned: number,
  fraction: number = CIRCUIT_BREAKER_FRACTION,
): boolean {
  if (scanned <= 0) return false;
  if (matched < 2) return false; // a 1-of-1 folder isn't a runaway rule
  return matched / scanned > fraction;
}

// ── Matchers ────────────────────────────────────────────────────────

/**
 * Does a rule match a file? Pure. A `duplicate` predicate requires the
 * caller to have ALREADY decided duplication (the daemon resolves
 * sha256 collisions and passes `isDuplicate`); this function just honors
 * the flag.
 */
export function ruleMatches(
  rule: Rule,
  facts: FileFacts,
  ctx: { now: number; isDuplicate?: boolean } = { now: Date.now() },
): boolean {
  // Symlinks/hardlinks are never garbage-collected by default (v1).
  if (facts.isSymlink) return false;
  const p = rule.predicate;

  if (p.duplicate) {
    if (!ctx.isDuplicate) return false;
    if (facts.nlink > 1) return false; // hardlinks excluded from dedup-delete
  }
  if (p.glob !== undefined && !globMatches(p.glob, facts.name)) return false;
  if (p.ext !== undefined && facts.ext !== p.ext.toLowerCase()) return false;
  if (p.olderThanMs !== undefined && ctx.now - facts.mtimeMs <= p.olderThanMs) return false;
  if (p.largerThanBytes !== undefined && facts.size <= p.largerThanBytes) return false;

  // A predicate with no clauses never matches (avoids matching everything).
  const hasClause =
    p.glob !== undefined ||
    p.ext !== undefined ||
    p.olderThanMs !== undefined ||
    p.largerThanBytes !== undefined ||
    p.duplicate === true;
  return hasClause;
}

/** Derive `FileFacts.ext` (lowercase, no dot) from a basename. */
export function extOf(name: string): string {
  const e = extname(name);
  return e.startsWith(".") ? e.slice(1).toLowerCase() : e.toLowerCase();
}

// ── Presets ─────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum age before a bare `*.tmp` is eligible for the destructive
 * junk-sweep. Atomic-writer libraries (write-temp → fsync → rename) create
 * a `.tmp` in one syscall, go quiescent (so the stability gate sees it as
 * settled within a couple of ticks), then rename it away. Without a dwell
 * guard the sweep could quarantine that fresh temp mid-operation — a
 * data-loss race. 10 minutes is far longer than any rename window yet
 * still sweeps genuinely-abandoned temps. `.bak`/`.DS_Store`/`Thumbs.db`
 * have no atomic-writer pattern, so they stay age-free.
 */
export const JUNK_TMP_MIN_AGE_MS = 10 * 60 * 1000;

/** The four built-in preset rule templates. */
export const PRESETS: Record<string, Rule[]> = {
  "junk-sweep": [
    { id: "junk-tmp", label: "Temp files (*.tmp, ≥10m old)", action: "quarantine", predicate: { glob: "*.tmp", olderThanMs: JUNK_TMP_MIN_AGE_MS }, destructive: true },
    { id: "junk-bak", label: "Backup files (*.bak)", action: "quarantine", predicate: { glob: "*.bak" }, destructive: true },
    { id: "junk-ds-store", label: "macOS .DS_Store", action: "quarantine", predicate: { glob: ".DS_Store" }, destructive: true },
    { id: "junk-thumbs", label: "Windows Thumbs.db", action: "quarantine", predicate: { glob: "Thumbs.db" }, destructive: true },
    { id: "junk-log-old", label: "Old logs (*.log older 30d)", action: "quarantine", predicate: { glob: "*.log", olderThanMs: 30 * DAY_MS }, destructive: true },
  ],
  "downloads-router": [
    { id: "route-images", label: "Images → Images/", action: "route", dest: "Images", predicate: { glob: "*.png" }, destructive: false },
    { id: "route-pdf", label: "PDFs → Documents/", action: "route", dest: "Documents", predicate: { glob: "*.pdf" }, destructive: false },
    { id: "route-zip", label: "Archives → Archives/", action: "route", dest: "Archives", predicate: { glob: "*.zip" }, destructive: false },
    { id: "route-dmg", label: "Installers → Installers/", action: "route", dest: "Installers", predicate: { glob: "*.dmg" }, destructive: false },
  ],
  "duplicate-killer": [
    { id: "dup-content", label: "Duplicate files (by content)", action: "quarantine", predicate: { duplicate: true }, destructive: true },
  ],
  "stale-archiver": [
    { id: "stale-90d", label: "Stale files (older 90d) → Archive/", action: "route", dest: "Archive", predicate: { olderThanMs: 90 * DAY_MS }, destructive: false },
  ],
};

/** All valid preset names. */
export const PRESET_NAMES = Object.keys(PRESETS);

/** Expand a list of preset names into their rules (unknown names skipped). */
export function expandPresets(names: string[]): Rule[] {
  const out: Rule[] = [];
  for (const n of names) {
    const rules = PRESETS[n];
    if (rules) out.push(...rules);
  }
  return out;
}

// ── Mini-DSL ────────────────────────────────────────────────────────
//
// A tiny deterministic one-line rule grammar so users can author quick
// rules from a single Hub prompt:
//
//   "<glob> [older <Nd|Nh>] [larger <Nmb|Nkb>] -> <quarantine|DEST>"
//
// Examples:
//   *.tmp older 7d -> quarantine
//   *.zip larger 100mb -> Archives
//
// Parser is hand-rolled, total, and never throws — malformed input
// returns `{ ok: false, error }`.

export type DslParseResult =
  | { ok: true; rule: Rule }
  | { ok: false; error: string };

const DURATION_RE = /^(\d+)(d|h)$/;
const SIZE_RE = /^(\d+)(gb|mb|kb|b)$/;

function parseDuration(token: string): number | null {
  const m = DURATION_RE.exec(token.toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "d" ? n * DAY_MS : n * 60 * 60 * 1000;
}

function parseSize(token: string): number | null {
  const m = SIZE_RE.exec(token.toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "gb": return n * 1024 ** 3;
    case "mb": return n * 1024 ** 2;
    case "kb": return n * 1024;
    default: return n;
  }
}

/**
 * Parse a single mini-DSL line into a `Rule`. The generated rule id is
 * deterministic from the input so re-parsing the same line dedupes.
 */
export function parseDsl(line: string): DslParseResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { ok: false, error: "empty rule" };
  if (trimmed.length > MAX_NAME_LENGTH) return { ok: false, error: "rule too long" };

  const arrowIdx = trimmed.indexOf("->");
  if (arrowIdx === -1) return { ok: false, error: "missing '-> destination'" };

  const lhs = trimmed.slice(0, arrowIdx).trim();
  const dest = trimmed.slice(arrowIdx + 2).trim();
  if (dest.length === 0) return { ok: false, error: "missing destination after '->'" };

  const tokens = lhs.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { ok: false, error: "missing file pattern" };

  const glob = tokens[0]!;
  // Reject NUL / control chars in the glob (defense against odd inputs).
  if (hasControlChar(glob)) return { ok: false, error: "invalid characters in pattern" };

  const predicate: RulePredicate = { glob };
  let i = 1;
  while (i < tokens.length) {
    const kw = tokens[i]!.toLowerCase();
    const arg = tokens[i + 1];
    if (kw === "older") {
      if (arg === undefined) return { ok: false, error: "'older' needs a duration (e.g. 7d)" };
      const ms = parseDuration(arg);
      if (ms === null) return { ok: false, error: `invalid duration '${arg}' (use Nd or Nh)` };
      predicate.olderThanMs = ms;
      i += 2;
    } else if (kw === "larger") {
      if (arg === undefined) return { ok: false, error: "'larger' needs a size (e.g. 100mb)" };
      const bytes = parseSize(arg);
      if (bytes === null) return { ok: false, error: `invalid size '${arg}' (use Nkb/Nmb/Ngb)` };
      predicate.largerThanBytes = bytes;
      i += 2;
    } else {
      return { ok: false, error: `unexpected token '${tokens[i]}'` };
    }
  }

  const isQuarantine = dest.toLowerCase() === "quarantine";
  const idBasis = `${glob}|${predicate.olderThanMs ?? ""}|${predicate.largerThanBytes ?? ""}|${dest}`;
  const rule: Rule = {
    id: `dsl-${djb2(idBasis)}`,
    label: trimmed,
    action: isQuarantine ? "quarantine" : "route",
    predicate,
    destructive: isQuarantine,
    ...(isQuarantine ? {} : { dest }),
  };
  return { ok: true, rule };
}

/** Tiny deterministic string hash for stable rule ids. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
