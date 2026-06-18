/**
 * Extension Pages Hub — declarative page component vocabulary + validator.
 *
 * A Hub page is a server-validated JSON component tree (`HubPageTree`)
 * rendered to native Svelte by `HubComponentRenderer.svelte`. Extension
 * (or core-provider) code never touches the DOM — XSS is impossible by
 * construction. The vocabulary is a superset of the bottom-panel
 * vocabulary: the nine panel node types keep their exact wire shapes
 * (validated by re-using `panel-validator.ts`'s `validateComponent`),
 * plus page-only nodes (section, heading, markdown, stats, table,
 * button, link, empty-state).
 *
 * Validation style is hand-rolled (NOT zod), matching
 * `panel-validator.ts`: invalid nodes are DROPPED (forward-compat),
 * strings are `<>`-stripped + truncated — EXCEPT `markdown.content`
 * (DOMPurify handles it client-side; truncate only) and `href`
 * (validated as a relative-only internal path instead).
 *
 * Security invariants (server-enforced):
 *   - 64KB tree cap (matches `MAX_STATE_SIZE_BYTES`), 500 nodes,
 *     depth 6, tables ≤ 100×12, action payload ≤ 2KB.
 *   - `href` must start with a single `/` (reject `//`, `\`,
 *     `javascript:` et al. by construction) — open-redirect defense.
 *   - `action.event` must be in the caller-supplied `allowedEvents`
 *     allowlist, else the node is dropped.
 *   - No class/style passthrough anywhere — enum variants only.
 */
import { validateComponent } from "./panel-validator";
import type { PanelComponent } from "./types";

// ── Limits ─────────────────────────────────────────────────────────

/** Matches `MAX_STATE_SIZE_BYTES` in state-mediator.ts. */
export const MAX_PAGE_TREE_BYTES = 65_536; // 64 KB
export const MAX_PAGE_NODES = 500;
export const MAX_PAGE_DEPTH = 6;
export const MAX_TABLE_ROWS = 100;
export const MAX_TABLE_COLUMNS = 12;
export const MAX_ACTION_PAYLOAD_BYTES = 2_048; // 2 KB
const MAX_STATS_ITEMS = 12;
const MAX_MARKDOWN_CHARS = 10_000;

/** Prompt limits. `field` is slug-clamped; the rest are truncated. */
const PROMPT_FIELD_REGEX = /^[a-z0-9][a-z0-9_]{0,31}$/;
const DEFAULT_PROMPT_FIELD = "value";
const DEFAULT_PROMPT_MAX_LENGTH = 200;
const PROMPT_MAX_LENGTH_CAP = 500;
const PROMPT_LABEL_MAX = 120;
const PROMPT_SUBMIT_LABEL_MAX = 40;

/**
 * Input `format`s a prompt may opt into. Each maps (client-side) to a
 * shared format component in `web/src/lib/components/ui/format-map.ts`
 * — `file-path` → `SharedFilePicker`, `combo-box`/`search` → their boxes,
 * `date`/`datetime` → `DatePicker`. Only SCALAR-string producers are
 * allowed: a prompt merges ONE typed string into `payload[field]`, so
 * array-valued widgets (e.g. `tag-input`) are intentionally excluded.
 * Keep aligned with `formatComponentMap`'s string-valued keys.
 */
export const PROMPT_FORMATS = new Set<string>([
  "file-path",
  "combo-box",
  "search",
  "date",
  "datetime",
]);

// ── Page-only node types ───────────────────────────────────────────

/**
 * Host-rendered single-field text prompt attached to an action. The
 * extension/provider declares only validated, `<>`-stripped, truncated
 * strings — never DOM. When the user submits, the typed scalar is merged
 * client-side into `action.payload[field]` (default `"value"`) and the
 * action dispatches through its UNCHANGED, already-gated event path.
 *
 * SOURCE OF TRUTH for the prompt shape. Mirrored in:
 *   - `web/src/lib/hub.ts` (`PagePrompt`, frontend renderer/page route)
 *   - `packages/@ezcorp/sdk/src/runtime/page.ts` (`PagePromptDescriptor`,
 *     extension-author builder surface)
 * Keep all three aligned (same convention as the `PageNode` mirrors).
 */
