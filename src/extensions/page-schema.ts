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

// ── Page-only node types ───────────────────────────────────────────

export interface PageAction {
  /** Namespaced event (`<ext>:<event>`) or core action name. Must be in
   *  the validator's `allowedEvents` allowlist. */
  event: string;
  payload?: Record<string, string | number | boolean>;
  /** Host-rendered confirm-dialog text shown before dispatch. */
  confirm?: string;
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
