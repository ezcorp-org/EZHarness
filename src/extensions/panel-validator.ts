import type {
  PanelComponentType,
  PanelComponent,
  PanelHeader,
  PanelText,
  PanelBadge,
  PanelProgress,
  PanelStatus,
  PanelList,
  PanelListItem,
  PanelKV,
  PanelCounter,
  PanelDivider,
  ExtensionPanelState,
} from "./types";

// ── Constants ──────────────────────────────────────────────────────

const KNOWN_TYPES = new Set<PanelComponentType>([
  "header", "text", "badge", "progress", "status", "list", "kv", "counter", "divider",
]);

const BADGE_COLORS = new Set(["blue", "green", "red", "yellow", "purple", "gray"]);
const STATUS_STATES = new Set(["idle", "running", "success", "error", "warning"]);
const LIST_STATUSES = new Set(["pending", "active", "completed", "failed"]);
const TEXT_VARIANTS = new Set(["muted", "default", "emphasis"]);

const MAX_COMPONENTS = 20;
const MAX_LIST_ITEMS = 50;
const MAX_KV_PAIRS = 20;

// ── Sanitisation helpers ───────────────────────────────────────────

function strip(value: unknown): string {
  return typeof value === "string" ? value.replace(/[<>]/g, "") : "";
}

function truncate(value: unknown, max: number): string {
  return strip(value).slice(0, max);
}

function clamp(value: unknown, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

// ── Per-type validators ────────────────────────────────────────────

function validateHeader(raw: Record<string, unknown>): PanelHeader | null {
  if (typeof raw.title !== "string") return null;
  return {
    type: "header",
    title: truncate(raw.title, 100),
    ...(raw.subtitle != null ? { subtitle: truncate(raw.subtitle, 200) } : {}),
  };
}

function validateText(raw: Record<string, unknown>): PanelText | null {
  if (typeof raw.content !== "string") return null;
  return {
    type: "text",
    content: truncate(raw.content, 500),
    ...(raw.variant != null ? { variant: TEXT_VARIANTS.has(raw.variant as string) ? raw.variant as PanelText["variant"] : "default" } : {}),
  };
}

function validateBadge(raw: Record<string, unknown>): PanelBadge | null {
  if (typeof raw.label !== "string") return null;
  return {
    type: "badge",
    label: truncate(raw.label, 30),
    color: BADGE_COLORS.has(raw.color as string) ? raw.color as PanelBadge["color"] : "gray",
  };
}

function validateProgress(raw: Record<string, unknown>): PanelProgress | null {
  return {
    type: "progress",
    value: clamp(raw.value, 0, 100),
    ...(raw.label != null ? { label: truncate(raw.label, 50) } : {}),
  };
}

function validateStatus(raw: Record<string, unknown>): PanelStatus | null {
  if (typeof raw.label !== "string") return null;
  return {
    type: "status",
    label: truncate(raw.label, 50),
    state: STATUS_STATES.has(raw.state as string) ? raw.state as PanelStatus["state"] : "idle",
  };
}

function validateListItem(raw: unknown): PanelListItem | null {
  if (raw == null || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.label !== "string") return null;
  return {
    label: truncate(item.label, 100),
    ...(item.status != null && LIST_STATUSES.has(item.status as string) ? { status: item.status as PanelListItem["status"] } : {}),
    ...(item.detail != null ? { detail: truncate(item.detail, 200) } : {}),
    ...(item.badge != null ? { badge: truncate(item.badge, 30) } : {}),
    ...(item.badgeColor != null ? { badgeColor: BADGE_COLORS.has(item.badgeColor as string) ? item.badgeColor as PanelListItem["badgeColor"] : "gray" } : {}),
  };
}

function validateList(raw: Record<string, unknown>): PanelList | null {
  if (!Array.isArray(raw.items)) return null;
  const items = raw.items.slice(0, MAX_LIST_ITEMS)
    .map(validateListItem)
    .filter((item): item is PanelListItem => item !== null);
  return { type: "list", items };
}

function validateKV(raw: Record<string, unknown>): PanelKV | null {
  if (!Array.isArray(raw.pairs)) return null;
  const pairs = raw.pairs.slice(0, MAX_KV_PAIRS)
    .filter((p): p is Record<string, unknown> => p != null && typeof p === "object" && typeof (p as any).key === "string" && typeof (p as any).value === "string")
    .map((p) => ({
      key: truncate(p.key, 50),
      value: truncate(p.value, 200),
    }));
  return { type: "kv", pairs };
}

function validateCounter(raw: Record<string, unknown>): PanelCounter | null {
  if (typeof raw.label !== "string") return null;
  const result: PanelCounter = {
    type: "counter",
    label: truncate(raw.label, 50),
    value: typeof raw.value === "number" ? raw.value : 0,
  };
  if (typeof raw.total === "number") {
    result.total = raw.total;
  }
  return result;
}

function validateDivider(): PanelDivider {
  return { type: "divider" };
}

// ── Component dispatcher ───────────────────────────────────────────

/**
 * Validate a single panel-vocabulary component. Exported so the Hub
 * page-schema validator (`./page-schema.ts`) can reuse the exact same
 * wire-shape rules for the nine panel node types — panel node shapes
 * are IDENTICAL between the bottom panel and Hub pages by design
 * (Extension Pages Hub locked decision: "panel node wire-shapes
 * unchanged").
 */
export function validateComponent(raw: unknown): PanelComponent | null {
  if (raw == null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (!KNOWN_TYPES.has(obj.type as PanelComponentType)) return null;

  switch (obj.type) {
    case "header":   return validateHeader(obj);
    case "text":     return validateText(obj);
    case "badge":    return validateBadge(obj);
    case "progress": return validateProgress(obj);
    case "status":   return validateStatus(obj);
    case "list":     return validateList(obj);
    case "kv":       return validateKV(obj);
    case "counter":  return validateCounter(obj);
    case "divider":  return validateDivider();
    default:         return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────

export function validatePanelState(raw: unknown): ExtensionPanelState | null {
  if (raw == null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.title !== "string") return null;
  if (!Array.isArray(obj.components)) return null;

  const components = obj.components
    .slice(0, MAX_COMPONENTS)
    .map(validateComponent)
    .filter((c): c is PanelComponent => c !== null);

  return {
    title: truncate(obj.title, 50),
    ...(typeof obj.collapsed === "boolean" ? { collapsed: obj.collapsed } : {}),
    components,
  };
}