export interface PagePrompt {
  /** Dialog input label (required). */
  label: string;
  placeholder?: string;
  /** Payload key the typed value is merged under. Slug-sanitized
   *  (`/^[a-z0-9][a-z0-9_]{0,31}$/`); default `"value"`. */
  field?: string;
  /** Host clamps the input length; default 200, hard cap 500. */
  maxLength?: number;
  /** Submit-button label; default "Submit". */
  submitLabel?: string;
  /** Opt the host input into a richer shared widget instead of the plain
   *  text box — `"file-path"` reuses the app's filesystem picker
   *  (`SharedFilePicker`), etc. Only the scalar-string producers in
   *  `PROMPT_FORMATS` are allowed; an unknown/excluded value is dropped
   *  and the dialog falls back to the plain text input. */
  format?: string;
}

export interface PageAction {
  /** Namespaced event (`<ext>:<event>`) or core action name. Must be in
   *  the validator's `allowedEvents` allowlist. */
  event: string;
  payload?: Record<string, string | number | boolean>;
  /** Host-rendered confirm-dialog text shown before dispatch. */
  confirm?: string;
  /** Optional host-rendered text prompt — see `PagePrompt`. A malformed
   *  prompt is dropped (the action degrades to a plain dispatch); it is
   *  never fatal to the whole action. Grants ZERO new authority. */
  prompt?: PagePrompt;
}

export interface PageSection {
  type: "section";
  title?: string;
  nodes: PageNode[];
}
export interface PageHeading {
  type: "heading";
  level: 1 | 2 | 3;
  text: string;
}
export interface PageMarkdown {
  type: "markdown";
  content: string;
}
export interface PageStatItem {
  label: string;
  value: string;
  hint?: string;
}
export interface PageStats {
  type: "stats";
  items: PageStatItem[];
}
export interface PageTableRow {
  cells: string[];
  action?: PageAction;
  href?: string;
}
export interface PageTable {
  type: "table";
  columns: string[];
  rows: PageTableRow[];
}
export interface PageButton {
  type: "button";
  label: string;
  action: PageAction;
  style?: "primary" | "secondary" | "danger";
}
export interface PageLink {
  type: "link";
  label: string;
  href: string;
}
export interface PageEmptyState {
  type: "empty-state";
  title: string;
  detail?: string;
}

export type PageOnlyNode =
  | PageSection
  | PageHeading
  | PageMarkdown
  | PageStats
  | PageTable
  | PageButton
  | PageLink
  | PageEmptyState;

/** Full Hub page vocabulary: panel nodes (wire-shapes unchanged) + page nodes. */
export type PageNode = PanelComponent | PageOnlyNode;

export interface HubPageTree {
  title: string;
  nodes: PageNode[];
}

export interface ValidatePageTreeOptions {
  /** Action-event allowlist. Core pages pass their action names;
   *  extension pages pass `permissions.eventSubscriptions`. */
  allowedEvents: readonly string[];
}

// ── Sanitisation helpers (match panel-validator style) ─────────────

function strip(value: unknown): string {
  return typeof value === "string" ? value.replace(/[<>]/g, "") : "";
}

function truncate(value: unknown, max: number): string {
  return strip(value).slice(0, max);
}

/**
 * Internal links only: must start with `/`, must not start with `//`
 * (protocol-relative), and must not contain `\` anywhere (backslash
 * normalization tricks). Everything else (`javascript:`, `https:`,
 * relative paths) fails the leading-`/` rule by construction.
 */
export function isSafeInternalHref(href: unknown): href is string {
  if (typeof href !== "string") return false;
  if (!href.startsWith("/")) return false;
  if (href.startsWith("//")) return false;
  if (href.includes("\\")) return false;
  return true;
}

const PAGE_ONLY_TYPES = new Set<string>([
  "section",
  "heading",
  "markdown",
  "stats",
  "table",
  "button",
  "link",
  "empty-state",
]);

const BUTTON_STYLES = new Set(["primary", "secondary", "danger"]);

// ── Per-type validators ────────────────────────────────────────────

/**
 * Validate an action's optional prompt. A malformed prompt returns
 * `null` so the caller OMITS the field (the action degrades to a plain
 * dispatch) — never drops the whole action. The input widget is 100%
 * host-rendered, so we only need scalar, sanitized display strings here.
 */
