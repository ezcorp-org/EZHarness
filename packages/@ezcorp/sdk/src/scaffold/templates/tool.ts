import type { ExtensionManifestV4 } from "@ezcorp/extension-contract";
import type { ExtType } from "../index";

export function templateData(type: ExtType, name: string, description: string): ExtensionManifestV4 {
  const hasTools = type === "tool" || type === "multi";
  const toolName = type === "multi" ? `${name}-tool` : `${name}-example`;
  return {
    schemaVersion: 4, name, version: "0.1.0", description, author: { name: "Your Name" }, entrypoint: "./extension.ts", permissions: {},
    ...(hasTools ? {
      tools: [{ name: toolName, description: `Example tool for ${name}`, inputSchema: { type: "object", properties: { input: { type: "string" } }, additionalProperties: false }, outputSchema: { type: "object", required: ["content", "isError"], properties: { content: { type: "array", items: { type: "object", required: ["type", "text"], properties: { type: { const: "text" }, text: { type: "string" } }, additionalProperties: false } }, isError: { type: "boolean" } }, additionalProperties: false } }],
      smokeTest: { tool: toolName, input: { input: "smoke" }, expect: { isError: false, textIncludes: "Received: smoke" } },
    } : {}),
    ...(type === "skill" || type === "multi" ? { skills: [{ name: type === "multi" ? `${name}-skill` : `${name}-example`, description, prompt: `You are a helpful assistant specialized in ${name}. ${description}` }] } : {}),
    ...(type === "agent" || type === "multi" ? { agent: { prompt: `You are ${name}. ${description}`, category: "Other" } } : {}),
  };
}

export function templateManifest(type: ExtType, name: string, description: string): string {
  return `import { validateManifest } from "@ezcorp/sdk/v4";\n\nexport default validateManifest(${JSON.stringify(templateData(type, name, description), null, 2)});\n`;
}
export function templateEntrypoint(type: ExtType, name: string): string {
  const toolName = type === "multi" ? `${name}-tool` : `${name}-example`;
  const tools = type === "tool" || type === "multi" ? `, tools: { ${JSON.stringify(toolName)}: (input) => ({ content: [{ type: "text", text: "Received: " + ((input as { input?: string }).input ?? "") }], isError: false }) }` : "";
  return `import { defineExtension, serve } from "@ezcorp/sdk/v4";\nimport manifest from "./ezcorp.config";\n\nexport const extension = defineExtension({ manifest${tools} });\nif (import.meta.main) await serve(extension);\n`;
}
export function templateTest(type: ExtType, name: string): string {
  const manifest = templateData(type, name, "Test");
  const invoke = manifest.smokeTest ? `\ntest("declared tool executes and validates input", async () => {\n  const context = { invocation: { invocationId: "test", workerId: "worker", releaseId: "release", principalId: "user", scopeId: "scope", token: "test", deadline: Date.now() + 1000 }, signal: new AbortController().signal, call: async () => { throw new Error("No host capability was declared"); } };\n  expect(await extension.invoke(${JSON.stringify(manifest.smokeTest.tool)}, { input: "smoke" }, context)).toEqual({ content: [{ type: "text", text: "Received: smoke" }], isError: false });\n  await expect(extension.invoke(${JSON.stringify(manifest.smokeTest.tool)}, { input: 1 }, context)).rejects.toThrow();\n});\n` : "";
  return `import { expect, test } from "bun:test";\nimport { extension } from "./extension";\n\ntest("declared metadata is preserved", () => {\n  expect(extension.manifest.schemaVersion).toBe(4);\n  expect(extension.manifest.name).toBe(${JSON.stringify(name)});\n  expect(extension.manifest.permissions).toEqual({});\n  expect(extension.manifest.tools?.length ?? 0).toBe(${manifest.tools?.length ?? 0});\n  expect(extension.manifest.skills?.length ?? 0).toBe(${manifest.skills?.length ?? 0});\n  expect(Boolean(extension.manifest.agent)).toBe(${Boolean(manifest.agent)});\n});\n${invoke}`;
}
export function templateReadme(type: ExtType, name: string, description: string): string {
  return `# ${name}\n\n${description}\n\nThis version 4 ${type} extension uses the SDK transport and declares no host permissions.\n\n## Development\n\nUse the matching pinned SDK peer dependency for local editing. The harness runner supplies its trusted SDK and compiler; do not add them to runtime dependencies. Run \`bun install\` and \`bun test\` with the matching SDK available.\n\n## Install\n\nImport this directory through Extensions → Import Source. Build the workspace in the isolated runner, review its test results and exact permissions, then ask a human administrator to approve the release before activation. Local tests do not grant approval.\n\nEdit ezcorp.config.ts to change contribution metadata. Keep tool input/output schemas and smoke tests in sync with extension.ts. Prompt-only skills and agents also serve isolated discovery through extension.ts. No configuration executes on the host.\n`;
}

export function toolManifest(name: string, description: string): string { return templateManifest("tool", name, description); }
export function toolEntrypoint(name: string, _description: string): string { return templateEntrypoint("tool", name); }
export function toolTest(name: string, _description: string): string { return templateTest("tool", name); }
export function toolReadme(name: string, description: string): string { return templateReadme("tool", name, description); }
