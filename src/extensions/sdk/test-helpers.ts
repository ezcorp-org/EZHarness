/**
 * SDK test helpers for extension authors.
 * Provides createTestExtension, callTool, and assertToolResult utilities.
 */

import { ExtensionProcess, parseMemoryLimit, DEFAULT_MEMORY_LIMIT_MB } from "../subprocess";
import { buildAllowedEnv } from "../registry";
import { loadManifest } from "../loader";
import type { ExtensionManifestV2 } from "../types";
import type { ToolCallResult } from "../types";
import { join } from "node:path";

export interface TestExtensionOptions {
  /** Default true. Set to false to skip prlimit/env isolation. */
  sandbox?: boolean;
}

/**
 * Create an ExtensionProcess from an extension directory path.
 * Useful in test suites to spin up an extension for integration testing.
 */
export async function createTestExtension(
  extDirOrManifestPath: string,
  opts?: TestExtensionOptions,
): Promise<ExtensionProcess> {
  // Support both directory path and legacy manifest.json path
  const extDir = extDirOrManifestPath.endsWith(".json") || extDirOrManifestPath.endsWith(".ts")
    ? extDirOrManifestPath.replace(/\/[^/]+$/, "")
    : extDirOrManifestPath;

  const configFile = Bun.file(join(extDir, "ezcorp.config.ts"));
  if (!(await configFile.exists())) {
    throw new Error(`Manifest not found: ${join(extDir, "ezcorp.config.ts")}`);
  }

  const manifest = await loadManifest(extDir);

  if (!manifest.entrypoint) {
    throw new Error("Extension manifest must declare an entrypoint");
  }

  const entrypoint = join(extDir, manifest.entrypoint.replace(/^\.\//, ""));
  const extensionId = `test-${manifest.name}`;
  const sandbox = opts?.sandbox !== false;

  let allowedEnv: Record<string, string>;
  let memoryLimitBytes: number | undefined;

  if (sandbox) {
    allowedEnv = buildAllowedEnv(manifest, { grantedAt: {} }, extensionId);
    const memStr = manifest.resources?.memory;
    memoryLimitBytes = memStr ? parseMemoryLimit(memStr) : DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024;
  } else {
    // No sandbox -- use process.env and no memory limit override
    allowedEnv = { ...process.env } as Record<string, string>;
  }

  return new ExtensionProcess(extensionId, entrypoint, allowedEnv, {
    memoryLimitBytes,
    persistent: false,
  });
}

/**
 * Call a tool on an extension process and return the result.
 */
export async function callTool(
  proc: ExtensionProcess,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  return proc.callTool(toolName, args);
}

/**
 * Assert a tool call result matches expected values.
 * Checks isError field and text content inclusion.
 */
export function assertToolResult(
  result: ToolCallResult,
  expected: { text?: string; isError?: boolean },
): void {
  if (expected.isError !== undefined && result.isError !== expected.isError) {
    throw new Error(
      `Expected isError=${expected.isError}, got isError=${result.isError}. ` +
      `Content: ${result.content.map(c => (c as { text?: string }).text).join(", ")}`,
    );
  }

  if (expected.text !== undefined) {
    const texts = result.content.map(c => (c as { text?: string }).text ?? "");
    const found = texts.some(t => t.includes(expected.text!));
    if (!found) {
      throw new Error(
        `Expected content to include "${expected.text}", got: ${texts.join(", ")}`,
      );
    }
  }
}
