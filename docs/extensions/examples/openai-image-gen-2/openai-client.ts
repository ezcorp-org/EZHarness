// Thin wrapper around OpenAI's public Images API. All network goes
// through `fetchPermitted` so the host's allowlist is authoritative.
//
// Used only on the BYOK `sk-…` path. OAuth-connected users flow through
// `codex-client.ts` (Codex Responses API with the built-in
// image_generation tool) because their tokens are Codex-scoped and
// cannot authenticate to `api.openai.com/v1/images/*`.

import { fetchPermitted } from "@ezcorp/sdk/runtime";

export const GPT_IMAGE_MODEL_PREFIX = "gpt-image-";
// Matches the Codex imagegen skill's fallback CLI default
// (scripts/image_gen.py → DEFAULT_MODEL = "gpt-image-1.5").
export const DEFAULT_IMAGE_MODEL = "gpt-image-1.5";
export const IMAGES_GENERATE_URL = "https://api.openai.com/v1/images/generations";
export const IMAGES_EDIT_URL = "https://api.openai.com/v1/images/edits";

export const ALLOWED_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536", "auto"]);
export const ALLOWED_QUALITIES = new Set(["low", "medium", "high", "auto"]);
export const ALLOWED_BACKGROUNDS = new Set(["transparent", "opaque", "auto"]);
export const ALLOWED_OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
export const ALLOWED_INPUT_FIDELITIES = new Set(["low", "high"]);

export interface ImagesCommonParams {
  model?: string;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  output_compression?: number;
}

export interface GenerateParams extends ImagesCommonParams {
  prompt: string;
}

export interface EditParams extends ImagesCommonParams {
  prompt: string;
  images: string[];
  mask?: string;
  input_fidelity?: string;
}

export interface GeneratedImage {
  b64: string;
  mimeType: string;
}

export class OpenAIImageError extends Error {
  constructor(public readonly code: "auth" | "validation" | "api" | "network", message: string) {
    super(message);
    this.name = "OpenAIImageError";
  }
}

// ── Auth resolution ─────────────────────────────────────────────────

export interface AuthEnv {
  OPENAI_API_KEY?: string;
  OPENAI_ACCESS_TOKEN?: string;
}

export function resolveAuth(env: AuthEnv = process.env as AuthEnv): { token: string; source: "api_key" } {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (apiKey) return { token: apiKey, source: "api_key" };
  throw new OpenAIImageError(
    "auth",
    "OPENAI_API_KEY must be set for the Images API path. Set a classic sk-… key in admin settings.",
  );
}

// ── Validation ───────────────────────────────────────────────────────

function requireGptImageModel(model: string): void {
  if (!model.startsWith(GPT_IMAGE_MODEL_PREFIX)) {
    throw new OpenAIImageError(
      "validation",
      `model must be a gpt-image-* id (e.g. gpt-image-1). Got: ${model}`,
    );
  }
}

function requireEnum(name: string, value: string | undefined, allowed: Set<string>): void {
  if (value === undefined) return;
  if (!allowed.has(value)) {
    throw new OpenAIImageError(
      "validation",
      `${name} must be one of ${[...allowed].join(", ")}. Got: ${value}`,
    );
  }
}

function requireTransparencyCompat(background: string | undefined, outputFormat: string | undefined): void {
  if (background === "transparent" && outputFormat && outputFormat !== "png" && outputFormat !== "webp") {
    throw new OpenAIImageError(
      "validation",
      "background=transparent requires output_format=png or webp.",
    );
  }
}

function normalizeModel(model: string | undefined): string {
  const m = (model ?? DEFAULT_IMAGE_MODEL).trim();
  requireGptImageModel(m);
  return m;
}

export function validateGenerateParams(p: GenerateParams): Required<Pick<GenerateParams, "model" | "prompt">> & ImagesCommonParams {
  if (typeof p.prompt !== "string" || p.prompt.trim().length === 0) {
    throw new OpenAIImageError("validation", "`prompt` is required and must be a non-empty string.");
  }
  const model = normalizeModel(p.model);
  requireEnum("size", p.size, ALLOWED_SIZES);
  requireEnum("quality", p.quality, ALLOWED_QUALITIES);
  requireEnum("background", p.background, ALLOWED_BACKGROUNDS);
  requireEnum("output_format", p.output_format, ALLOWED_OUTPUT_FORMATS);
  requireTransparencyCompat(p.background, p.output_format);
  if (p.output_compression !== undefined) {
    if (!Number.isInteger(p.output_compression) || p.output_compression < 0 || p.output_compression > 100) {
      throw new OpenAIImageError("validation", "output_compression must be an integer between 0 and 100.");
    }
  }
  return { ...p, model, prompt: p.prompt.trim() };
}

