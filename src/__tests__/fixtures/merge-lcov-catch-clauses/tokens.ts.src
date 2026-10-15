// Design-system extraction. Walk the project root and merge tokens
// from explicit sources in priority order:
//   tokens.json > tailwind.config > CSS variables > theme.ts > greenfield
//
// Pure functions where possible — the I/O is funneled through a single
// `extractFromRoot` entry point so tests can drive it with a fake fs.

import type {
  DesignSystem,
  ColorRamp,
  TypographyScale,
  SpacingScale,
  ComponentEntry,
  DesignSystemSource,
} from "./types";

// ── Public entrypoint ──────────────────────────────────────────────

export interface ExtractDeps {
  /** Reads a file from disk; resolves to null when missing. Lets tests
   *  inject fixture content without writing files. */
  readFile: (relPath: string) => Promise<string | null>;
  /** Returns paths matching a glob, project-relative. */
  glob: (pattern: string) => Promise<string[]>;
}

const FALLBACK: DesignSystem = Object.freeze({
  schemaVersion: 1,
  colors: {
    primary: "#0066ff",
    neutral: ["#0a0a0a", "#262626", "#525252", "#a3a3a3", "#fafafa"],
  },
  typography: {
    display: "ui-sans-serif, system-ui, sans-serif",
    body: "ui-sans-serif, system-ui, sans-serif",
    scale: [12, 14, 16, 20, 24, 32, 48, 64],
  },
  spacing: {
    unit: 8,
    scale: [4, 8, 12, 16, 24, 32, 48, 64],
  },
  components: [],
  source: "greenfield",
});

/**
 * Run the priority-ordered extraction. Returns a fully populated
 * DesignSystem; falls back to greenfield defaults if no source matches.
 *
 * Each source contributes only the fields it knows about — partial
 * tailwind.config (just colors, no spacing) is fine; the missing
 * fields fill in from FALLBACK.
 */
export async function extractFromRoot(deps: ExtractDeps): Promise<DesignSystem> {
  // 1. tokens.json — Style Dictionary or Figma export
  const tokensJson = await readJsonIfExists(deps, ["tokens.json", "design-tokens.json"]);
  if (tokensJson) {
    return mergeWithFallback(parseTokensJson(tokensJson), "tokens.json", deps);
  }

  // 2. tailwind.config.{ts,js,cjs,mjs}
  for (const file of ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs"]) {
    const src = await deps.readFile(file);
    if (src) {
      const partial = parseTailwindSource(src);
      if (partial) return mergeWithFallback(partial, "tailwind", deps);
    }
  }

  // 3. CSS variables in :root from any *.css file
  const cssCandidates = await deps.glob("**/*.css");
  for (const path of cssCandidates) {
    const src = await deps.readFile(path);
    if (!src) continue;
    const partial = parseCssVariables(src);
    if (partial) return mergeWithFallback(partial, "css-vars", deps);
  }

  // 4. theme.ts / theme.js exporting an object literal
  for (const file of ["theme.ts", "theme.js", "src/theme.ts"]) {
    const src = await deps.readFile(file);
    if (src) {
      const partial = parseTailwindSource(src);
      if (partial) return mergeWithFallback(partial, "theme.ts", deps);
    }
  }

  // 5. Greenfield — return fallback with a fresh copy + components
  const components = await catalogComponents(deps);
  return { ...FALLBACK, components, source: "greenfield" };
}

// ── Parsers — pure functions over source strings ──────────────────

export interface PartialDesignSystem {
  colors?: Partial<ColorRamp>;
  typography?: Partial<TypographyScale>;
  spacing?: Partial<SpacingScale>;
}

