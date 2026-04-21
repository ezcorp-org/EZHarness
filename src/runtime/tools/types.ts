import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";

export type ToolCategory = "read" | "write" | "execute";

export type PermissionMode = "ask" | "auto-edit" | "yolo";

export type CardType = "terminal" | "diff" | "search-results" | "table" | "default";

export interface BuiltinToolDef {
  name: string;
  label: string;
  description: string;
  category: ToolCategory;
  cardType: CardType;
  parameters: any;
  /**
   * Maximum size (in bytes) of the tool's text output that will be forwarded
   * to the model. Populated by getBuiltinToolDefs via getToolOutputLimit; the
   * individual tool factories do not need to set this themselves.
   */
  maxOutputBytes?: number;
  execute: (
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ) => Promise<AgentToolResult<any>>;
}
