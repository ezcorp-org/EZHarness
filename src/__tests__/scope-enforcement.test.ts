import { test, expect, describe } from "bun:test";
import { requireScope } from "../../web/src/lib/server/security/api-keys";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

describe("requireScope", () => {
  test("returns 403 when API key lacks required scope", () => {
    const result = requireScope({ apiKeyScopes: ["read"] }, "chat");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("returns null when API key has required scope", () => {
    const result = requireScope({ apiKeyScopes: ["chat"] }, "chat");
    expect(result).toBeNull();
  });

  test("returns null for admin scope when present", () => {
    const result = requireScope({ apiKeyScopes: ["admin"] }, "admin");
    expect(result).toBeNull();
  });

  test("returns null for cookie auth (no apiKeyScopes)", () => {
    const result = requireScope({}, "chat");
    expect(result).toBeNull();
  });

  test("returns 403 for read-only key on POST messages (chat scope)", () => {
    const result = requireScope({ apiKeyScopes: ["read"] }, "chat");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("returns 403 for chat-only key on settings (admin scope)", () => {
    const result = requireScope({ apiKeyScopes: ["chat"] }, "admin");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });
});

describe("scope enforcement coverage", () => {
  // updated for sec-C1: previously asserted every route contains `requireScope`,
  // but `requireScope` is a no-op for cookie auth — the whole reason we're
  // migrating admin-sensitive routes to `requireRole(locals, "admin")`. Accept
  // either marker so routes can harden without this test blocking them.
  test("all non-auth API routes contain a scope or role gate", async () => {
    const apiDir = join(import.meta.dir, "../../web/src/routes/api");
    const skipDirs = ["auth", "health", "favicon"];

    async function findServerFiles(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skipDirs.includes(entry.name)) continue;
          files.push(...(await findServerFiles(fullPath)));
        } else if (entry.name === "+server.ts") {
          files.push(fullPath);
        }
      }
      return files;
    }

    const serverFiles = await findServerFiles(apiDir);
    expect(serverFiles.length).toBeGreaterThan(25);

    const missing: string[] = [];
    for (const file of serverFiles) {
      const content = await Bun.file(file).text();
      if (!content.includes("requireScope") && !content.includes("requireRole")) {
        const relative = file.replace(apiDir, "");
        missing.push(relative);
      }
    }

    expect(missing).toEqual([]);
  });
});
