/**
 * Per-model attachment capability table for multi-modal chat.
 *
 * Single source of truth for which file types a given provider+model accepts,
 * how large they may be, and how we deliver them to pi-ai.
 *
 * pi-ai itself carries only TextContent and ImageContent parts. Richer kinds
 * (PDF, audio) must be bridged by us: PDFs are text-extracted into TextContent;
 * audio is not wired in Phase 1 and is therefore rejected unless a model is
 * explicitly marked `audioNative: true` in the override table below.
 */

import { resolveModelObject } from "./registry";

export type AttachmentKind = "image" | "text" | "pdf" | "audio" | "extension-handle";

export type DeliveryStrategy =
  | "native-image" // base64 ImageContent
  | "text-inline" // inlined as TextContent with <file> wrapper
  | "pdf-text-extract" // extract text via pdf-parse → TextContent
  | "audio-native" // provider-native audio (Phase 2; not currently wired)
  | "extension-handle-only"; // emit handle reference; extension tools resolve bytes on demand

export interface AttachmentCapabilities {
  kinds: AttachmentKind[];
  acceptedMimeTypes: string[];
  maxBytesPerFile: number;
  maxFilesPerMessage: number;
  /** Per-kind delivery strategy used by content-builder. */
  deliveryFor: Partial<Record<AttachmentKind, DeliveryStrategy>>;
  /**
   * MIMEs that were contributed by wired extensions (rather than the
   * static per-model table). Populated by
   * {@link getCapabilitiesWithExtensions}. Used by the capability-aware
   * classifier and by content-builder to route extension MIMEs through
   * the `extension-handle-only` delivery path.
   */
  extensionHandleMimes?: ReadonlySet<string>;
}

// ── MIME whitelists per kind ───────────────────────────────────────

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const TEXT_MIMES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/css",
  "text/javascript",
  "text/x-python",
  "text/x-typescript",
  "application/json",
  "application/xml",
  "application/x-yaml",
] as const;
export const PDF_MIMES = ["application/pdf"] as const;
export const AUDIO_MIMES = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/m4a", "audio/ogg"] as const;

// ── Default size limits ───────────────────────────────────────────

const MB = 1024 * 1024;
const DEFAULT_MAX_BYTES = 20 * MB;
const DEFAULT_MAX_FILES = 10;

// ── Static override table ─────────────────────────────────────────
// Keyed by `${provider}:${modelId-prefix-or-id}`. Longest-prefix match wins.

interface Override {
  pdfNative?: boolean;
  audioNative?: boolean;
  maxBytesPerFile?: number;
}

const OVERRIDES: Array<{ match: (provider: string, modelId: string) => boolean; override: Override }> = [
  // Anthropic Claude: PDFs supported natively on API; we still extract text in
  // Phase 1 because pi-ai has no PDF content type, but the user can upload them.
  { match: (p) => p === "anthropic", override: { pdfNative: true, maxBytesPerFile: 32 * MB } },
  // Google Gemini: PDFs supported; audio also supported but not wired in Phase 1.
  { match: (p) => p === "google" || p === "google-gemini-cli", override: { pdfNative: true, maxBytesPerFile: 20 * MB } },
  // OpenAI GPT-4o and o-series: PDFs via vision on some models; permit upload.
  { match: (p, m) => p === "openai" && (/gpt-4o|o[1-9]|gpt-4-turbo/.test(m)), override: { pdfNative: true } },
];

function findOverride(provider: string, modelId: string): Override {
  const merged: Override = {};
  for (const row of OVERRIDES) {
    if (row.match(provider, modelId)) Object.assign(merged, row.override);
  }
  return merged;
}

// ── Public API ────────────────────────────────────────────────────

