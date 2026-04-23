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
  return lines.join("\n");
}

// ── Handlers ────────────────────────────────────────────────────────

export function makeGenerateHandler(): ToolHandler {
  return async (args) => {
    const input = (args ?? {}) as Record<string, unknown>;
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) return toolError("`prompt` is required and must be a non-empty string.");
    const augment = input.augment !== false;
    const fields = fieldsFromInput(input);
    const finalPrompt = augmentPrompt(prompt, augment, fields);

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
      };
      if (authPath.kind === "codex") {
        // Codex built-in `image_gen` tool takes no argument controls —
        // the model chooses size/quality. Only prompt + optional model
        // override go through.
        imgs = await generateViaCodex(authPath.token, {
          prompt: finalPrompt,
          model: typeof input.model === "string" ? input.model : undefined,
        });
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
      return toolError("`images` must be a non-empty array of data: or https: URIs.");
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
