import { validateManifest } from "@ezcorp/extension-contract";

export function echoSource(name: string, version: string, prefix: string, description: string): Record<string, string> {
  const manifest = validateManifest({
    schemaVersion: 4 as const,
    name,
    version,
    description,
    author: { name: "shipping" },
    permissions: {},
    tools: [{ name: "echo", description: "Return a versioned echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }],
    smokeTest: { tool: "echo", input: { text: "smoke" }, expect: { textIncludes: `${prefix}smoke` } },
  });
  return {
    "extension.ts": `import { defineExtension, serve, validateManifest } from "@ezcorp/sdk/v4";\nimport { echo } from "./src/echo";\nconst manifest = validateManifest(${JSON.stringify(manifest, null, 2)});\nawait serve(defineExtension({ manifest, tools: { echo } }));\n`,
    "src/echo.ts": `export function echo(input: Record<string, unknown>) { return { text: ${JSON.stringify(prefix)} + String(input.text) }; }\n`,
    "src/echo.test.ts": `import { expect, test } from "bun:test"; import { echo } from "./echo"; test("returns ${prefix} from the real handler", () => expect(echo({ text: "feature" })).toEqual({ text: ${JSON.stringify(`${prefix}feature`)} }));\n`,
  };
}

export function echoText(result: unknown): string {
  if (!result || typeof result !== "object" || !("success" in result) || (result as { success?: unknown }).success !== true) throw new Error(`Echo invocation failed: ${JSON.stringify(result)}`);
  const output = (result as { output?: unknown }).output;
  const value = typeof output === "string" ? JSON.parse(output) : output;
  if (!value || typeof value !== "object" || typeof (value as { text?: unknown }).text !== "string") throw new Error(`Echo output was not structured text: ${JSON.stringify(output)}`);
  return (value as { text: string }).text;
}
