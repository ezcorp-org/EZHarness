import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { Tool } from "@mariozechner/pi-ai";

export type ToolCategory = "read" | "write" | "execute";

export type PermissionMode = "ask" | "auto-edit" | "yolo";

export type CardType = "terminal" | "diff" | "search-results" | "table" | "default";

export interface BuiltinToolDef {
  name: string;
  label: string;
  description: string;
  category: ToolCategory;
  cardType: CardType;
  /** Built-ins are always inline — this field exists for wire compat with
   *  the extension `ToolDefinition.cardLayout` and is not exercised today. */
  cardLayout?: "inline" | "dock";
  /** TypeBox schema wrapping the JSON-Schema describing the tool's args.
   *  Tool factories construct this with `Type.Unsafe({...})`; the inner
   *  parameter type is the pi-ai `Tool<TSchema>["parameters"]` default —
   *  kept at the base `TSchema` because each tool carries its own narrow
   *  shape and we don't gain much from threading a generic through this
   *  union. */
  parameters: Tool["parameters"];
  /**
   * Maximum size (in bytes) of the tool's text output that will be forwarded
   * to the model. Populated by getBuiltinToolDefs via getToolOutputLimit; the
   * individual tool factories do not need to set this themselves.
   */
  maxOutputBytes?: number;
  /**
   * Tool entry point. `params` is `unknown` because pi-agent-core delivers
   * args as a decoded-JSON blob without validating against `parameters`
   * at runtime — each tool factory is responsible for narrowing via
   * destructuring + type guards before use.
   */
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ) => Promise<AgentToolResult<unknown>>;
}
