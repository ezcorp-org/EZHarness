/**
 * Phase 48 Wave 3 — Ez page-context serializer.
 *
 * Builds the JSON payload the Ez panel attaches to every outgoing
 * message under `ezContext`. Two tiers (per the design):
 *
 *   1. Tier 1 (always-on): synthesized from `$page` —
 *      `{ url, routeId, params, projectId?, conversationId?, agentId? }`.
 *      No opt-in needed; works on every (app) route.
 *
 *   2. Tier 2 (opt-in): the page mounted `<EzContext>` and registered
 *      `data` + `forms`. The serializer flattens registered entries
 *      into a single `data` blob and a string list of form ids the
 *      LLM may target via `fill_form`.
 *
 * Token budget: each `data` payload is capped at ~500 tokens after
 * JSON serialization. We approximate tokens as `length / 4` (the
 * commonly-cited GPT/Claude ratio for English-ish JSON). On overflow
 * we trim by dropping later entries until we fit, and emit a single
 * `console.warn` in dev so the page author sees their page is over-
 * exposing data. Production builds skip the warn entirely (no
 * point spamming end users' consoles).
 */
import type { ContextEntry } from "./registry";

export const TOKEN_BUDGET = 500;
export const APPROX_CHARS_PER_TOKEN = 4;
export const TOKEN_BUDGET_CHARS = TOKEN_BUDGET * APPROX_CHARS_PER_TOKEN; // 2000

/**
 * Minimal shape of `$page` we depend on. Defined locally so tests can
 * pass a plain object without importing `$app/state`.
 */
export interface EzPageLike {
  url: { pathname: string; search?: string; href?: string } | URL;
  route: { id: string | null };
  params: Record<string, string>;
}

export interface EzRouteContext {
  url: string;
  routeId: string;
  params: Record<string, string>;
  projectId?: string;
  conversationId?: string;
  agentId?: string;
}

export interface EzContextPayload {
  route: EzRouteContext;
  data: Record<string, unknown>;
  formIds: string[];
}

function pathFromUrl(u: EzPageLike["url"]): string {
  // Accept both URL instances and `{ pathname, search? }` shapes —
  // SvelteKit's `$page.url` is a URL but tests pass either flavour.
  const path = "pathname" in u ? u.pathname : "/";
  const search = "search" in u && u.search ? u.search : "";
  return `${path}${search}`;
}

export function buildRouteContext(page: EzPageLike): EzRouteContext {
  const params = page.params ?? {};
  const ctx: EzRouteContext = {
    url: pathFromUrl(page.url),
    routeId: page.route?.id ?? "",
    params: { ...params },
  };
  // Derive entity ids from the conventional param names. Pages with
  // non-conventional names (e.g. `:projId`) won't auto-populate; they
  // can include those via `<EzContext data>` instead.
  if (typeof params.id === "string" && params.id.length > 0) {
    // Only treat `id` as a project id when the URL actually starts
    // with /project/. Other routes also use `id` and we don't want
    // false positives.
    if (ctx.url.startsWith("/project/")) ctx.projectId = params.id;
    if (ctx.url.startsWith("/agents/")) ctx.agentId = params.id;
  }
  if (typeof params.convId === "string" && params.convId.length > 0) {
    ctx.conversationId = params.convId;
  } else if (typeof params.conversationId === "string" && params.conversationId.length > 0) {
    ctx.conversationId = params.conversationId;
  }
  return ctx;
}

/**
 * Estimate the token cost of a JSON-serialized payload. Approximate;
 * we just need to detect the order of magnitude when a page over-
 * exposes data so we can warn.
 */
export function estimateTokens(value: unknown): number {
  let s: string;
  try { s = JSON.stringify(value); } catch { s = String(value); }
  return Math.ceil(s.length / APPROX_CHARS_PER_TOKEN);
}

function isDev(): boolean {
  // Vite defines `import.meta.env.DEV` at build time, but bun tests
  // run plain ESM where the meta is unset. Probe both signals; the
  // first that yields a truthy answer wins.
  try {
    const meta = (import.meta as unknown as { env?: { DEV?: boolean } });
    if (meta?.env?.DEV) return true;
  } catch { /* ignore */ }
  if (typeof process !== "undefined") {
    const env = process.env?.NODE_ENV;
    if (env && env !== "production") return true;
  }
  return false;
}

/**
 * Build the full payload that ships with each Ez message.
 *
 * The serializer is *defensive*: an entry that throws during
 * JSON.stringify (e.g. a circular reference) gets skipped, not
 * propagated. Pages should never crash the panel.
 */
export function buildEzContextPayload(page: EzPageLike, snapshot: ContextEntry[]): EzContextPayload {
  const route = buildRouteContext(page);

  const dataAccum: Record<string, unknown> = {};
  const formIds: string[] = [];
  let totalChars = 0;
  let dropped = 0;

  for (const entry of snapshot) {
    // Form ids are tiny — always include them.
    for (const formId of Object.keys(entry.forms ?? {})) {
      if (!formIds.includes(formId)) formIds.push(formId);
    }

    let serialized: string;
    try { serialized = JSON.stringify(entry.data ?? {}); }
    catch { dropped++; continue; }

    if (totalChars + serialized.length > TOKEN_BUDGET_CHARS) {
      dropped++;
      continue;
    }
    Object.assign(dataAccum, entry.data ?? {});
    totalChars += serialized.length;
  }

  if (dropped > 0 && isDev()) {
    // Single warn per send, regardless of how many entries dropped —
    // page authors get one signal to fix their data shape.
    console.warn(
      `[EzContext] page-context payload exceeded ${TOKEN_BUDGET}-token budget; ` +
      `${dropped} entr${dropped === 1 ? "y was" : "ies were"} dropped. ` +
      `Trim the data passed to <EzContext data={...}>.`,
    );
  }

  return { route, data: dataAccum, formIds };
}
