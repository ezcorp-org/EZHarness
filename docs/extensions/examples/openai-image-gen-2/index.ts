#!/usr/bin/env bun
// openai-image-gen-2 — image generation via OpenAI.
// Two paths:
//   - Subscription OAuth → Codex Responses + image_generation tool
//   - BYOK sk-… key      → classic /v1/images/generations

import {
  createToolDispatcher,
  getChannel,
  toolError,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

import { augmentPrompt, fieldsFromInput } from "./prompt-augment";
import {
  edit as editImages,
  generate as generateImages,
  OpenAIImageError,
  type GeneratedImage,
} from "./openai-client";
import {
  CodexImageError,
  generateViaCodex,
  type GeneratedImage as CodexGeneratedImage,
} from "./codex-client";
import { saveImageToDisk, type SavedImage } from "./image-storage";

type AuthPath = { kind: "codex"; token: string } | { kind: "images" };

/**
 * Preference order:
 *   1. OAuth (subscription) → Codex Responses path
 *   2. BYOK sk-… key        → public Images API path
 *
 * OAuth wins when both are set because it's what the user actively
 * connected — and it's the only path that works under a ChatGPT Plus
 * subscription without separate API credit.
 */
export function resolveAuthPath(env: NodeJS.ProcessEnv = process.env): AuthPath | null {
  const oauth = env.OPENAI_ACCESS_TOKEN?.trim();
  if (oauth) return { kind: "codex", token: oauth };
  if (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0) {
    return { kind: "images" };
  }
  return null;
}

/**
 * Build the text returned to the model. We write each image to disk and
 * reference it by short URL — base64 data URIs would be replayed in the
 * next turn's context and blow past the model's window (a single
 * 1024x1024 PNG base64 is ~100k tokens).
 */
export async function formatResult(
  prompt: string,
  images: Array<GeneratedImage | CodexGeneratedImage>,
): Promise<string> {
  const saved: SavedImage[] = [];
  for (const img of images) {
    saved.push(await saveImageToDisk(img.b64, img.mimeType));
  }
  const lines: string[] = [];
  lines.push(`Generated ${saved.length} image${saved.length === 1 ? "" : "s"} with OpenAI.`);
  lines.push("");
  const altSafe =
    prompt.replace(/[\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "generated image";
  for (const s of saved) {
    lines.push(`![${altSafe}](${s.url})`);
  }
  // Hint for the assistant. Some models will otherwise ask the user to
  // re-paste the URLs even though they're right there in this tool
  // result. The `edit` tool accepts these URLs verbatim — no upload, no
  // re-fetch, no user confirmation needed.
  lines.push("");
  lines.push(
    "Note to assistant: the image URL(s) above are in the form " +
    "`/api/ext-files/openai-image-gen-2/<relPath>` and can be passed " +
    "DIRECTLY back into this extension's `edit` tool's `images` array. " +
    "Do NOT ask the user to re-paste or re-upload them — copy them from " +
    "this result and call `edit` yourself.",
  );
  return lines.join("\n");
}

// ── Handlers ────────────────────────────────────────────────────────

/**
 * Defensively clamp the requested image count to [1, 4]. The tool's JSON
 * schema also enforces this, but extension subprocesses can't trust their
 * inputs — schema-violating tool calls do get emitted by models in the
 * wild — so we re-clamp here. Non-integer / non-finite inputs collapse
 * to 1 (the legacy single-image behavior).
 */
export function clampN(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
  const floored = Math.floor(raw);
  if (floored < 1) return 1;
  if (floored > 4) return 4;
  return floored;
}

export function makeGenerateHandler(): ToolHandler {
  return async (args) => {
    const input = (args ?? {}) as Record<string, unknown>;
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) return toolError("`prompt` is required and must be a non-empty string.");
    const augment = input.augment !== false;
    const fields = fieldsFromInput(input);
    const finalPrompt = augmentPrompt(prompt, augment, fields);
    const n = clampN(input.n);

    const authPath = resolveAuthPath();
    if (!authPath) {
      return toolError(
        "Authentication error: connect OpenAI via the platform's OpenAI sign-in (preferred, uses your subscription) or set an sk-… key in admin settings. Neither OPENAI_ACCESS_TOKEN nor OPENAI_API_KEY was injected.",
      );
    }

    try {
      let imgs: GeneratedImage[] | CodexGeneratedImage[];
      const common = {
        prompt: finalPrompt,
        model: typeof input.model === "string" ? input.model : undefined,
        size: typeof input.size === "string" ? input.size : undefined,
        quality: typeof input.quality === "string" ? input.quality : undefined,
        background: typeof input.background === "string" ? input.background : undefined,
        output_format: typeof input.output_format === "string" ? input.output_format : undefined,
        output_compression: typeof input.output_compression === "number" ? input.output_compression : undefined,
        n,
      };
      if (authPath.kind === "codex") {
        // Codex built-in `image_gen` tool takes no argument controls —
        // the model chooses size/quality, and there is no native `n`
        // knob on the Responses API. For multi-image requests we fan
        // out N parallel calls with the same prompt.
        //
        // Failure handling: `Promise.all` rejects on first failure so
        // the whole call surfaces an error the model can react to (e.g.
        // retry with a smaller `n`). `allSettled` would let us return
        // partial results, but a "some images, some errors" card is
        // murky UX and out of scope for v1.
        if (n === 1) {
          imgs = await generateViaCodex(authPath.token, {
            prompt: finalPrompt,
            model: typeof input.model === "string" ? input.model : undefined,
          });
        } else {
          const results = await Promise.all(
            Array.from({ length: n }, () =>
              generateViaCodex(authPath.token, {
                prompt: finalPrompt,
                model: typeof input.model === "string" ? input.model : undefined,
              }),
            ),
          );
          imgs = results.flat();
        }
      } else {
        imgs = await generateImages(common);
      }
      return toolResult(await formatResult(prompt, imgs));
    } catch (err) {
      return toolError(describeError(err));
    }
  };
}

export function makeEditHandler(): ToolHandler {
  return async (args) => {
    const input = (args ?? {}) as Record<string, unknown>;
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) return toolError("`prompt` is required and must be a non-empty string.");
    const images = Array.isArray(input.images)
      ? (input.images as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    if (images.length === 0) {
      return toolError(
        "`images` must be a non-empty array of data: URIs, https:// URLs, or /api/ext-files/openai-image-gen-2/<relPath> URLs.",
      );
    }
    const augment = input.augment !== false;
    const fields = fieldsFromInput(input);
    const finalPrompt = augmentPrompt(prompt, augment, fields);

    const authPath = resolveAuthPath();
    if (!authPath) {
      return toolError(
        "Authentication error: connect OpenAI via the platform's OpenAI sign-in or set an sk-… key in admin settings.",
      );
    }

    try {
      let imgs: GeneratedImage[] | CodexGeneratedImage[];
      if (authPath.kind === "codex") {
        // Same argument-free contract as the generate path.
        imgs = await generateViaCodex(authPath.token, {
          prompt: finalPrompt,
          inputImages: images,
          model: typeof input.model === "string" ? input.model : undefined,
        });
      } else {
        imgs = await editImages({
          prompt: finalPrompt,
          images,
          mask: typeof input.mask === "string" ? input.mask : undefined,
          model: typeof input.model === "string" ? input.model : undefined,
          size: typeof input.size === "string" ? input.size : undefined,
          quality: typeof input.quality === "string" ? input.quality : undefined,
          background: typeof input.background === "string" ? input.background : undefined,
          output_format: typeof input.output_format === "string" ? input.output_format : undefined,
          output_compression: typeof input.output_compression === "number" ? input.output_compression : undefined,
          input_fidelity: typeof input.input_fidelity === "string" ? input.input_fidelity : undefined,
        });
      }
      return toolResult(await formatResult(prompt, imgs));
    } catch (err) {
      return toolError(describeError(err));
    }
  };
}

function describeError(err: unknown): string {
  if (err instanceof OpenAIImageError || err instanceof CodexImageError) {
    const source = err instanceof CodexImageError ? "Codex" : "OpenAI";
    const prefix =
      err.code === "auth"
        ? "Authentication error"
        : err.code === "validation"
          ? "Invalid input"
          : err.code === "api"
            ? `${source} API error`
            : "Network error";
    return `${prefix}: ${err.message}`;
  }
  return `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
}

export function buildHandlers(): Record<string, ToolHandler> {
  return {
    generate: makeGenerateHandler(),
    edit: makeEditHandler(),
  };
}

export function start(): void {
  const ch = getChannel();
  createToolDispatcher(buildHandlers());
  ch.start();
}

if (import.meta.main) start();
