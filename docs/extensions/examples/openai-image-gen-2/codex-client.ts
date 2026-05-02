// Codex Responses API client for image generation using a subscription
// OAuth token (the Codex CLI path).
//
// Why this exists: a classic `sk-…` API key hits
// `api.openai.com/v1/images/generations` directly. An OAuth token from
// the platform's OpenAI sign-in is Codex-scoped — it lacks
// `api.model.images.request` and gets HTTP 401 there. But the same
// token IS accepted by the Codex Responses endpoint
// (`chatgpt.com/backend-api/codex/responses`), and that endpoint
// supports the built-in `image_generation` tool. This file wraps that
// call: POST with `tools: [{type: "image_generation", ...}]`, parse
// SSE, pluck base64 images out of `image_generation_call` outputs.

import { fetchPermitted } from "@ezcorp/sdk/runtime";
import {
  ACCEPTED_IMAGE_REF_HELP,
  isAcceptedImageRef,
  isExtFileUrl,
  readExtFileBytes,
  resolveExtFileUrl,
} from "./ext-files";

export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
// Model allowlist for ChatGPT-account Codex Responses. `gpt-5.4` is the
// current Codex CLI default (see ~/.codex/config.toml). Legacy
// `gpt-5-codex` and Images-API-only `gpt-image-*` ids are rejected with
// HTTP 400 "model is not supported when using Codex with a ChatGPT
// account" — silently remap them to the default.
export const DEFAULT_CODEX_MODEL = "gpt-5.4";
export const CODEX_ALLOWED_MODEL_PREFIXES = ["gpt-5.1", "gpt-5.2", "gpt-5.3", "gpt-5.4"];

/** Pick the right model for the Codex path. Ignores `gpt-image-*` and
 *  legacy `gpt-5-codex` which the ChatGPT-account endpoint rejects. */
export function resolveCodexModel(requested: string | undefined | null): string {
  if (typeof requested === "string" && requested.trim().length > 0) {
    const m = requested.trim();
    for (const prefix of CODEX_ALLOWED_MODEL_PREFIXES) {
      if (m === prefix || m.startsWith(`${prefix}-`)) return m;
    }
  }
  return DEFAULT_CODEX_MODEL;
}

export type Fetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;

export class CodexImageError extends Error {
  constructor(public readonly code: "auth" | "validation" | "api" | "network", message: string) {
    super(message);
    this.name = "CodexImageError";
  }
}

export interface CodexImageOptions {
  prompt: string;
  model?: string;
  inputImages?: string[];
  // NOTE: size/quality/background/output_format/output_compression are
  // intentionally NOT accepted here. Per the Codex skill spec
  // (references/image-api.md), the built-in `image_gen` tool does not
  // expose the same controls as the public Images API — those live on
  // the CLI fallback path only. Passing them as tool args would be
  // ignored at best and rejected at worst.
}

export interface GeneratedImage {
  b64: string;
  mimeType: string;
}

// ── Auth helpers ─────────────────────────────────────────────────────

/** Parse a JWT (no signature check) and return the `chatgpt_account_id`
 *  the Codex endpoint requires in the `chatgpt-account-id` header. */
export function extractChatGPTAccountId(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new CodexImageError("auth", "OpenAI OAuth token is not a valid JWT (wrong segment count).");
  }
  let payload: unknown;
  try {
    const raw = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    payload = JSON.parse(atob(padded));
  } catch {
    throw new CodexImageError("auth", "Failed to decode OAuth token JWT payload.");
  }
  const auth = (payload as Record<string, unknown>)?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
  const id = auth?.["chatgpt_account_id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new CodexImageError("auth", "OAuth token has no chatgpt_account_id claim — sign in again via the platform's OpenAI OAuth flow.");
  }
  return id;
}

// ── Request body ─────────────────────────────────────────────────────

/** The wire type for the built-in image-generation tool. The Codex
 *  skill docs refer to it as "image_gen" in prose (that's the tool's
 *  human-facing name), but the actual JSON type the endpoint accepts
 *  is "image_generation" — verified against the codex binary's own
 *  string table (search for `"type": "image_generation_call"`) and
 *  against the endpoint's error surface ("Unsupported tool type:
 *  image_gen" when we tried the shorthand, no error when we use the
 *  wire name). */
export const CODEX_IMAGE_TOOL_TYPE = "image_generation";

function buildUserInput(o: CodexImageOptions): unknown[] {
  const content: unknown[] = [{ type: "input_text", text: o.prompt }];
  for (const img of o.inputImages ?? []) {
    content.push({ type: "input_image", image_url: img });
  }
  return [{ role: "user", content }];
}

/** Codex Responses rejects requests whose `instructions` field is null or
 *  empty ("Instructions are required"). A minimal one-liner telling the
 *  model to use the built-in image tool is enough — the user's real
 *  prompt rides in `input`. */
export const CODEX_INSTRUCTIONS =
  "You are an image generation assistant. Use the built-in image_gen tool to create or edit the image the user asks for. Return the generated image as your output.";

export function buildRequestBody(o: CodexImageOptions): Record<string, unknown> {
  return {
    model: resolveCodexModel(o.model),
    instructions: CODEX_INSTRUCTIONS,
    input: buildUserInput(o),
    // Built-in tool takes no arguments — the model decides size/quality/etc.
    tools: [{ type: CODEX_IMAGE_TOOL_TYPE }],
    parallel_tool_calls: false,
    stream: true,
    store: false,
  };
}

// ── Input image materialization ──────────────────────────────────────