/** Parse a tokens.json (Style Dictionary / Figma export) into a partial. */
export function parseTokensJson(raw: unknown): PartialDesignSystem {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const result: PartialDesignSystem = {};

  // Style Dictionary shape: { color: { primary: { value: '#hex' }, … } }
  const colorRoot = obj.color ?? obj.colors;
  if (colorRoot && typeof colorRoot === "object") {
    const colors: Partial<ColorRamp> = {};
    const cRoot = colorRoot as Record<string, unknown>;
    const primary = unwrapTokenValue(cRoot.primary);
    const secondary = unwrapTokenValue(cRoot.secondary);
    if (typeof primary === "string") colors.primary = primary;
    if (typeof secondary === "string") colors.secondary = secondary;
    const neutral = unwrapNeutralRamp(cRoot.neutral ?? cRoot.gray ?? cRoot.grey);
    if (neutral) colors.neutral = neutral;
    if (Object.keys(colors).length > 0) result.colors = colors;
  }

  return result;
}

/**
 * Strip JS/TS line comments and block comments. Used by
 * `parseTailwindSource` so commented-out config sections don't leak
 * into the regex matches. [I3 from the Phase B review]
 *
 * Conservative — doesn't try to be a real lexer. Strings containing
 * `//` (URLs, paths) are mostly safe because the regex stops at the
 * first newline; strings containing `/*` would be munged, but that's
 * rare in tailwind configs.
 */
export function stripComments(src: string): string {
  // Block comments first so `// …` inside them doesn't get processed.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.replace(/(^|[^:])\/\/.*$/gm, (_, lead: string) => lead);
  return out;
}

/**
 * Heuristic Tailwind / theme.ts source parser. We don't run the user's
 * code (sandbox-unsafe) — just look for object-literal patterns. Hits
 * the common 80% of tailwind configs.
 */
