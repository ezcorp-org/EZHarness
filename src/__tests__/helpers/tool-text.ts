import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export function toolText(result: AgentToolResult<unknown>): string {
  return result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
}
