// ── defineExtension Helper ──────────────────────────────────────
// Identity function at runtime; provides type inference at dev time.
// Follows ecosystem convention (Vite defineConfig, Drizzle defineConfig).

import type { ExtensionManifestV2, ToolDefinition, SkillDefinition } from "./types";

/**
 * Extension config type that allows function-valued properties on components.
 * Functions (e.g. handler references) are stripped at load time before validation.
 */
type WithFunctions<T> = T & { [key: string]: unknown };

type ExtensionConfig = Omit<ExtensionManifestV2, "tools" | "skills" | "agent"> & {
  tools?: (WithFunctions<ToolDefinition>)[];
  skills?: (WithFunctions<SkillDefinition>)[];
  agent?: WithFunctions<NonNullable<ExtensionManifestV2["agent"]>>;
};

export function defineExtension<T extends ExtensionConfig>(config: T): T {
  return config;
}
