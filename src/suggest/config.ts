/**
 * Composer-suggestions configuration.
 *
 * Settings (admin-editable via /api/settings/[key]) win over env vars, env
 * vars over defaults. The feature defaults ON — but the enhancement half
 * additionally requires a reachable local model endpoint (compose ships an
 * Ollama sidecar; see docker-compose.yml), and the whole popover stays
 * hidden for drafts that produce no relevant matches.
 */

import { getSetting } from "../db/queries/settings";

export const SUGGEST_ENABLED_KEY = "suggest:enabled";
export const SUGGEST_MODEL_KEY = "suggest:model";
export const SUGGEST_URL_KEY = "suggest:ollama-url";

/** Per-project toggle key — mirrors the `project:<id>:systemPrompt`
 *  convention. Layering: the GLOBAL key is an override (off ⇒ off
 *  everywhere); when it's on, each project's own toggle governs. */
export function projectSuggestKey(projectId: string): string {
  return `project:${projectId}:suggest:enabled`;
}

/**
 * Per-project gate (default ON). Callers check this AFTER the global
 * override in getSuggestConfig — a null projectId (no project context)
 * falls back to the global answer alone.
 */
export async function isSuggestEnabledForProject(projectId: string | null): Promise<boolean> {
  if (!projectId) return true;
  const value = await getSetting(projectSuggestKey(projectId));
  return value === undefined ? true : value === true;
}

/** Accuracy-first default. Topic Contexts (the heaviest consumer of this
 *  sidecar) needs a model strong enough for grammar-constrained topic
 *  detection AND verbatim extraction; a 4B tag is the floor that holds up.
 *  A modest CPU-only box may not be able to load it — that is exactly what
 *  the resource-aware support gate (`src/contexts/model-support.ts`) probes
 *  for before any real use, falling back to a cloud / turn model when it
 *  can't. Override with `EZCORP_SUGGEST_MODEL` (e.g. `qwen3:1.7b` on a small
 *  host, or a larger tag on a GPU box). */
export const DEFAULT_SUGGEST_MODEL = "qwen3.5:4b";

/** Enhancement calls run 2–6s on CPU-only hosts; 12s covers a cold sidecar
 *  without pinning composer requests forever. */
export const SUGGEST_ENHANCE_TIMEOUT_MS = 12_000;

export interface SuggestConfig {
  enabled: boolean;
  /** Local model endpoint (OpenAI-compatible); null = enhancement off. */
  baseUrl: string | null;
  model: string;
  timeoutMs: number;
}

export async function getSuggestConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<SuggestConfig> {
  const enabledSetting = await getSetting(SUGGEST_ENABLED_KEY);
  const enabled = enabledSetting === undefined ? true : enabledSetting === true;

  const urlSetting = await getSetting(SUGGEST_URL_KEY);
  const settingUrl = typeof urlSetting === "string" ? urlSetting.trim() : "";
  const baseUrl = settingUrl || env.EZCORP_SUGGEST_OLLAMA_URL?.trim() || null;

  const modelSetting = await getSetting(SUGGEST_MODEL_KEY);
  const settingModel = typeof modelSetting === "string" ? modelSetting.trim() : "";
  const model = settingModel || env.EZCORP_SUGGEST_MODEL?.trim() || DEFAULT_SUGGEST_MODEL;

  return { enabled, baseUrl, model, timeoutMs: SUGGEST_ENHANCE_TIMEOUT_MS };
}