export function parseTailwindSource(rawSrc: string): PartialDesignSystem | null {
  const src = stripComments(rawSrc);
  const result: PartialDesignSystem = {};

  // colors: { primary: '#xxx', secondary: '#xxx' } — quoted-string values
  const primaryHex = matchQuotedHex(src, /\bprimary\s*:\s*(['"])(#[0-9a-fA-F]{3,8})\1/);
  const secondaryHex = matchQuotedHex(src, /\bsecondary\s*:\s*(['"])(#[0-9a-fA-F]{3,8})\1/);

  if (primaryHex || secondaryHex) {
    result.colors = {};
    if (primaryHex) result.colors.primary = primaryHex;
    if (secondaryHex) result.colors.secondary = secondaryHex;
  }

  // fontFamily: { sans: '…', display: '…' }
  const display = matchQuotedString(src, /\bdisplay\s*:\s*(?:\[\s*)?(['"])([^'"]+)\1/);
  const body = matchQuotedString(src, /\b(?:sans|body)\s*:\s*(?:\[\s*)?(['"])([^'"]+)\1/);
  if (display || body) {
    result.typography = {};
    if (display) result.typography.display = display;
    if (body) result.typography.body = body;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parse `:root { --color-primary: …; --color-secondary: …; --space-unit: 8px; }`
 * out of any CSS source. Returns null if no recognized vars are found.
 */
export function parseCssVariables(src: string): PartialDesignSystem | null {
  // Find the first `:root { … }` block. Multi-block files are rare; the
  // first one wins.
  const rootMatch = /:root\s*\{([\s\S]*?)\}/.exec(src);
  if (!rootMatch) return null;
  const body = rootMatch[1] ?? "";

  const colors: Partial<ColorRamp> = {};
  const primary = readVar(body, "--color-primary");
  const secondary = readVar(body, "--color-secondary");
  if (primary) colors.primary = primary;
  if (secondary) colors.secondary = secondary;

  const spacing: Partial<SpacingScale> = {};
  const unitRaw = readVar(body, "--space-unit");
  if (unitRaw) {
    const unit = parsePxValue(unitRaw);
    if (unit !== null) spacing.unit = unit;
  }

  const result: PartialDesignSystem = {};
  if (Object.keys(colors).length > 0) result.colors = colors;
  if (Object.keys(spacing).length > 0) result.spacing = spacing;
  return Object.keys(result).length > 0 ? result : null;
}

// ── Glue ──────────────────────────────────────────────────────────

async function readJsonIfExists(
  deps: ExtractDeps,
  candidates: string[],
): Promise<unknown | null> {
  for (const path of candidates) {
    const src = await deps.readFile(path);
    if (!src) continue;
    try {
      return JSON.parse(src);
    } catch {
      // Not JSON — try the next candidate.
    }
  }
  return null;
}

async function catalogComponents(deps: ExtractDeps): Promise<ComponentEntry[]> {
  const results: ComponentEntry[] = [];
  const seen = new Set<string>();
  const patterns = [
    "**/components/*.svelte",
    "**/components/*.tsx",
    "**/components/*.vue",
    "**/components/*.jsx",
  ];
  for (const pat of patterns) {
    const paths = await deps.glob(pat);
    for (const p of paths) {
      // node_modules / dist / build noise
      if (/(^|\/)(node_modules|dist|build|\.svelte-kit|\.next)\//.test(p)) continue;
      const name = p.replace(/.*\//, "").replace(/\.[^.]+$/, "");
      if (seen.has(name)) continue;
      seen.add(name);
      results.push({ name, path: p });
      if (results.length >= 32) return results;
    }
  }
  return results;
}

async function mergeWithFallback(
  partial: PartialDesignSystem,
  source: DesignSystemSource,
  deps: ExtractDeps,
): Promise<DesignSystem> {
  const components = await catalogComponents(deps);
  return {
    schemaVersion: 1,
    colors: { ...FALLBACK.colors, ...(partial.colors ?? {}) },
    typography: { ...FALLBACK.typography, ...(partial.typography ?? {}) },
    spacing: { ...FALLBACK.spacing, ...(partial.spacing ?? {}) },
    components,
    source,
  };
}

// ── Tiny helpers (exported for tests) ─────────────────────────────

export function unwrapTokenValue(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "value" in raw) {
    const v = (raw as { value: unknown }).value;
    if (typeof v === "string") return v;
  }
  return undefined;
}

export function unwrapNeutralRamp(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const items = raw
      .map(unwrapTokenValue)
      .filter((s): s is string => typeof s === "string");
    return items.length > 0 ? items : undefined;
  }
  if (raw && typeof raw === "object") {
    // Style Dictionary scale: { 50: '#fafafa', 100: '#…', … }. May
    // also include non-numeric keys like `DEFAULT` — bucket those
    // separately and append at the end so the sort stays stable.
    // [C2 from the Phase B review — `parseInt('DEFAULT')` returns NaN,
    //  and NaN-NaN sort comparators are platform-dependent.]
    const obj = raw as Record<string, unknown>;
    const numericKeys: string[] = [];
    const nonNumericKeys: string[] = [];
    for (const k of Object.keys(obj)) {
      if (/^\d+$/.test(k)) {
        numericKeys.push(k);
      } else {
        nonNumericKeys.push(k);
      }
    }
    numericKeys.sort((a, b) => parseInt(a) - parseInt(b));
    nonNumericKeys.sort();
    const items = [...numericKeys, ...nonNumericKeys]
      .map((k) => unwrapTokenValue(obj[k]))
      .filter((s): s is string => typeof s === "string");
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function readVar(block: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${escaped}\\s*:\\s*([^;]+);`).exec(block);
  return m ? m[1]!.trim() : undefined;
}

function parsePxValue(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(raw.trim());
  return m ? parseFloat(m[1]!) : null;
}

function matchQuotedHex(src: string, re: RegExp): string | undefined {
  const m = re.exec(src);
  return m ? m[2] : undefined;
}

function matchQuotedString(src: string, re: RegExp): string | undefined {
  const m = re.exec(src);
  return m ? m[2] : undefined;
}
