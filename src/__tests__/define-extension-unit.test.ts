/**
 * Comprehensive unit tests for defineExtension, stripFunctions (via loadManifest),
 * loadManifestFresh, and test helpers (configContent/writeConfig).
 *
 * Does NOT duplicate tests in manifest-loader.test.ts.
 */

import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { loadManifest, loadManifestFresh } from "../extensions/loader";
import { defineExtension } from "../extensions/sdk/define";
import { configContent, writeConfig } from "./helpers/write-config";

function at<T>(arr: readonly T[] | undefined, i: number, what: string): T {
  const v = arr?.[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}
function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`expected ${what}`);
  return v;
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "define-ext-test-"));
}

const BASE = {
  schemaVersion: 2 as const,
  name: "test-ext",
  version: "1.0.0",
  description: "Test",
  author: { name: "Test" },
  permissions: {},
};

// ── defineExtension ─────────────────────────────────────────────────

describe("defineExtension", () => {
  test("returns exact same reference (identity)", () => {
    const obj = { ...BASE };
    expect(defineExtension(obj)).toBe(obj);
  });

  test("works with tools", () => {
    const config = defineExtension({
      ...BASE,
      tools: [{ name: "t", description: "d", inputSchema: { type: "object", properties: {} } }],
    });
    expect(config.tools).toHaveLength(1);
  });

  test("works with skills", () => {
    const config = defineExtension({
      ...BASE,
      skills: [{ name: "s", description: "d", prompt: "do stuff" }],
    });
    expect(at(config.skills, 0, "skill").name).toBe("s");
  });

  test("works with agent", () => {
    const config = defineExtension({
      ...BASE,
      agent: { prompt: "be helpful", category: "general" },
    });
    expect(config.agent!.prompt).toBe("be helpful");
  });

  test("works with mcpServers", () => {
    const config = defineExtension({
      ...BASE,
      mcpServers: [{ transport: "stdio", name: "m", description: "d", command: "node", args: ["./mcp.ts"] }],
    });
    const s = at(config.mcpServers, 0, "mcp server");
    expect(s.transport).toBe("stdio");
    expect(s.transport === "stdio" && s.command).toBe("node");
  });

  test("preserves function-valued handler properties at config level", () => {
    const handler = () => "hello";
    const config = defineExtension({
      ...BASE,
      tools: [{ name: "t", description: "d", inputSchema: { type: "object", properties: {} }, handler } as any],
    });
    expect((config.tools![0] as any).handler).toBe(handler);
  });

  test("works with empty config (just required fields)", () => {
    const config = defineExtension({ ...BASE });
    expect(config.name).toBe("test-ext");
    expect((config as { tools?: unknown }).tools).toBeUndefined();
  });

  test("works with deeply nested config objects", () => {
    const config = defineExtension({
      ...BASE,
      agent: {
        prompt: "test",
        modelRequirements: { tier: "powerful" },
        exampleConversations: [{
          title: "demo",
          messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hey" }],
        }],
      },
    });
    const agent = need(config.agent, "config.agent");
    expect(need(agent.modelRequirements, "modelRequirements").tier).toBe("powerful");
    expect(at(agent.exampleConversations, 0, "example conversation").messages).toHaveLength(2);
  });
});

// ── stripFunctions (tested via loadManifest roundtrip) ──────────────

describe("host manifest entrypoints are retired", () => {
  for (const source of [
    "export default {skills:[{handler:()=>null}]};",
    "export default {agent:{handler:()=>null}};",
    "export default {mcpServers:[{handler:()=>null}]};",
    "export default {tools:[{run:()=>null,handler:()=>null}]};",
    "export default {tools:[],skills:[]};",
    "export default {extra:{nested:[1,2]}};",
    "export const config = {};",
    "export default null;",
    "export default [];",
    "export default 42;",
  ]) {
    test(`refuses configuration without evaluating: ${source}`, async () => {
      const directory = await makeTempDir();
      const marker = join(directory, "executed");
      try {
        await Bun.write(join(directory, "ezcorp.config.ts"), `await Bun.write(${JSON.stringify(marker)}, "executed"); ${source}`);
        await expect(loadManifest(directory)).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
        await expect(loadManifestFresh(directory)).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
        expect(await Bun.file(marker).exists()).toBe(false);
        await Bun.write(join(directory, "ezcorp.config.ts"), "export default {name:'edited'};");
        await expect(loadManifestFresh(directory)).rejects.toThrow("Host configuration evaluation is disabled");
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }
});

describe("configContent", () => {
  test("generates valid TS export default", () => {
    const content = configContent({ name: "test", version: "1.0.0" });
    expect(content).toStartWith("export default ");
    expect(content).toEndWith(";\n");
    expect(content).toContain('"name": "test"');
  });
});

describe("writeConfig", () => {
  test("creates ezcorp.config.ts in target dir", async () => {
    const dir = await makeTempDir();
    try {
      await writeConfig(dir, BASE);
      const file = Bun.file(join(dir, "ezcorp.config.ts"));
      expect(await file.exists()).toBe(true);
      const text = await file.text();
      expect(text).toContain("test-ext");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("generated legacy metadata cannot re-enable host execution", async () => {
    const directory = await makeTempDir();
    try {
      await writeConfig(directory, BASE);
      await expect(loadManifest(directory)).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
