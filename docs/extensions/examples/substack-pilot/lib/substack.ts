// ── substack — generate_substack_draft tool implementation ──────
//
// Flow:
//   1. Look up the post type by slug (post-types.ts → Storage)
//   2. Summarize each URL (summarize.ts → fetch + LLM)
//   3. Compose the draft body via the post type's systemPrompt + summaries
//      (one LLM call with the summaries as user content)
//   4. Hand the {title, subtitle, body} to the upstream substack-mcp's
//      `create_draft_post` tool through an injectable McpCaller.
//
// Why an injectable caller: the host registry does NOT auto-launch the
// manifest's `mcpServers` entry for local-kind extensions (it only does
// so when `kind: "mcp"`, which forbids an entrypoint). To call
// substack-mcp we spawn it ourselves via the @modelcontextprotocol/sdk
// stdio transport. Unit tests inject a mock caller and never touch the
// network or the npx subprocess.
//
// Test seam:  `_setMcpCallerForTests({ call })` overrides the caller
// used by `generateSubstackDraft`. Production code lazily constructs
// the real caller on first invocation.

import { Llm, Storage, toolError, toolResult } from "@ezcorp/sdk/runtime";
import type { ToolCallResult } from "@ezcorp/sdk";
import { summarizeUrlsList, type UrlSummary } from "./summarize";
import type { ToolHandlerContext } from "@ezcorp/sdk/runtime";

// ── Post-type record shape ──────────────────────────────────────
//
// Phase 7 — `lib/post-types.ts` was deleted in the SDK port. Records
// live under the SDK's managed namespace at `__entity:post-type:<slug>`;
// we read them through the runtime Storage class against that key
// shape. The shape itself is unchanged from pre-port — the SDK schema
// at `ezcorp.config.ts:entities[0].schema` is the canonical type.

export interface PostType {
  name: string;
  slug?: string;
  systemPrompt: string;
  cadence?: string;
  defaults?: {
    titlePrefix?: string;
    subtitleTemplate?: string;
  };
}

const ENTITY_KEY_PREFIX = "__entity:post-type:";

// Test-injectable storage backend. Mirrors the SDK's runtime Storage
// interface so the same fakes used by other test files work here.
interface PostTypeStoreLike {
  get<T = unknown>(
    key: string,
  ): Promise<{ value: T | null; exists: boolean }>;
}

let _postTypeStore: PostTypeStoreLike = new Storage("user");

/** Test-only: inject a fake storage backend for post-type reads. */
export function _setPostTypeStoreForTests(fake: PostTypeStoreLike): void {
  _postTypeStore = fake;
}

/** Test-only: restore the production Storage instance. */
export function _resetPostTypeStoreForTests(): void {
  _postTypeStore = new Storage("user");
}

/**
 * Read a post type from the SDK's managed namespace by slug. Returns
 * `null` for a missing slug. Throws when the storage read itself
 * fails (e.g. permission denied) — the caller surfaces that as a
 * tool error.
 */
async function getPostType(slug: string): Promise<PostType | null> {
  const res = await _postTypeStore.get<PostType>(`${ENTITY_KEY_PREFIX}${slug}`);
  if (!res.exists || !res.value) return null;
  // The slug isn't stored on the record body (the SDK key carries it).
  // Defensive: stamp it back so downstream callers that read `.slug`
  // see the value they expect.
  return { ...res.value, slug };
}

// ── McpCaller seam ──────────────────────────────────────────────

