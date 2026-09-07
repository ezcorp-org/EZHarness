/**
 * SDK test helpers for extension authors.
 * Provides createTestExtension, callTool, and assertToolResult utilities.
 */

import { ExtensionProcess, parseMemoryLimit, DEFAULT_MEMORY_LIMIT_MB } from "../subprocess";
import { buildAllowedEnv } from "../registry";
import { loadManifestFresh } from "../loader";
import type { JsonRpcRequest, JsonRpcResponse, ToolCallResult } from "../types";
import { join } from "node:path";

export interface TestExtensionOptions {
  /** Default true. Set to false to skip prlimit/env isolation. */
  sandbox?: boolean;
}

/**
 * `ext verify` has no installed extension row or database. Give its isolated
 * subprocess a small host-mediated storage transport so a scaffold can verify
 * the same Storage reverse-RPC it will use after installation.
 */
function wireVerifyStorage(
  proc: ExtensionProcess,
  manifest: Awaited<ReturnType<typeof loadManifestFresh>>,
): void {
  if (manifest.permissions.storage !== true) return;
  const values = new Map<string, unknown>();
  proc.setRequestHandler(async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    if (req.method !== "ezcorp/storage") {
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Unsupported verify RPC: ${req.method}` } };
    }
    const params = req.params ?? {};
    const key = typeof params.key === "string" ? params.key : "";
    if (!key && params.action !== "list") {
      return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "Storage key is required" } };
    }
    switch (params.action) {
      case "set":
        values.set(key, params.value);
        return { jsonrpc: "2.0", id: req.id, result: { ok: true } };
      case "get":
        return { jsonrpc: "2.0", id: req.id, result: { exists: values.has(key), value: values.get(key) ?? null } };
      case "delete":
        return { jsonrpc: "2.0", id: req.id, result: { deleted: values.delete(key) } };
      case "list":
        return { jsonrpc: "2.0", id: req.id, result: { keys: [...values.keys()] } };
      default:
        return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "Unsupported verify storage action" } };
    }
  });
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

  // Fresh (cache-busted) read: this helper backs the verify gate's
  // edit→revalidate loop, where the same directory is re-read after
  // the manifest bytes changed. Bun's module cache would otherwise
  // hand back the pre-edit entrypoint/resources declaration.
  const manifest = await loadManifestFresh(extDir);

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

  const proc = new ExtensionProcess(extensionId, entrypoint, allowedEnv, {
    memoryLimitBytes,
    persistent: false,
  });
  wireVerifyStorage(proc, manifest);
  return proc;
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
