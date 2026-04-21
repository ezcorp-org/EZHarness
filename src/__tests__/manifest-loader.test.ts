/**
 * Tests for the manifest loader (loadManifest, loadManifestFresh)
 * and defineExtension identity helper.
 */

import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { loadManifest, loadManifestFresh } from "../extensions/loader";
import { defineExtension } from "../extensions/sdk/define";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "loader-test-"));
}

const VALID_MANIFEST = {
  schemaVersion: 2 as const,
  name: "test-ext",
  version: "1.0.0",
  description: "Test",
  author: { name: "Test" },
  permissions: {},
};

describe("loadManifest", () => {
  test("loads a valid ezcorp.config.ts", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(
        join(dir, "ezcorp.config.ts"),
        `export default ${JSON.stringify(VALID_MANIFEST)};\n`,
      );
      const manifest = await loadManifest(dir);
      expect(manifest.name).toBe("test-ext");
      expect(manifest.schemaVersion).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when ezcorp.config.ts is missing", async () => {
    const dir = await makeTempDir();
    try {
      await expect(loadManifest(dir)).rejects.toThrow(/No ezcorp\.config\.ts found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws on invalid manifest (missing required fields)", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(
        join(dir, "ezcorp.config.ts"),
        `export default { schemaVersion: 2 };\n`,
      );
      await expect(loadManifest(dir)).rejects.toThrow(/Invalid manifest/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when default export is not an object", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(
        join(dir, "ezcorp.config.ts"),
        `export default "not an object";\n`,
      );
      await expect(loadManifest(dir)).rejects.toThrow(/must have a default export/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("strips function-valued properties from tools", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(
        join(dir, "ezcorp.config.ts"),
        `export default {
          schemaVersion: 2,
          name: "strip-test",
          version: "1.0.0",
          description: "Test",
          author: { name: "Test" },
          entrypoint: "./index.ts",
          permissions: {},
          tools: [{
            name: "my-tool",
            description: "A tool",
            inputSchema: { type: "object", properties: {} },
            handler: () => {},
          }],
        };\n`,
      );
      const manifest = await loadManifest(dir);
      const tool = manifest.tools![0] as unknown as Record<string, unknown>;
      expect(tool.name).toBe("my-tool");
      expect(tool.handler).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadManifestFresh", () => {
  test("loads manifest with cache-busting", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(
        join(dir, "ezcorp.config.ts"),
        `export default ${JSON.stringify(VALID_MANIFEST)};\n`,
      );
      const manifest = await loadManifestFresh(dir);
      expect(manifest.name).toBe("test-ext");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("defineExtension", () => {
  test("is an identity function", () => {
    const config = { ...VALID_MANIFEST };
    const result = defineExtension(config);
    expect(result).toBe(config);
  });

  test("preserves all properties including functions", () => {
    const handler = () => {};
    const config = defineExtension({
      ...VALID_MANIFEST,
      tools: [{
        name: "t",
        description: "d",
        inputSchema: { type: "object" as const, properties: {} },
        handler,
      }],
    });
    expect((config.tools![0] as any).handler).toBe(handler);
  });
});
