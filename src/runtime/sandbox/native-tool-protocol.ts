import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export const NATIVE_TOOL_INPUT_BYTES = 32 * 1024;
export const NATIVE_TOOL_OUTPUT_BYTES = 64 * 1024;
export const NATIVE_TOOL_ARTIFACT = "/opt/ezharness/native-tools.js";

export function encodeNativeToolRequest(operation: string, params: unknown): string {
  const json = JSON.stringify({ operation, params });
  if (Buffer.byteLength(json) > NATIVE_TOOL_INPUT_BYTES) throw new Error("Tool arguments exceed the local workspace limit");
  return Buffer.from(json).toString("base64url");
}

export function decodeNativeToolResult(stdout: string): AgentToolResult<Record<string, unknown>> {
  if (Buffer.byteLength(stdout) > NATIVE_TOOL_OUTPUT_BYTES) throw new Error("Workspace tool output exceeds its limit");
  const result = JSON.parse(stdout);
  if (!result || !Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== "text" || typeof result.content[0].text !== "string" || !result.details || typeof result.details !== "object" || Array.isArray(result.details)) {
    throw new Error("Workspace tool returned an invalid result");
  }
  return { content: [{ type: "text", text: result.content[0].text }], details: result.details };
}
