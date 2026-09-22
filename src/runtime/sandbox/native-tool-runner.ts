import { validateToolArguments } from "@earendil-works/pi-ai";
import { getNativeToolDefs } from "../tools/native-tools";
import { toolError } from "../tools/types";
import { NATIVE_TOOL_INPUT_BYTES, NATIVE_TOOL_OUTPUT_BYTES } from "./native-tool-protocol";

/** Runs only inside the isolated workspace. The production entry fixes the
 * root; host paths and credentials never enter this request protocol. */
export async function executeNativeTool(root: string, encoded: string): Promise<string> {
  try {
    if (encoded.length > Math.ceil(NATIVE_TOOL_INPUT_BYTES * 4 / 3)) throw new Error("Input limit");
    const request = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const tool = getNativeToolDefs(root).find((candidate) => candidate.name === request.operation);
    if (!tool) throw new Error("Unknown tool");
    const params = validateToolArguments(tool, { type: "toolCall", id: "native", name: tool.name, arguments: request.params });
    const result = await tool.execute("native", params);
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json) <= NATIVE_TOOL_OUTPUT_BYTES) return json;
    // Bound the serialized JSON, including escaped Unicode and control bytes.
    const text = result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
    return JSON.stringify({ content: [{ type: "text", text: `${text.slice(0, 8000)}\n[workspace output truncated]` }], details: { truncated: true, isError: !!(result.details && typeof result.details === "object" && "isError" in result.details && result.details.isError) } });
  } catch {
    return JSON.stringify(toolError("Native workspace tool failed"));
  }
}