export interface McpCaller {
  call(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}

let _caller: McpCaller | null = null;

/** Test-only: inject a mock substack-mcp caller. */
export function _setMcpCallerForTests(caller: McpCaller | null): void {
  _caller = caller;
}

/**
 * Compose-LLM facade. Only `content` is read by lib/substack — keeping
 * the interface narrow lets tests inject a one-field fake without
 * having to construct a full `LlmCompleteResult`.
 */
interface ComposeLlm {
  complete(opts: {
    provider: string;
    model: string;
    systemPrompt?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    maxTokens?: number;
  }): Promise<{ content: string }>;
}

let _llmForCompose: ComposeLlm = new Llm();
export function _setLlmForTests(llm: ComposeLlm | null): void {
  _llmForCompose = llm ?? new Llm();
}

let _provider = "anthropic";
let _model = "claude-3-5-haiku-20241022";
export function _setLlmModelForTests(provider: string, model: string): void {
  _provider = provider;
  _model = model;
}

// ── Lazy production caller construction ─────────────────────────
//
// Imports the MCP SDK on demand so unit tests that inject a caller
// never trip on the SDK's module side-effects. The SDK's stdio
// transport spawns `npx -y substack-mcp@latest` with the SUBSTACK_*
// env vars threaded through. Connect-on-first-call; reused across
// invocations within the same subprocess lifetime.
//
// Test seam: `_setMcpClientFactoryForTests` overrides the import-and-
// spawn block with an injected factory. The factory returns an
// SDK-shaped `Client` (just the `callTool` surface we use) plus the
// transport-spawn record (command/args/env) so tests can assert the
// child-process shape without ever shelling out.

interface McpClientLike {
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
}

interface McpTransportSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpClientFactory {
  (transport: McpTransportSpec): Promise<McpClientLike>;
}

let _mcpClientFactory: McpClientFactory | null = null;

/**
 * Test-only: replace the MCP SDK import-and-spawn step with an injected
 * factory. Pass `null` to restore the production code path. Tests use
 * this to exercise `getProductionCaller`'s wiring (env shaping, error
 * surfacing) without importing `@modelcontextprotocol/sdk` or spawning
 * `npx`.
 */
export function _setMcpClientFactoryForTests(
  factory: McpClientFactory | null,
): void {
  _mcpClientFactory = factory;
}

let _productionCallerPromise: Promise<McpCaller> | null = null;

async function getProductionCaller(env: {
  SUBSTACK_PUBLICATION_URL: string;
  SUBSTACK_SESSION_TOKEN: string;
  SUBSTACK_USER_ID: string;
}): Promise<McpCaller> {
  if (_productionCallerPromise) return _productionCallerPromise;
  _productionCallerPromise = (async () => {
    // Shape the child-process env once. We do NOT forward the entire
    // `process.env`; that would expose host secrets to the child. Only
    // the SUBSTACK_* vars substack-mcp needs, plus PATH/HOME so `npx`
    // can find its binaries.
    const transportEnv: Record<string, string> = {
      ...env,
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    };
    const transport: McpTransportSpec = {
      command: "npx",
      args: ["-y", "substack-mcp@latest"],
      env: transportEnv,
    };

    let client: McpClientLike;
    if (_mcpClientFactory) {
      client = await _mcpClientFactory(transport);
    } else {
      // Dynamic import keeps the SDK off the unit-test hot path (no
      // module side-effects, no transitive native deps). Untested by
      // design — see the factory seam above for the wiring-tested
      // surface.
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );
      const sdkClient = new Client(
        { name: "ezcorp-substack-pilot", version: "1.0.0" },
        { capabilities: {} },
      );
      const sdkTransport = new StdioClientTransport({
        command: transport.command,
        args: transport.args,
        env: transport.env,
      });
      await sdkClient.connect(sdkTransport);
      client = sdkClient as McpClientLike;
    }

    return {
      async call(tool, args) {
        try {
          const res = await client.callTool({ name: tool, arguments: args });
          const first = res.content?.[0];
          const text = first?.type === "text" ? (first.text ?? "") : "";
          if (res.isError) return { ok: false, error: text || `${tool} reported isError` };
          return { ok: true, text };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },
    } satisfies McpCaller;
  })();
  return _productionCallerPromise;
}

// ── Compose helpers (pure for testability) ──────────────────────

export function composeUserPrompt(
  postType: PostType,
  summaries: UrlSummary[],
): string {
  const goodSummaries = summaries.filter((s) => !s.error && s.summary.length > 0);
  const lines: string[] = [];
  lines.push(`Post type: ${postType.name} (${postType.slug})`);
  if (postType.cadence) lines.push(`Cadence: ${postType.cadence}`);
  lines.push("");
  lines.push("Per-URL summaries (use these as the substrate for the draft):");
  for (const s of goodSummaries) {
    lines.push("");
    lines.push(`- URL: ${s.url}`);
    lines.push(`  Title: ${s.title}`);
    lines.push(`  Summary: ${s.summary}`);
  }
  if (goodSummaries.length < summaries.length) {
    const failed = summaries.filter((s) => s.error || s.summary.length === 0);
    lines.push("");
    lines.push(
      `Note: ${failed.length} URL(s) failed to summarize and are omitted.`,
    );
  }
  lines.push("");
  lines.push(
    "Compose the full Substack post body using the post type's system prompt as the controlling guidance. " +
      "Output only the body — no title, no metadata, no markdown frontmatter.",
  );
  return lines.join("\n");
}

export function defaultTitle(
  postType: PostType,
  _summaries: UrlSummary[],
  overrideTitle?: string,
): string {
  if (overrideTitle && overrideTitle.trim().length > 0) return overrideTitle.trim();
  // Do NOT trim the prefix — trailing whitespace is intentional ("This Week: ").
  const prefix = postType.defaults?.titlePrefix ?? "";
  const date = new Date().toISOString().slice(0, 10);
  if (prefix.length > 0) return `${prefix}${date}`;
  return `${postType.name} — ${date}`;
}

export function defaultSubtitle(
  postType: PostType,
  summaries: UrlSummary[],
  overrideSubtitle?: string,
): string {
  if (overrideSubtitle && overrideSubtitle.trim().length > 0)
    return overrideSubtitle.trim();
  const template = postType.defaults?.subtitleTemplate;
  if (!template) return "";
  const count = summaries.filter((s) => !s.error).length;
  const date = new Date().toISOString().slice(0, 10);
  return template.replace(/\{date\}/g, date).replace(/\{count\}/g, String(count));
}

// ── Main tool ───────────────────────────────────────────────────

export async function generateSubstackDraft(
  args: Record<string, unknown>,
  ctx?: ToolHandlerContext,
): Promise<ToolCallResult> {
  const postTypeSlug = args.postTypeSlug;
  const urls = args.urls;
  const titleOverride = args.titleOverride;
  const subtitleOverride = args.subtitleOverride;

  if (typeof postTypeSlug !== "string") {
    return toolError("generate_substack_draft requires string 'postTypeSlug'");
  }
  if (!Array.isArray(urls) || urls.length === 0) {
    return toolError("generate_substack_draft requires a non-empty 'urls' array");
  }
  const urlList = urls.filter((u): u is string => typeof u === "string");
  if (urlList.length === 0) {
    return toolError("generate_substack_draft requires at least one string URL");
  }
  if (titleOverride !== undefined && typeof titleOverride !== "string") {
    return toolError("'titleOverride' must be a string when provided");
  }
  if (subtitleOverride !== undefined && typeof subtitleOverride !== "string") {
    return toolError("'subtitleOverride' must be a string when provided");
  }

  // ── 1. Look up the post type ──────────────────────────────
  let postType: PostType | null;
  try {
    postType = await getPostType(postTypeSlug);
  } catch (err) {
    return toolError(`Failed to read post type: ${(err as Error).message}`);
  }
  if (!postType) {
    return toolError(`Post type "${postTypeSlug}" not found`, "NOT_FOUND");
  }

  // ── 2. Summarize URLs ──────────────────────────────────────
  let summaries: UrlSummary[];
  try {
    summaries = await summarizeUrlsList(urlList);
  } catch (err) {
    return toolError(`Summarization failed: ${(err as Error).message}`);
  }
  const usable = summaries.filter((s) => !s.error && s.summary.length > 0);
  if (usable.length === 0) {
    return toolError(
      `All ${summaries.length} URL(s) failed to summarize: ` +
        summaries.map((s) => `${s.url} (${s.error ?? "no text"})`).join("; "),
    );
  }

  // ── 3. Compose body ───────────────────────────────────────
  const userPrompt = composeUserPrompt(postType, summaries);
  let composed: { content: string };
  try {
    composed = await _llmForCompose.complete({
      provider: _provider,
      model: _model,
      systemPrompt: postType.systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 2048,
    });
  } catch (err) {
    return toolError(`LLM compose failed: ${(err as Error).message}`);
  }

  const body = composed.content.trim();
  if (body.length === 0) {
    return toolError("LLM returned empty body — refusing to create draft");
  }

  const title = defaultTitle(postType, summaries, titleOverride);
  const subtitle = defaultSubtitle(postType, summaries, subtitleOverride);

  // ── 4. Call substack-mcp ───────────────────────────────────
  let caller: McpCaller | null = _caller;
  if (!caller) {
    const settings = (ctx?.invocationMetadata?.settings ?? {}) as Record<string, unknown>;
    const publicationUrl = settings.substack_publication_url;
    const sessionToken = settings.substack_session_token;
    const userId = settings.substack_user_id;
    if (
      typeof publicationUrl !== "string" ||
      typeof sessionToken !== "string" ||
      typeof userId !== "string" ||
      publicationUrl.length === 0 ||
      sessionToken.length === 0 ||
      userId.length === 0
    ) {
      return toolError(
        "Substack credentials missing — open /extensions/substack-pilot and fill " +
          "Publication URL, Session token, and User ID.",
        "MISSING_CREDENTIALS",
      );
    }
    try {
      caller = await getProductionCaller({
        SUBSTACK_PUBLICATION_URL: publicationUrl,
        SUBSTACK_SESSION_TOKEN: sessionToken,
        SUBSTACK_USER_ID: userId,
      });
    } catch (err) {
      return toolError(`Failed to start substack-mcp: ${(err as Error).message}`);
    }
  }

  // substack-mcp's zod schema marks subtitle as a required string (no
  // .optional()), so always send the key — empty string when we have
  // nothing to put there. Omitting it fails zod validation upstream and
  // surfaces as MCP_ERROR. Confirmed against substack-mcp@1.0.7 src.
  const mcpArgs: Record<string, unknown> = { title, subtitle, body };

  const result = await caller.call("create_draft_post", mcpArgs);
  if (!result.ok) {
    return toolError(
      `substack-mcp.create_draft_post failed: ${result.error}`,
      "MCP_ERROR",
    );
  }
  // substack-mcp returns "OK" on success per its README. We surface the
  // raw text so callers can see anything else it chose to emit (e.g. a
  // draft URL in a future version).
  return toolResult(
    JSON.stringify(
      {
        ok: true,
        postTypeSlug,
        title,
        subtitle,
        urlsSummarized: usable.length,
        urlsFailed: summaries.length - usable.length,
        mcpResponse: result.text,
        bodyPreview: body.slice(0, 200),
      },
      null,
      2,
    ),
  );
}

// Test-only — reset the lazy production caller so re-instantiations don't
// leak across test files.
export function _resetProductionCallerForTests(): void {
  _productionCallerPromise = null;
  _caller = null;
  _mcpClientFactory = null;
  _llmForCompose = new Llm();
  _provider = "anthropic";
  _model = "claude-3-5-haiku-20241022";
}

// Note: `new Llm()` satisfies the `ComposeLlm` interface because
// `LlmCompleteResult` includes `content: string`. The narrower facade
// just hides the fields lib/substack.ts doesn't read.
