import type { ExtensionProcess } from "../subprocess";
import { extensionV4Required } from "../loader";
import type { ToolCallResult } from "../types";

export interface TestExtensionOptions {
  sandbox?: boolean;
}


export async function createTestExtension(
  _extDirOrManifestPath: string,
  _opts?: TestExtensionOptions,
): Promise<ExtensionProcess> {
  throw extensionV4Required();
}


export async function callTool(
  proc: ExtensionProcess,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  return proc.callTool(toolName, args);
}


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
