import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { provisionToolchain } from "../src/provision";

export async function provision(): Promise<{ sdkFiles: WorkspaceFiles; toolchainFiles: WorkspaceFiles }> {
  return provisionToolchain({ sdkEntrypoint: process.env.EZ_RUNNER_SDK_ENTRY });
}

export const manifest = { schemaVersion: 4, name: "runner-test", version: "1.0.0", author: { name: "runner-tests" }, description: "Runner isolation test", permissions: {}, tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] };
export function source(handler = "async (input) => input"): Record<string, string> {
  return {
    "extension.ts": `import {defineExtension,serve} from '@ezcorp/sdk/v4'; await serve(defineExtension({manifest:${JSON.stringify(manifest)},tools:{echo:${handler}}}));`,
    "feature.test.ts": "import {test,expect} from 'bun:test';test('feature',()=>expect(1+1).toBe(2));",
    "assets/greeting.txt": "hello asset",
  };
}
