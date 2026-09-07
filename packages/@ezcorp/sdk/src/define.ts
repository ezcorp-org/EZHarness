// ── defineExtension Helper ──────────────────────────────────────
// Identity function at runtime; provides type inference at dev time.
// Follows ecosystem convention (Vite defineConfig, Drizzle defineConfig).

import type {
  ExtensionManifestV2,
  ToolDefinition,
} from "./types";

/**
 * `handler` is the only function-bearing field in an authored manifest. The
 * host strips it before runtime validation; spelling it explicitly keeps the
 * surrounding config closed to misspelled fields.
 */
/** Runtime handlers are stripped before validation, but must be callable. */
type ToolHandler = (...args: never[]) => unknown;

type ToolConfig = ToolDefinition & { handler?: ToolHandler };

type ExtensionConfig = Omit<ExtensionManifestV2, "tools"> & {
  tools?: ToolConfig[];
};

type NoExtraProperties<Shape, Actual extends Shape> = Actual & Record<
  Exclude<keyof Actual, keyof Shape>,
  never
>;

export function defineExtension<const T extends ExtensionConfig>(
  config: NoExtraProperties<ExtensionConfig, T>,
): ExtensionConfig {
  return config;
}
