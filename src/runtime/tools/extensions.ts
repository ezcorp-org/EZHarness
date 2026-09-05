import { Type } from "@earendil-works/pi-ai";
import { extensionControlTools, type ExtensionControl } from "../../extensions/extension-control";
import type { LifecycleActor } from "../../extensions/v4/types";
import { errorMessage, toolError, type BuiltinToolDef } from "./types";
import type { BuiltInToolMeta } from "./builtin-registry";

export function getExtensionControlMetadata(): BuiltInToolMeta[] {
  return extensionControlTools.map((tool) => ({ name: tool.name, description: tool.description, category: "extensions", inputSchema: { type: "object", properties: tool.properties, required: tool.required, additionalProperties: false }, mentionable: false }));
}

export function createExtensionControlTools(actor: LifecycleActor, control: () => Promise<ExtensionControl>): BuiltinToolDef[] {
  return getExtensionControlMetadata().map((metadata) => ({
    name: metadata.name,
    label: metadata.name,
    description: metadata.description,
    category: "ez",
    cardType: "default",
    callTimeoutMs: 310000,
    parameters: Type.Unsafe(metadata.inputSchema!),
    execute: async (_toolCallId, input, signal) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) return toolError("Extension tool input must be an object.");
      try {
        const definition = extensionControlTools.find((tool) => tool.name === metadata.name)!;
        const result = await (await control()).execute({ ...actor, kind: "agent" }, definition.name, input as Record<string, unknown>, signal);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      } catch (error) {
        return toolError(errorMessage(error), { code: error && typeof error === "object" && "code" in error ? error.code : "extension_control_failed" });
      }
    },
  }));
}
