/**
 * Pins the ONE runtime where `resolveProjectRoot`'s `import.meta.url`
 * branch is load-bearing — and it has to live here, in the vitest/Node
 * leg, because that IS the runtime.
 *
 * `import.meta.dir` is a Bun extension, not standard `import.meta`. Under
 * Bun (every `src/**` bun:test, every host script, the production
 * container) it is always a string, so the primary substring match in step
 * 2 wins and the `import.meta.url` fallback is unreachable — which makes
 * "is this branch dead code we could delete?" a fair question that the
 * backend suite structurally cannot answer.
 *
 * It isn't dead. Under vite/vitest on Node, `import.meta.dir` is
 * `undefined`, so `import.meta.url` is the only signal left and this
 * branch is what still resolves the checkout root. Delete it and the
 * `typeof import.meta.dir === "string"` guard above it silently becomes a
 * no-op that falls through to the `.git` walk-up — fine in a checkout,
 * wrong in any `.git`-less tree (the shipped image is one; see
 * `.dockerignore`).
 *
 * Asserting from the vitest side is also the sanctioned direction for a
 * cross-tree assertion (root CLAUDE.md, "Coverage trap") — this leg
 * resolves both trees.
 */
import { describe, expect, it } from "vitest";
import { resolveProjectRoot } from "$server/extensions/project-root";

describe("project-root under the vitest/Node leg", () => {
  it("does not get Bun's non-standard import.meta.dir", () => {
    // The premise of the whole file. If this ever flips to "string", this
    // leg started running under Bun and the two tests below stop meaning
    // what they say.
    expect(typeof (import.meta as unknown as { dir?: string }).dir).toBe("undefined");
  });

  it("resolves via import.meta.url, not the .git walk-up", () => {
    const { source } = resolveProjectRoot();
    expect(source).toBe("import-meta");
  });

  it("degrades to the .git walk-up when that branch is disabled", () => {
    // Same call with the URL signal suppressed — the exact behaviour
    // deleting the branch would ship. It still finds the root HERE only
    // because a checkout has `.git`; that is the safety margin the branch
    // is buying.
    const { source } = resolveProjectRoot({ importMetaUrl: "" });
    expect(source).toBe("git-walk");
  });
});
