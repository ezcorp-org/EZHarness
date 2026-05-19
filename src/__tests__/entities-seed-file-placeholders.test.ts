// ── Phase 6 — seed {file:...} placeholder resolution ───────────
//
// Drives `runEntitySeed` against an extension whose seed records use
// `{file:./prompts/weekly.md}` syntax. The renderer reads the files
// off disk (real fs, real tmp dir) and the resolver substitutes them
// before validation + write. Failure paths exercised: missing file,
// absolute path, parent-dir escape, embedded (mid-string) placeholder
// must be left untouched (matching the substack-pilot pre-port
// contract).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeTestDb,
  getTestDb,
  mockDbConnection,
  setupTestDb,
} from "./helpers/test-pglite";

mockDbConnection();

import { extensions, extensionStorage, users } from "../db/schema";
import {
  FilePlaceholderError,
  resolveFilePlaceholders,
  runEntitySeed,
} from "../extensions/entities/seed";
import type { EntityDeclaration } from "@ezcorp/sdk/entities";

let extId: string;
let userId: string;
let sourceDir: string;

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(extensions);
  await db.delete(users);
  const [u] = await db
    .insert(users)
    .values({
      email: "ph@example.com",
      passwordHash: "x",
      name: "X",
      role: "member",
    })
    .returning();
  userId = u!.id;

  sourceDir = mkdtempSync(join(tmpdir(), "entities-seed-"));
  mkdirSync(join(sourceDir, "prompts"));
  writeFileSync(
    join(sourceDir, "prompts", "weekly.md"),
    "You are the weekly roundup writer.",
    "utf-8",
  );
  writeFileSync(
    join(sourceDir, "prompts", "monthly.md"),
    "You are the monthly digest writer.",
    "utf-8",
  );

  const [e] = await db
    .insert(extensions)
    .values({
      name: "test-ext",
      version: "1.0.0",
      description: "test",
      manifest: { schemaVersion: 2, name: "test-ext" } as never,
      source: "local:/tmp",
      installPath: sourceDir,
      enabled: true,
      grantedPermissions: { grantedAt: {} } as never,
      checksumVerified: false,
      consecutiveFailures: 0,
    })
    .returning();
  extId = e!.id;
});

const DECL: EntityDeclaration = {
  type: "post-type",
  label: "Post Type",
  pluralLabel: "Post Types",
  scope: "user",
  schema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      systemPrompt: { type: "string", minLength: 1 },
    },
    required: ["name", "systemPrompt"],
    additionalProperties: false,
  },
};