function validatePrompt(raw: unknown): PagePrompt | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.label !== "string") return null; // label is required
  const label = truncate(p.label, PROMPT_LABEL_MAX);
  if (label.length === 0) return null; // an empty/all-`<>` label is useless

  const out: PagePrompt = { label };

  if (p.placeholder != null) out.placeholder = truncate(p.placeholder, PROMPT_LABEL_MAX);

  // `field` must be a clean payload-key slug, else fall back to "value"
  // so it can never collide with or spoof a reserved payload key.
  out.field =
    typeof p.field === "string" && PROMPT_FIELD_REGEX.test(p.field)
      ? p.field
      : DEFAULT_PROMPT_FIELD;

  // maxLength clamped to [1, 500]; non-numeric → default.
  const ml = typeof p.maxLength === "number" && Number.isFinite(p.maxLength)
    ? Math.min(PROMPT_MAX_LENGTH_CAP, Math.max(1, Math.floor(p.maxLength)))
    : DEFAULT_PROMPT_MAX_LENGTH;
  out.maxLength = ml;

  if (p.submitLabel != null) {
    const sl = truncate(p.submitLabel, PROMPT_SUBMIT_LABEL_MAX);
    if (sl.length > 0) out.submitLabel = sl;
  }

  // `format` opts into a richer shared widget; only the known scalar
  // formats are kept (unknown → omit → host renders the plain text box).
  if (typeof p.format === "string" && PROMPT_FORMATS.has(p.format)) {
    out.format = p.format;
  }

  return out;
}

function validateAction(
  raw: unknown,
  allowedEvents: readonly string[],
): PageAction | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.event !== "string" || !allowedEvents.includes(a.event)) {
    return null;
  }
  const out: PageAction = { event: a.event };
  if (a.payload !== undefined) {
    if (a.payload == null || typeof a.payload !== "object" || Array.isArray(a.payload)) {
      return null;
    }
    const payload: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(a.payload as Record<string, unknown>)) {
      if (typeof v === "string") payload[truncate(k, 64)] = strip(v);
      else if (typeof v === "number" || typeof v === "boolean") payload[truncate(k, 64)] = v;
      else return null; // nested objects/arrays in payloads are rejected wholesale
    }
    if (JSON.stringify(payload).length > MAX_ACTION_PAYLOAD_BYTES) return null;
    out.payload = payload;
  }
  if (a.confirm != null) out.confirm = truncate(a.confirm, 300);
  // A malformed prompt is dropped (omit the field) — never fatal to the
  // action, which still dispatches as a plain (prompt-less) action.
  if (a.prompt != null) {
    const prompt = validatePrompt(a.prompt);
    if (prompt) out.prompt = prompt;
  }
  return out;
}

interface ValidationBudget {
  /** Remaining node allowance, decremented per ACCEPTED node. */
  nodesLeft: number;
}

function validateHeading(raw: Record<string, unknown>): PageHeading | null {
  if (typeof raw.text !== "string") return null;
  const level = raw.level === 1 || raw.level === 2 || raw.level === 3 ? raw.level : 2;
  return { type: "heading", level, text: truncate(raw.text, 200) };
}

function validateMarkdown(raw: Record<string, unknown>): PageMarkdown | null {
  if (typeof raw.content !== "string") return null;
  // NOT `<>`-stripped — the client renders this through the existing
  // `renderMarkdown` + DOMPurify pipeline. Truncate only.
  return { type: "markdown", content: raw.content.slice(0, MAX_MARKDOWN_CHARS) };
}

function validateStats(raw: Record<string, unknown>): PageStats | null {
  if (!Array.isArray(raw.items)) return null;
  const items = raw.items
    .slice(0, MAX_STATS_ITEMS)
    .filter(
      (it): it is Record<string, unknown> =>
        it != null &&
        typeof it === "object" &&
        typeof (it as Record<string, unknown>).label === "string" &&
        typeof (it as Record<string, unknown>).value === "string",
    )
    .map((it) => ({
      label: truncate(it.label, 60),
      value: truncate(it.value, 60),
      ...(it.hint != null ? { hint: truncate(it.hint, 120) } : {}),
    }));
  return { type: "stats", items };
}

function validateTableRow(
  raw: unknown,
  columnCount: number,
  allowedEvents: readonly string[],
): PageTableRow | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.cells)) return null;
  const cells = r.cells
    .slice(0, columnCount)
    .map((c) => (typeof c === "string" ? truncate(c, 300) : ""));
  const out: PageTableRow = { cells };
  if (r.action !== undefined) {
    const action = validateAction(r.action, allowedEvents);
    if (!action) return null; // a row with an invalid/forbidden action is dropped
    out.action = action;
  }
  if (r.href !== undefined) {
    if (!isSafeInternalHref(r.href)) return null;
    out.href = r.href.slice(0, 2_000);
  }
  return out;
}