export function validateEditParams(p: EditParams): EditParams & { model: string } {
  if (typeof p.prompt !== "string" || p.prompt.trim().length === 0) {
    throw new OpenAIImageError("validation", "`prompt` is required and must be a non-empty string.");
  }
  if (!Array.isArray(p.images) || p.images.length === 0) {
    throw new OpenAIImageError("validation", "`images` must be a non-empty array of data/https URIs.");
  }
  if (p.images.length > 4) {
    throw new OpenAIImageError("validation", "at most 4 input images are supported.");
  }
  for (const img of p.images) {
    if (typeof img !== "string" || img.trim().length === 0) {
      throw new OpenAIImageError("validation", "each image must be a non-empty data: or https: URI.");
    }
    if (!img.startsWith("data:image/") && !img.startsWith("https://")) {
      throw new OpenAIImageError("validation", "images must be data:image/ URIs or https:// URLs.");
    }
  }
  if (p.mask !== undefined && p.mask !== null) {
    if (typeof p.mask !== "string" || !(p.mask.startsWith("data:image/") || p.mask.startsWith("https://"))) {
      throw new OpenAIImageError("validation", "mask must be a data:image/ URI or https:// URL.");
    }
  }
  const model = normalizeModel(p.model);
  requireEnum("size", p.size, ALLOWED_SIZES);
  requireEnum("quality", p.quality, ALLOWED_QUALITIES);
  requireEnum("background", p.background, ALLOWED_BACKGROUNDS);
  requireEnum("output_format", p.output_format, ALLOWED_OUTPUT_FORMATS);
  requireEnum("input_fidelity", p.input_fidelity, ALLOWED_INPUT_FIDELITIES);
  requireTransparencyCompat(p.background, p.output_format);
  return { ...p, model, prompt: p.prompt.trim() };
}

// ── Fetch helpers ────────────────────────────────────────────────────

export type Fetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;

async function fetchImageRef(fetcher: Fetcher, ref: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (ref.startsWith("data:image/")) {
    const comma = ref.indexOf(",");
    if (comma === -1) throw new OpenAIImageError("validation", "malformed data: URI — missing comma.");
    const meta = ref.slice(5, comma);
    const isBase64 = /;base64$/i.test(meta);
    const mimeType = meta.replace(/;base64$/i, "");
    const payload = ref.slice(comma + 1);
    if (!isBase64) throw new OpenAIImageError("validation", "data: URI must use ;base64 encoding.");
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return { bytes, mimeType };
  }
  const res = await fetcher(ref);
  if (!res.ok) {
    throw new OpenAIImageError("network", `failed to fetch ${ref}: HTTP ${res.status}`);
  }
  const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, mimeType };
}

// ── Public API ───────────────────────────────────────────────────────

function extMimeFromOutputFormat(fmt: string | undefined): string {
  switch (fmt) {
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "png":
    default: return "image/png";
  }
}

async function assertApiOk(res: Response): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  throw new OpenAIImageError("api", `OpenAI Images API returned HTTP ${res.status}${text ? `: ${text.slice(0, 400)}` : ""}`);
}

interface ImagesApiResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
}

function extractB64(resp: ImagesApiResponse, mimeType: string): GeneratedImage[] {
  const out: GeneratedImage[] = [];
  for (const item of resp.data ?? []) {
    if (typeof item.b64_json === "string" && item.b64_json.length > 0) {
      out.push({ b64: item.b64_json, mimeType });
    }
  }
  if (out.length === 0) {
    throw new OpenAIImageError("api", "OpenAI response did not include any base64 image data.");
  }
  return out;
}

export async function generate(
  p: GenerateParams,
  opts: { fetcher?: Fetcher; env?: AuthEnv } = {},
): Promise<GeneratedImage[]> {
  const valid = validateGenerateParams(p);
  const { token } = resolveAuth(opts.env);
  const fetcher = opts.fetcher ?? fetchPermitted;
  const body: Record<string, unknown> = {
    model: valid.model,
    prompt: valid.prompt,
    size: valid.size ?? "1024x1024",
    quality: valid.quality ?? "auto",
  };
  if (valid.background) body.background = valid.background;
  if (valid.output_format) body.output_format = valid.output_format;
  if (valid.output_compression !== undefined) body.output_compression = valid.output_compression;

  const res = await fetcher(IMAGES_GENERATE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  await assertApiOk(res);
  const json = (await res.json().catch(() => {
    throw new OpenAIImageError("api", "OpenAI response was not valid JSON.");
  })) as ImagesApiResponse;
  return extractB64(json, extMimeFromOutputFormat(valid.output_format));
}

export async function edit(
  p: EditParams,
  opts: { fetcher?: Fetcher; env?: AuthEnv } = {},
): Promise<GeneratedImage[]> {
  const valid = validateEditParams(p);
  const { token } = resolveAuth(opts.env);
  const fetcher = opts.fetcher ?? fetchPermitted;

  const form = new FormData();
  form.append("model", valid.model);
  form.append("prompt", valid.prompt);
  if (valid.size) form.append("size", valid.size);
  if (valid.quality) form.append("quality", valid.quality);
  if (valid.background) form.append("background", valid.background);
  if (valid.output_format) form.append("output_format", valid.output_format);
  if (valid.output_compression !== undefined) form.append("output_compression", String(valid.output_compression));
  if (valid.input_fidelity) form.append("input_fidelity", valid.input_fidelity);

  for (let i = 0; i < valid.images.length; i++) {
    const ref = valid.images[i]!;
    const { bytes, mimeType } = await fetchImageRef(fetcher, ref);
    form.append("image[]", new Blob([bytes as BlobPart], { type: mimeType }), `image-${i}.${mimeType.split("/")[1] ?? "png"}`);
  }
  if (valid.mask) {
    const { bytes, mimeType } = await fetchImageRef(fetcher, valid.mask);
    form.append("mask", new Blob([bytes as BlobPart], { type: mimeType }), "mask.png");
  }

  const res = await fetcher(IMAGES_EDIT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  await assertApiOk(res);
  const json = (await res.json().catch(() => {
    throw new OpenAIImageError("api", "OpenAI response was not valid JSON.");
  })) as ImagesApiResponse;
  return extractB64(json, extMimeFromOutputFormat(valid.output_format));
}
