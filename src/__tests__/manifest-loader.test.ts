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
  test("rejects a valid config rather than evaluating it on the host", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(
        join(dir, "ezcorp.config.ts"),
        `export default ${JSON.stringify(VALID_MANIFEST)};\n`,
      );
      await expect(loadManifest(dir)).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when ezcorp.config.ts is missing", async () => {
    const dir = await makeTempDir();
    try {
      await expect(loadManifest(dir)).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
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
      await expect(loadManifest(dir)).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
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
      await expect(loadManifest(dir)).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects function-valued tools without importing them", async () => {
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
      await expect(loadManifest(dir)).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadManifestFresh", () => {
  test("cache-busting cannot enable host configuration evaluation", async () => {
    const dir = await makeTempDir();
    try {
      await Bun.write(
        join(dir, "ezcorp.config.ts"),
        `export default ${JSON.stringify(VALID_MANIFEST)};\n`,
      );
      await expect(loadManifestFresh(dir)).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
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
