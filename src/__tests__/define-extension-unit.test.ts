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

describe("stripFunctions via loadManifest", () => {
  test("strips functions from skills array items", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(join(dir, "ezcorp.config.ts"), `export default {
        schemaVersion: 2, name: "t", version: "1.0.0", description: "T",
        author: { name: "T" }, permissions: {},
        skills: [{ name: "s", description: "d", onInvoke: () => {} }],
      };\n`);
      const m = await loadManifest(dir);
      const skill = at(m.skills, 0, "skill");
      expect((skill as any).onInvoke).toBeUndefined();
      expect(skill.name).toBe("s");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("strips functions from agent object", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(join(dir, "ezcorp.config.ts"), `export default {
        schemaVersion: 2, name: "t", version: "1.0.0", description: "T",
        author: { name: "T" }, permissions: {},
        agent: { prompt: "hi", onMessage: () => {} },
      };\n`);
      const m = await loadManifest(dir);
      expect((m.agent as any).onMessage).toBeUndefined();
      expect(m.agent!.prompt).toBe("hi");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("strips functions from mcpServers array items", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(join(dir, "ezcorp.config.ts"), `export default {
        schemaVersion: 2, name: "t", version: "1.0.0", description: "T",
        author: { name: "T" }, permissions: {},
        mcpServers: [{ transport: "stdio", name: "m", description: "d", command: "node", args: ["./m.ts"], setup: () => {} }],
      };\n`);
      const m = await loadManifest(dir);
      const server = at(m.mcpServers, 0, "mcp server");
      expect((server as any).setup).toBeUndefined();
      expect(server.name).toBe("m");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves non-function properties (strings, numbers, objects, arrays)", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(join(dir, "ezcorp.config.ts"), `export default {
        schemaVersion: 2, name: "t", version: "1.0.0", description: "T",
        author: { name: "T" }, permissions: {},
        entrypoint: "./index.ts",
        tools: [{
          name: "tool1", description: "d",
          inputSchema: { type: "object", properties: { x: { type: "number" } } },
          extra: 42, tags: ["a", "b"],
        }],
      };\n`);
      const m = await loadManifest(dir);
      const tool = m.tools![0] as any;
      expect(tool.extra).toBe(42);
      expect(tool.tags).toEqual(["a", "b"]);
      expect(tool.inputSchema.properties.x.type).toBe("number");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles empty tools/skills arrays", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(join(dir, "ezcorp.config.ts"), `export default {
        schemaVersion: 2, name: "t", version: "1.0.0", description: "T",
        author: { name: "T" }, permissions: {},
        tools: [], skills: [],
      };\n`);
      const m = await loadManifest(dir);
      expect(m.tools).toEqual([]);
      expect(m.skills).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles missing tools/skills/agent keys", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(join(dir, "ezcorp.config.ts"), `export default {
        schemaVersion: 2, name: "t", version: "1.0.0", description: "T",
        author: { name: "T" }, permissions: {},
      };\n`);
      const m = await loadManifest(dir);
      // Phase 1's migrateManifestV2ToV3 normalizes missing `tools` to
      // an empty array in the v3 shape. `skills` and `agent` aren't
      // added by the migration, so they stay undefined.
      expect(m.tools).toEqual([]);
      expect(m.skills).toBeUndefined();
      expect(m.agent).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles multiple function properties on same tool", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(join(dir, "ezcorp.config.ts"), `export default {
        schemaVersion: 2, name: "t", version: "1.0.0", description: "T",
        author: { name: "T" }, permissions: {},
        tools: [{
          name: "t", description: "d",
          inputSchema: { type: "object", properties: {} },
          handler: () => {}, validate: () => {}, transform: () => {},
        }],
        entrypoint: "./index.ts",
      };\n`);
      const m = await loadManifest(dir);
      const tool = m.tools![0] as any;
      expect(tool.handler).toBeUndefined();
      expect(tool.validate).toBeUndefined();
      expect(tool.transform).toBeUndefined();
      expect(tool.name).toBe("t");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does NOT strip functions from top-level config", async () => {
    const dir = await makeTempDir();
    try {
      // Top-level functions should pass through stripFunctions unchanged.
      // We write a config with a top-level function and verify it survives.
      await Bun.write(join(dir, "ezcorp.config.ts"), `export default {
        schemaVersion: 2, name: "t", version: "1.0.0", description: "T",
        author: { name: "T" }, permissions: {},
        onInstall: () => "installed",
      };\n`);
      const m = await loadManifest(dir);
      expect(typeof (m as any).onInstall).toBe("function");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── loadManifest error paths ────────────────────────────────────────

describe("loadManifest error paths", () => {
  test("throws when no default export (named export only)", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(join(dir, "ezcorp.config.ts"), `export const config = { name: "x" };\n`);
      await expect(loadManifest(dir)).rejects.toThrow(/must have a default export/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when default export is null", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(join(dir, "ezcorp.config.ts"), `export default null;\n`);
      await expect(loadManifest(dir)).rejects.toThrow(/must have a default export/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when default export is an array", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(join(dir, "ezcorp.config.ts"), `export default [1, 2, 3];\n`);
      // Arrays are typeof "object" so they pass the object check but fail validation
      await expect(loadManifest(dir)).rejects.toThrow(/Invalid manifest/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when default export is a number", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(join(dir, "ezcorp.config.ts"), `export default 42;\n`);
      await expect(loadManifest(dir)).rejects.toThrow(/must have a default export/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("passes through extra unknown properties", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(join(dir, "ezcorp.config.ts"), `export default {
        schemaVersion: 2, name: "t", version: "1.0.0", description: "T",
        author: { name: "T" }, permissions: {},
        customField: "hello", anotherExtra: 123,
      };\n`);
      const m = await loadManifest(dir);
      expect((m as any).customField).toBe("hello");
      expect((m as any).anotherExtra).toBe(123);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── loadManifestFresh ───────────────────────────────────────────────

describe("loadManifestFresh", () => {
  test("returns valid manifest (basic)", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(join(dir, "ezcorp.config.ts"),
        `export default ${JSON.stringify(BASE)};\n`);
      const m = await loadManifestFresh(dir);
      expect(m.name).toBe("test-ext");
      // Phase 1: loadManifestFresh auto-promotes v2 → v3.
      expect(m.schemaVersion).toBe(3);
      expect((m as { _inheritedFromV2?: boolean })._inheritedFromV2).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns updated content after file rewrite (cache-busting)", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(join(dir, "ezcorp.config.ts"),
        `export default ${JSON.stringify({ ...BASE, name: "original" })};\n`);
      const m1 = await loadManifestFresh(dir);
      expect(m1.name).toBe("original");

      // Small delay to ensure Date.now() produces a different cache-bust param
      await Bun.sleep(5);

      await Bun.write(join(dir, "ezcorp.config.ts"),
        `export default ${JSON.stringify({ ...BASE, name: "updated" })};\n`);
      const m2 = await loadManifestFresh(dir);
      expect(m2.name).toBe("updated");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── configContent / writeConfig helpers ─────────────────────────────

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

  test("generated config is loadable by loadManifest", async () => {
    const dir = await makeTempDir();
    try {
      await writeConfig(dir, BASE);
      const m = await loadManifestFresh(dir);
      expect(m.name).toBe("test-ext");
      // Phase 1: loadManifestFresh auto-promotes v2 → v3.
      expect(m.schemaVersion).toBe(3);
      expect((m as { _inheritedFromV2?: boolean })._inheritedFromV2).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
