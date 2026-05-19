// ── summarize — URL fetch + LLM summarization ───────────────────
//
// Two trust-boundary calls per URL:
//   1. `fetch(url)` — gated by the sandbox-preload wrapper against
//      `permissions.network`. We declare `*` to support user-pasted
//      URLs; the per-host PDP is the canonical gate.
//   2. `ctx.llm.complete(...)` — gated by `permissions.llm.providers`.
//      We try the first granted provider by default.
//
// HTML → text extraction is intentionally crude: strip script/style,
// drop tags, collapse whitespace, cap at 8KB before sending to the LLM.
// This is "best-effort summary input" — we are not building a reader-
// mode parser. If the LLM can't summarize a page from 8KB of stripped
// text, that's a per-page failure, not an architectural issue.

import { Llm, toolError, toolResult } from "@ezcorp/sdk/runtime";
import type { ToolCallResult } from "@ezcorp/sdk";

const DEFAULT_WORDS = 80;
const MAX_WORDS = 400;
const TEXT_CAP_BYTES = 8 * 1024; // ~2k tokens of input per URL

// ── Test-injectable backends ────────────────────────────────────

type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

interface LlmLike {
  complete(opts: {
    provider: string;
    model: string;
    systemPrompt?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    maxTokens?: number;
  }): Promise<{ content: string }>;
}

// SSRF guard: `redirect: "manual"` makes the browser-style fetch surface
// 3xx responses to us instead of silently following them. A user-pasted
// `https://attacker.example/...` that 301→`http://169.254.169.254/...`
// (AWS metadata) or `http://localhost:…` (internal services) would
// otherwise slip through any per-host allowlist applied to the FIRST
// URL only. `summarizeOne` below rejects 3xx as a per-URL error.
let _fetch: FetchLike = (url) =>
  fetch(url, { redirect: "manual" }).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
  }));

let _llm: LlmLike = new Llm();

let _provider = "anthropic";
let _model = "claude-3-5-haiku-20241022";

/** Test-only: inject fetch + LLM. */
export function _setBackendsForTests(opts: {
  fetch?: FetchLike;
  llm?: LlmLike;
  provider?: string;
  model?: string;
}): void {
  if (opts.fetch) _fetch = opts.fetch;
  if (opts.llm) _llm = opts.llm;
  if (opts.provider) _provider = opts.provider;
  if (opts.model) _model = opts.model;
}

export function _resetBackendsForTests(): void {
  _fetch = (url) =>
    fetch(url, { redirect: "manual" }).then((r) => ({
      ok: r.ok,
      status: r.status,
      text: () => r.text(),
    }));
  _llm = new Llm();
  _provider = "anthropic";
  _model = "claude-3-5-haiku-20241022";
}

// ── HTML extraction ─────────────────────────────────────────────

export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m || !m[1]) return "";
  // Decode the four entities most likely to appear in titles. Anything
  // more exotic is left raw — we're not building a parser.
  return m[1]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractText(html: string, capBytes = TEXT_CAP_BYTES): string {
  // Drop scripts + styles before generic tag stripping so their bodies
  // don't bleed into the output. `[\s\S]` matches across newlines.
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const noTags = noScript.replace(/<[^>]+>/g, " ");
  const decoded = noTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const collapsed = decoded.replace(/\s+/g, " ").trim();
  // Cap by bytes (utf-8) so the LLM input stays bounded even for pages
  // dominated by CJK or emoji.
  const buf = Buffer.from(collapsed, "utf-8");
  if (buf.byteLength <= capBytes) return collapsed;
  return buf.subarray(0, capBytes).toString("utf-8");
}

// ── Public summarize API ────────────────────────────────────────

export interface UrlSummary {
  url: string;
  title: string;
  summary: string;
  error?: string;
}

export interface SummarizeOptions {
  maxWordsPerSummary?: number;
}