// Codex's ChatGPT-account backend cannot reach the host's localhost
// `/api/ext-files/...` URLs — those are served by the EZCorp web layer,
// not the public internet. So before sending, we resolve any ext-files
// URLs locally and inline the bytes as base64 data: URIs. `data:` and
// `https://` entries pass through untouched.
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export async function materializeInputImages(
  inputImages: readonly string[] | undefined,
  cwd: string = process.cwd(),
): Promise<string[]> {
  if (!inputImages || inputImages.length === 0) return [];
  const out: string[] = [];
  for (const img of inputImages) {
    // Symmetric URL-form check with the BYOK path (validateEditParams in
    // openai-client.ts). Without this, an unknown-namespace ext-files URL
    // — e.g. `/api/ext-files/<other-ext>/foo.png` — would fall through
    // and be sent as an opaque image_url to the Codex backend, which
    // can't fetch localhost and would surface an unclear `api` error.
    if (!isAcceptedImageRef(img)) {
      throw new CodexImageError("validation", ACCEPTED_IMAGE_REF_HELP);
    }
    if (!isExtFileUrl(img)) {
      out.push(img);
      continue;
    }
    const resolved = resolveExtFileUrl(img, cwd);
    if (!resolved) {
      throw new CodexImageError(
        "validation",
        `ext-files URL is malformed or escapes the extension data root: ${img}`,
      );
    }
    let bytes: Uint8Array;
    let mimeType: string;
    try {
      ({ bytes, mimeType } = await readExtFileBytes(resolved.absPath));
    } catch {
      throw new CodexImageError(
        "validation",
        `ext-files URL points to a missing file (the prior generation may have been cleaned up): ${img}`,
      );
    }
    out.push(`data:${mimeType};base64,${bytesToBase64(bytes)}`);
  }
  return out;
}

// ── SSE parsing ──────────────────────────────────────────────────────

type SSEEvent = { event?: string; data?: string };

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev: SSEEvent = {};
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith("event:")) ev.event = line.slice(6).trim();
          else if (line.startsWith("data:")) ev.data = (ev.data ?? "") + line.slice(5).trim();
        }
        if (ev.data !== undefined) yield ev;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Pull every base64 image out of an SSE stream, halt on errors.
 *  Recognizes `response.output_item.done` events with an
 *  `item.type === "image_generation_call"` that carries `item.result`. */
export async function extractImagesFromStream(
  stream: ReadableStream<Uint8Array>,
  mimeTypeForOutputFormat: (fmt: string | undefined) => string,
): Promise<GeneratedImage[]> {
  const out: GeneratedImage[] = [];
  for await (const ev of parseSSE(stream)) {
    if (!ev.data) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      continue;
    }
    const type = parsed.type;
    if (
      type === "response.output_item.done" ||
      type === "response.image_gen_call.completed" ||
      type === "response.image_generation_call.completed"
    ) {
      const item = (parsed.item ?? parsed) as Record<string, unknown>;
      const itemType = item.type;
      // Accept both names: the built-in Codex tool emits `image_gen_call`;
      // the public Responses API uses `image_generation_call`. Match
      // either so output extraction is robust across minor endpoint
      // differences.
      if (itemType === "image_gen_call" || itemType === "image_generation_call") {
        const result = item.result;
        if (typeof result === "string" && result.length > 0) {
          const outputFormat = typeof item.output_format === "string" ? (item.output_format as string) : undefined;
          out.push({ b64: result, mimeType: mimeTypeForOutputFormat(outputFormat) });
        }
      }
    }
    if (type === "error" || type === "response.error") {
      const msg = (parsed.message as string | undefined) ?? "Codex stream reported an error";
      throw new CodexImageError("api", msg);
    }
  }
  if (out.length === 0) {
    throw new CodexImageError("api", "Codex stream completed without an image_generation_call result.");
  }
  return out;
}

// ── Public API ───────────────────────────────────────────────────────

function mimeTypeForOutputFormat(fmt: string | undefined): string {
  switch (fmt) {
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    default: return "image/png";
  }
}

export async function generateViaCodex(
  token: string,
  options: CodexImageOptions,
  opts: { fetcher?: Fetcher; sessionId?: string } = {},
): Promise<GeneratedImage[]> {
  if (typeof token !== "string" || token.length === 0) {
    throw new CodexImageError("auth", "OAuth token is required.");
  }
  if (typeof options.prompt !== "string" || options.prompt.trim().length === 0) {
    throw new CodexImageError("validation", "`prompt` is required and must be a non-empty string.");
  }
  const accountId = extractChatGPTAccountId(token);
  const fetcher = opts.fetcher ?? fetchPermitted;

  // Inline ext-files URLs to data: URIs before the request leaves the
  // host — the Codex backend can't fetch our localhost routes.
  const materializedInputImages = await materializeInputImages(options.inputImages);
  const effectiveOptions: CodexImageOptions = {
    ...options,
    inputImages: materializedInputImages,
  };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "chatgpt-account-id": accountId,
    "OpenAI-Beta": "responses=experimental",
    originator: "ezcorp",
    "content-type": "application/json",
    accept: "text/event-stream",
  };
  if (opts.sessionId) headers["session_id"] = opts.sessionId;

  const res = await fetcher(CODEX_RESPONSES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(buildRequestBody(effectiveOptions)),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new CodexImageError(
      res.status === 401 || res.status === 403 ? "auth" : "api",
      `Codex Responses API returned HTTP ${res.status}${text ? `: ${text.slice(0, 400)}` : ""}`,
    );
  }
  if (!res.body) {
    throw new CodexImageError("api", "Codex Responses API returned no body.");
  }

  return extractImagesFromStream(res.body, mimeTypeForOutputFormat);
}