export function getCapabilities(provider: string, modelId: string): AttachmentCapabilities {
  const model = resolveModelObject(provider, modelId);
  const supportsImage = model.input.includes("image");
  const override = findOverride(provider, modelId);

  const kinds: AttachmentKind[] = ["text"]; // every model can receive inlined text
  const accepted: string[] = [...TEXT_MIMES];
  const deliveryFor: AttachmentCapabilities["deliveryFor"] = { text: "text-inline" };

  if (supportsImage) {
    kinds.push("image");
    accepted.push(...IMAGE_MIMES);
    deliveryFor.image = "native-image";
  }

  // PDFs: accept on any model; deliver via text extraction so text-only models
  // still see the content. (pi-ai has no PDF content type, so native PDF
  // handling isn't distinguishable to us yet — extraction is always safe.)
  kinds.push("pdf");
  accepted.push(...PDF_MIMES);
  deliveryFor.pdf = "pdf-text-extract";

  if (override.audioNative) {
    kinds.push("audio");
    accepted.push(...AUDIO_MIMES);
    deliveryFor.audio = "audio-native";
  }

  return {
    kinds,
    acceptedMimeTypes: accepted,
    maxBytesPerFile: override.maxBytesPerFile ?? DEFAULT_MAX_BYTES,
    maxFilesPerMessage: DEFAULT_MAX_FILES,
    deliveryFor,
  };
}

/**
 * Conversation-scoped capabilities: the static per-model table from
 * {@link getCapabilities}, augmented with MIMEs supplied by extensions
 * wired into the conversation.
 *
 * Extension-supplied MIMEs use the `extension-handle-only` delivery
 * strategy: the LLM sees a `<file>` reference containing only the
 * `ez-attachment://<id>` handle, and the extension's own tools read the
 * bytes on demand (the runtime handle-resolver substitutes the handle to
 * a `data:` URI before tool dispatch).
 *
 * MIMEs already accepted by the base capabilities (e.g. an extension
 * declaring `application/pdf`) are NOT downgraded — the existing
 * delivery strategy wins. This protects core handling from extension
 * misconfiguration.
 */
export function getCapabilitiesWithExtensions(
  provider: string,
  modelId: string,
  extensionMimes: readonly string[],
): AttachmentCapabilities {
  const base = getCapabilities(provider, modelId);
  if (extensionMimes.length === 0) return base;

  const accepted = [...base.acceptedMimeTypes];
  const extMimes = new Set<string>();
  for (const m of extensionMimes) {
    if (typeof m !== "string" || m.length === 0) continue;
    if (base.acceptedMimeTypes.includes(m)) continue; // base wins
    if (extMimes.has(m)) continue;
    extMimes.add(m);
    accepted.push(m);
  }
  if (extMimes.size === 0) return base;

  return {
    ...base,
    kinds: base.kinds.includes("extension-handle")
      ? base.kinds
      : [...base.kinds, "extension-handle"],
    acceptedMimeTypes: accepted,
    deliveryFor: {
      ...base.deliveryFor,
      "extension-handle": "extension-handle-only",
    },
    extensionHandleMimes: extMimes,
  };
}

export function isMimeAccepted(caps: AttachmentCapabilities, mimeType: string): boolean {
  return caps.acceptedMimeTypes.includes(mimeType);
}

/**
 * Classify a MIME against the static whitelists. Extension-supplied
 * MIMEs aren't visible here — call {@link classifyMimeWithCaps} when
 * caller has a per-conversation `AttachmentCapabilities` to consult.
 */
export function classifyMime(mimeType: string): AttachmentKind | null {
  if ((IMAGE_MIMES as readonly string[]).includes(mimeType)) return "image";
  if ((TEXT_MIMES as readonly string[]).includes(mimeType)) return "text";
  if ((PDF_MIMES as readonly string[]).includes(mimeType)) return "pdf";
  if ((AUDIO_MIMES as readonly string[]).includes(mimeType)) return "audio";
  return null;
}

/**
 * Capability-aware classifier: returns "extension-handle" for MIMEs an
 * extension contributed via {@link getCapabilitiesWithExtensions}. Falls
 * back to the static whitelists for everything else.
 */
export function classifyMimeWithCaps(
  caps: AttachmentCapabilities,
  mimeType: string,
): AttachmentKind | null {
  if (caps.extensionHandleMimes?.has(mimeType)) return "extension-handle";
  return classifyMime(mimeType);
}
