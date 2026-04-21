/**
 * Central manifest loader -- imports ezcorp.config.ts, strips function-valued
 * properties from components, and validates via validateManifestV2.
 */

import type { ExtensionManifestV2 } from "./types";
import { validateManifestV2, validateMcpManifest } from "./manifest";
import { join } from "path";

// Route kind:"mcp" manifests to the stricter mcp validator (enforces
// single-server, no entrypoint, etc.). Everything else keeps the base rules.
function validateForKind(manifest: Record<string, unknown>) {
  return manifest.kind === "mcp"
    ? validateMcpManifest(manifest)
    : validateManifestV2(manifest);
}

/**
 * Strip all function-valued properties from component arrays/objects.
 * Handler references are DX-only and must not reach the validator.
 */
function stripFunctions(obj: Record<string, unknown>): Record<string, unknown> {
  const result = { ...obj };

  for (const key of ["tools", "skills", "mcpServers"] as const) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as Record<string, unknown>[]).map((item) => {
        const cleaned: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(item)) {
          if (typeof v !== "function") cleaned[k] = v;
        }
        return cleaned;
      });
    }
  }

  // Strip functions from agent object
  if (result.agent && typeof result.agent === "object" && !Array.isArray(result.agent)) {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result.agent as Record<string, unknown>)) {
      if (typeof v !== "function") cleaned[k] = v;
    }
    result.agent = cleaned;
  }

  return result;
}

/**
 * Load and validate an extension manifest from ezcorp.config.ts.
 * Cached by Bun's module system -- use loadManifestFresh() for dev reload.
 */
export async function loadManifest(dir: string): Promise<ExtensionManifestV2> {
  const configPath = join(dir, "ezcorp.config.ts");
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    throw new Error(`No ezcorp.config.ts found at ${dir}`);
  }

  const mod = await import(configPath);
  const raw = mod.default;
  if (!raw || typeof raw !== "object") {
    throw new Error("ezcorp.config.ts must have a default export");
  }

  const manifest = stripFunctions(raw as Record<string, unknown>);

  const validation = validateForKind(manifest);
  if (!validation.valid) {
    throw new Error(`Invalid manifest: ${validation.errors.join(", ")}`);
  }

  return manifest as unknown as ExtensionManifestV2;
}

/**
 * Load manifest with cache-busting for dev server hot reload.
 * Appends a query parameter to bypass Bun's import cache.
 */
export async function loadManifestFresh(dir: string): Promise<ExtensionManifestV2> {
  const configPath = join(dir, "ezcorp.config.ts");
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    throw new Error(`No ezcorp.config.ts found at ${dir}`);
  }

  const mod = await import(`${configPath}?v=${Date.now()}`);
  const raw = mod.default;
  if (!raw || typeof raw !== "object") {
    throw new Error("ezcorp.config.ts must have a default export");
  }

  const manifest = stripFunctions(raw as Record<string, unknown>);

  const validation = validateForKind(manifest);
  if (!validation.valid) {
    throw new Error(`Invalid manifest: ${validation.errors.join(", ")}`);
  }

  return manifest as unknown as ExtensionManifestV2;
}