export async function summarizeOne(
  url: string,
  opts: SummarizeOptions = {},
): Promise<UrlSummary> {
  const wordCap = clampWords(opts.maxWordsPerSummary);
  let resp: Awaited<ReturnType<FetchLike>>;
  try {
    resp = await _fetch(url);
  } catch (err) {
    return { url, title: "", summary: "", error: `fetch failed: ${(err as Error).message}` };
  }
  // Explicit 3xx rejection — under `redirect: "manual"` we surface
  // redirects as `!ok` with a 3xx status. Treat them as a per-URL
  // failure so a `https://public.example/r → http://169.254.169.254/`
  // redirect can never be silently followed. (Per-host PDP gates only
  // see the FIRST URL.)
  if (resp.status >= 300 && resp.status < 400) {
    return {
      url,
      title: "",
      summary: "",
      error: `redirect refused (HTTP ${resp.status}); pass the final URL directly`,
    };
  }
  if (!resp.ok) {
    return { url, title: "", summary: "", error: `HTTP ${resp.status}` };
  }
  const html = await resp.text();
  const title = extractTitle(html) || url;
  const text = extractText(html);

  if (text.length === 0) {
    return { url, title, summary: "", error: "no extractable text" };
  }

  const systemPrompt =
    "You write tight, factual summaries for inclusion in a Substack roundup. " +
    `Aim for ~${wordCap} words. Lead with the most useful takeaway. ` +
    "No filler, no preamble, no markdown bullets — just one short paragraph.";

  const userPrompt =
    `URL: ${url}\n` +
    `Title: ${title}\n\n` +
    `Article text (truncated):\n${text}`;

  let completion: { content: string };
  try {
    completion = await _llm.complete({
      provider: _provider,
      model: _model,
      systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      // Output token budget: ~1.5x the target word count (very rough).
      maxTokens: Math.ceil(wordCap * 1.6),
    });
  } catch (err) {
    return { url, title, summary: "", error: `LLM failed: ${(err as Error).message}` };
  }

  return { url, title, summary: completion.content.trim() };
}

export async function summarizeUrlsList(
  urls: string[],
  opts: SummarizeOptions = {},
): Promise<UrlSummary[]> {
  // Sequential (not Promise.all) to keep per-extension LLM rate-limit
  // pressure predictable. Parallelism is a Phase 2 tweak.
  const out: UrlSummary[] = [];
  for (const url of urls) {
    out.push(await summarizeOne(url, opts));
  }
  return out;
}

// ── Tool wrapper ────────────────────────────────────────────────

export async function summarizeUrls(args: {
  urls?: unknown;
  maxWordsPerSummary?: unknown;
}): Promise<ToolCallResult> {
  if (!Array.isArray(args.urls)) {
    return toolError("summarize_urls requires 'urls' array");
  }
  const urls = args.urls.filter((u): u is string => typeof u === "string");
  if (urls.length === 0) {
    return toolError("summarize_urls requires at least one string URL");
  }
  // Reject non-http(s) up front; the network handler would deny anyway,
  // but the per-URL error is friendlier than a torn fetch promise.
  for (const u of urls) {
    if (!/^https?:\/\//i.test(u)) {
      return toolError(`Invalid URL (must be http/https): ${u}`);
    }
  }
  const wordCap =
    typeof args.maxWordsPerSummary === "number" ? args.maxWordsPerSummary : undefined;
  try {
    const summaries = await summarizeUrlsList(
      urls,
      wordCap !== undefined ? { maxWordsPerSummary: wordCap } : {},
    );
    return toolResult(JSON.stringify({ summaries }, null, 2));
  } catch (err) {
    return toolError(`summarize_urls failed: ${(err as Error).message}`);
  }
}

// ── helpers ─────────────────────────────────────────────────────

function clampWords(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return DEFAULT_WORDS;
  return Math.min(Math.floor(n), MAX_WORDS);
}