describe("resolveFilePlaceholders — pure helper", () => {
  test("substitutes a top-level {file:...} placeholder", () => {
    const dir = mkdtempSync(join(tmpdir(), "ph-pure-"));
    try {
      writeFileSync(join(dir, "x.md"), "hello world", "utf-8");
      const out = resolveFilePlaceholders(
        { systemPrompt: "{file:./x.md}", name: "X" },
        dir,
      );
      expect(out).toEqual({ systemPrompt: "hello world", name: "X" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("walks nested objects + arrays", () => {
    const dir = mkdtempSync(join(tmpdir(), "ph-nest-"));
    try {
      writeFileSync(join(dir, "a.md"), "AAA", "utf-8");
      writeFileSync(join(dir, "b.md"), "BBB", "utf-8");
      const out = resolveFilePlaceholders(
        {
          defaults: { titlePrefix: "{file:./a.md}" },
          tags: ["literal", "{file:./b.md}"],
        },
        dir,
      );
      expect(out).toEqual({
        defaults: { titlePrefix: "AAA" },
        tags: ["literal", "BBB"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves embedded mid-string placeholders untouched", () => {
    // Only literal `^{file:...}$` matches. Embedded forms are left as
    // raw text — matches substack-pilot's pre-port behavior.
    const dir = mkdtempSync(join(tmpdir(), "ph-embed-"));
    try {
      writeFileSync(join(dir, "x.md"), "X", "utf-8");
      const out = resolveFilePlaceholders(
        { x: "Hello {file:./x.md} world" },
        dir,
      );
      expect(out).toEqual({ x: "Hello {file:./x.md} world" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws FilePlaceholderError for missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ph-miss-"));
    try {
      expect(() =>
        resolveFilePlaceholders({ x: "{file:./missing.md}" }, dir),
      ).toThrow(FilePlaceholderError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws for absolute path placeholder", () => {
    const dir = mkdtempSync(join(tmpdir(), "ph-abs-"));
    try {
      expect(() =>
        resolveFilePlaceholders({ x: "{file:/etc/passwd}" }, dir),
      ).toThrow(/Absolute paths/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws for parent-dir escape", () => {
    const dir = mkdtempSync(join(tmpdir(), "ph-escape-"));
    try {
      writeFileSync(join(dir, "..", "escape.md"), "X", "utf-8");
      expect(() =>
        resolveFilePlaceholders({ x: "{file:../escape.md}" }, dir),
      ).toThrow(/escapes source dir/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      try {
        rmSync(join(tmpdir(), "escape.md"));
      } catch {
        /* ignore */
      }
    }
  });

  test("throws for symlink escape (symlink inside sourceDir → outside file)", () => {
    // Path-traversal clamp is realpath-based: a symlink inside the
    // source dir that points at /etc/passwd (or any host file)
    // resolves outside the source's realpath and gets rejected. The
    // lexical clamp passes (symlink IS lexically inside the source)
    // but the realpath check trips.
    const sourceDir = mkdtempSync(join(tmpdir(), "ph-symlink-src-"));
    const escapeFile = join(tmpdir(), `ph-symlink-secret-${Date.now()}.txt`);
    try {
      writeFileSync(escapeFile, "SECRET", "utf-8");
      // Create a symlink INSIDE sourceDir pointing at the outside file.
      symlinkSync(escapeFile, join(sourceDir, "escape.md"));
      expect(() =>
        resolveFilePlaceholders({ x: "{file:./escape.md}" }, sourceDir),
      ).toThrow(/symlink/i);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
      try {
        rmSync(escapeFile);
      } catch {
        /* ignore */
      }
    }
  });
});

describe("runEntitySeed — file placeholders integrated", () => {
  test("resolves placeholders during seed insert", async () => {
    const result = await runEntitySeed({
      extensionId: extId,
      entities: [
        {
          ...DECL,
          seed: [
            {
              slug: "weekly",
              data: {
                name: "Weekly",
                systemPrompt: "{file:./prompts/weekly.md}",
              },
            },
          ],
        },
      ],
      sourceDir,
      userId,
    });
    expect(result.seededByType["post-type"]).toEqual(["weekly"]);

    const db = getTestDb();
    const rows = await db
      .select()
      .from(extensionStorage)
      .where(
        // We just want all rows for this extension; filter in JS.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        undefined as any,
      );
    const recRow = rows.find(
      (r) =>
        r.extensionId === extId && r.key === "__entity:post-type:weekly",
    );
    expect(recRow?.value).toEqual({
      name: "Weekly",
      systemPrompt: "You are the weekly roundup writer.",
    });
  });

  test("skips a seed record on missing-file (soft-fail), continues with the rest", async () => {
    const result = await runEntitySeed({
      extensionId: extId,
      entities: [
        {
          ...DECL,
          seed: [
            {
              slug: "weekly",
              data: {
                name: "Weekly",
                systemPrompt: "{file:./prompts/weekly.md}",
              },
            },
            {
              slug: "missing",
              data: {
                name: "Missing",
                systemPrompt: "{file:./prompts/nope.md}",
              },
            },
          ],
        },
      ],
      sourceDir,
      userId,
    });
    expect(result.seededByType["post-type"]).toEqual(["weekly"]);
    expect(result.skippedByType["post-type"]).toEqual(["missing"]);
  });
});
