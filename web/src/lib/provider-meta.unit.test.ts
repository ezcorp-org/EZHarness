/**
 * Provider display metadata, and its parity with the backend provider table.
 *
 * `PROVIDER_META` drives the provider cards. Two of its facts are not display
 * choices but MIRRORS of `src/runtime/routing/llm-providers.ts`, and a mirror
 * that drifts is worse than no mirror: a provider marked `keylessFreeTier`
 * here but not there shows "Free tier active" for something that cannot answer.
 *
 * The backend table is PARSED, not imported. A vitest-leg module that imports
 * across the tree poisons the merged lcov for the imported file (root
 * CLAUDE.md); reading the source keeps the assertion honest and the coverage
 * clean.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_META, canonicalProvider } from "./provider-meta";

// Vitest runs with cwd = web/, so the backend tree is one level up. (An
// `import.meta.url` File URL does not survive vitest's transform here.)
const BACKEND_TABLE = readFileSync(
  join(process.cwd(), "..", "src", "runtime", "routing", "llm-providers.ts"),
  "utf8",
);

/** Provider ids the backend table declares, in order. */
function backendProviderIds(): string[] {
  const body = BACKEND_TABLE.split("export const LLM_PROVIDERS")[1] ?? "";
  const table = body.split("];")[0] ?? "";
  return [...table.matchAll(/\bid:\s*(?:"([^"]+)"|KILO_PROVIDER)/g)].map((m) => m[1] ?? "kilo");
}

/** Provider ids the backend table marks `keylessFreeTier: true`. */
function backendKeylessIds(): string[] {
  const body = BACKEND_TABLE.split("export const LLM_PROVIDERS")[1] ?? "";
  const table = body.split("];")[0] ?? "";
  return [...table.matchAll(/\{[^}]*\}/g)]
    .filter((row) => /keylessFreeTier:\s*true/.test(row[0]))
    .map((row) => {
      const named = row[0].match(/\bid:\s*"([^"]+)"/);
      return named ? named[1] : "kilo";
    });
}

describe("PROVIDER_META", () => {
  test("has an entry for every provider the backend can route to", () => {
    for (const id of backendProviderIds()) {
      expect(PROVIDER_META[id], `missing PROVIDER_META entry for "${id}"`).toBeDefined();
      expect(PROVIDER_META[id].name.length).toBeGreaterThan(0);
      expect(PROVIDER_META[id].shortName.length).toBeGreaterThan(0);
    }
  });

  test("the backend table is non-empty and includes kilo (guards the parser itself)", () => {
    // A regex that silently matched nothing would make every assertion above
    // vacuously pass — the classic way a parity test stops testing anything.
    expect(backendProviderIds()).toContain("kilo");
    expect(backendProviderIds().length).toBeGreaterThanOrEqual(5);
  });

  test("keylessFreeTier mirrors the backend table exactly", () => {
    const backend = backendKeylessIds();
    const frontend = Object.entries(PROVIDER_META)
      .filter(([, meta]) => meta.keylessFreeTier)
      .map(([id]) => id);
    expect(backend).toContain("kilo");
    expect(frontend.sort()).toEqual(backend.sort());
  });

  test("a keyless provider explains the free tier on its card", () => {
    for (const [id, meta] of Object.entries(PROVIDER_META)) {
      if (!meta.keylessFreeTier) continue;
      expect(meta.freeTierNote, `"${id}" needs a freeTierNote`).toBeTruthy();
      // The training caveat is the fact a user most needs before sending a
      // prompt to a $0 endpoint; losing it is a silent privacy regression.
      expect(meta.freeTierNote!.toLowerCase()).toContain("log");
    }
  });

  test("providers without a free tier carry no free-tier copy", () => {
    expect(PROVIDER_META.anthropic.keylessFreeTier).toBeUndefined();
    expect(PROVIDER_META.anthropic.freeTierNote).toBeUndefined();
  });
});

describe("canonicalProvider", () => {
  test("resolves aliases and passes everything else through", () => {
    expect(canonicalProvider("claude")).toBe("anthropic");
    expect(canonicalProvider("gemini")).toBe("google");
    expect(canonicalProvider("kilo")).toBe("kilo");
    expect(canonicalProvider("unknown")).toBe("unknown");
  });
});
