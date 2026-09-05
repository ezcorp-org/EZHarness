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
  if (!response || typeof response !== "object" || !("success" in response) || response.success !== true || !("output" in response) || typeof response.output !== "string") {
    throw new Error(response && typeof response === "object" && "error" in response && typeof response.error === "string" ? response.error : "Scanner tool failed.");
  }
  return JSON.parse(response.output);
}
