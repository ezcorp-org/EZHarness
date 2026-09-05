// @ts-check
import { createCanvasBridge } from "@ezcorp/sdk/browser";
export { createCanvasBridge };

/** @type {ReturnType<typeof createCanvasBridge>|undefined} */
let bridge;
export function canvasBridge() {
  if (!bridge) {
    bridge = createCanvasBridge(window);
  }
  return bridge;
}

/** @param {string} toolName @param {Record<string,unknown>} input */
export async function invokeScannerTool(toolName, input) {
  const response = await canvasBridge().request("tool.invoke", { toolName, input });
  if (!response || response.success !== true || typeof response.output !== "string") throw new Error(response?.error || "Scanner tool failed.");
  return JSON.parse(response.output);
}
