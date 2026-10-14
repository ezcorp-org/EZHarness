/**
 * W4H-28 real-4: in the built web server, every pi OAuth credential failed to derive a key. pi-ai loads its OAuth
 * flow modules through a dynamic import relative to its own file, and a bundle has no such file ("Cannot find module
 * './openai-codex.js'"); the factory's readiness then read the connected ChatGPT subscription as not configured.
 * This builds the credential store into one bundle, as the web build does, and derives a key through it.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outdir = await mkdtemp(join(tmpdir(), "credential-store-bundle-"));
afterAll(async () => { await rm(outdir, { recursive: true, force: true }); });

test("a bundled credential store derives a ChatGPT-subscription key from a stored OAuth credential", async () => {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/bundled-oauth-entry.ts")], outdir, target: "bun", splitting: false });
  expect(built.success).toBe(true);
  const { builtinModels } = await import(join(outdir, "bundled-oauth-entry.js"));
  const fixture = { type: "oauth", access: "fixture-access-token", refresh: "fixture-refresh-token", expires: Date.now() + 3_600_000 };
  const store = {
    async read(id: string) { return id === "openai-codex" ? fixture : undefined; },
    async list() { return [{ providerId: "openai-codex", type: "oauth" }]; },
    async modify(id: string, fn: (current: unknown) => Promise<unknown>) { return (await fn(await this.read(id))) ?? fixture; },
  };
  const result = await builtinModels({ credentials: store }).getAuth("openai-codex", { minOAuthValidityMs: 60_000 });
  expect(result?.auth?.apiKey).toBe(fixture.access);
}, 120_000);