function validateTable(
  raw: Record<string, unknown>,
  allowedEvents: readonly string[],
): PageTable | null {
  if (!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return null;
  const columns = raw.columns
    .slice(0, MAX_TABLE_COLUMNS)
    .map((c) => (typeof c === "string" ? truncate(c, 100) : ""));
  if (columns.length === 0) return null;
  const rows = raw.rows
    .slice(0, MAX_TABLE_ROWS)
    .map((r) => validateTableRow(r, columns.length, allowedEvents))
    .filter((r): r is PageTableRow => r !== null);
  return { type: "table", columns, rows };
}

function validateButton(
  raw: Record<string, unknown>,
  allowedEvents: readonly string[],
): PageButton | null {
  if (typeof raw.label !== "string") return null;
  const action = validateAction(raw.action, allowedEvents);
  if (!action) return null;
  return {
    type: "button",
    label: truncate(raw.label, 80),
    action,
    ...(raw.style != null && BUTTON_STYLES.has(raw.style as string)
      ? { style: raw.style as PageButton["style"] }
      : {}),
  };
}

function validateLink(raw: Record<string, unknown>): PageLink | null {
  if (typeof raw.label !== "string") return null;
  if (!isSafeInternalHref(raw.href)) return null;
  return { type: "link", label: truncate(raw.label, 120), href: raw.href.slice(0, 2_000) };
}

function validateEmptyState(raw: Record<string, unknown>): PageEmptyState | null {
  if (typeof raw.title !== "string") return null;
  return {
    type: "empty-state",
    title: truncate(raw.title, 120),
    ...(raw.detail != null ? { detail: truncate(raw.detail, 300) } : {}),
  };
}

function validateSection(
  raw: Record<string, unknown>,
  allowedEvents: readonly string[],
  depth: number,
  budget: ValidationBudget,
): PageSection | null {
  if (depth >= MAX_PAGE_DEPTH) return null;
  if (!Array.isArray(raw.nodes)) return null;
  const nodes = validateNodes(raw.nodes, allowedEvents, depth + 1, budget);
  return {
    type: "section",
    ...(raw.title != null ? { title: truncate(raw.title, 120) } : {}),
    nodes,
  };
}

// ── Node dispatcher ────────────────────────────────────────────────

function validateNode(
  raw: unknown,
  allowedEvents: readonly string[],
  depth: number,
  budget: ValidationBudget,
): PageNode | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string") return null;

  if (!PAGE_ONLY_TYPES.has(type)) {
    // Panel vocabulary (or unknown → validateComponent drops it).
    return validateComponent(obj);
  }

  switch (type) {
    case "section":     return validateSection(obj, allowedEvents, depth, budget);
    case "heading":     return validateHeading(obj);
    case "markdown":    return validateMarkdown(obj);
    case "stats":       return validateStats(obj);
    case "table":       return validateTable(obj, allowedEvents);
    case "button":      return validateButton(obj, allowedEvents);
    case "link":        return validateLink(obj);
    case "empty-state": return validateEmptyState(obj);
    default:            return null;
  }
}

function validateNodes(
  raw: unknown[],
  allowedEvents: readonly string[],
  depth: number,
  budget: ValidationBudget,
): PageNode[] {
  const out: PageNode[] = [];
  for (const node of raw) {
    if (budget.nodesLeft <= 0) break;
    // Reserve the budget slot BEFORE recursing so a deep section's
    // children count against the global cap (a section + its children
    // can never exceed MAX_PAGE_NODES total).
    budget.nodesLeft--;
    const validated = validateNode(node, allowedEvents, depth, budget);
    if (validated === null) {
      budget.nodesLeft++; // dropped node doesn't consume budget
      continue;
    }
    out.push(validated);
  }
  return out;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Validate a raw Hub page tree. Returns the sanitized tree, or `null`
 * when the envelope itself is unacceptable (non-object, missing title,
 * missing nodes array, or > 64KB serialized). Individual invalid nodes
 * are dropped, never fatal — forward-compat with future vocabulary.
 */
export function validatePageTree(
  raw: unknown,
  options: ValidatePageTreeOptions,
): HubPageTree | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.title !== "string") return null;
  if (!Array.isArray(obj.nodes)) return null;

  // Size gate on the INPUT — matches the mediator's pre-emit cap so a
  // pathological tree is rejected before any per-node work.
  try {
    if (JSON.stringify(raw).length > MAX_PAGE_TREE_BYTES) return null;
  } catch {
    return null; // circular structures can't be valid wire payloads
  }

  const budget: ValidationBudget = { nodesLeft: MAX_PAGE_NODES };
  const nodes = validateNodes(obj.nodes, options.allowedEvents, 0, budget);

  return {
    title: truncate(obj.title, 80),
    nodes,
  };
}
