/**
 * Hydration-gate meta-test (issue #145).
 *
 * THE BUG. Every route in this app is server-rendered, so the readiness gate
 * most e2e specs used —
 *
 *     await page.goto(`/project/${id}/chat/${convId}`);
 *     await expect(page.getByText("Send a message to start…")).toBeVisible();
 *     await page.locator("textarea").fill("hello");
 *
 * — is satisfied at FIRST PAINT and proves nothing: that text, the
 * `<textarea>` and the send button are all in the raw HTML before a byte of
 * JavaScript runs (measured: 33 440 bytes on the chat route via `curl`). When
 * the box is starved the `fill()` lands on the pre-hydration node, hydration
 * re-creates the composer with `value = ""`, the typed text is discarded and
 * the send button is PERMANENTLY disabled — the click then burns its whole
 * 30s timeout. Seen for real on PR #141's `Visual evidence` job (run
 * 31139375254).
 *
 * THE FIX, and why it is enforced HERE rather than at the call sites. The
 * audit found 489 such windows across 150 of the 344 specs; hand-writing 489
 * gates would leave the 490th to reintroduce the bug. Instead the app grew a
 * marker only the client can set, and the e2e base wraps `page.goto` with it:
 *
 *   1. `web/src/app.html`            ships `data-hydrated="false"` (SSR).
 *   2. `web/src/routes/+layout.svelte` onMount flips it to `"true"`.
 *   3. `web/e2e/fixtures/hydration.ts` `page.goto` waits for the flip.
 *   4. every spec takes its `test` from that base, so it cannot opt out.
 *
 * This file pins all four links. Break any one and the gate silently stops
 * gating while every spec still passes — which is exactly the failure mode
 * that made #145 invisible for so long.
 *
 * WHY NOT LINT THE ASSERTION SHAPE? The obvious alternative — flag a
 * `toBeVisible()` used as a post-`goto` gate before the first interaction —
 * would fire on all 489 of those windows, every one of which is now correct,
 * because the gate moved into `goto`. A check with a ~100% false-positive
 * rate gets routed around. Link 4 below is the exact, zero-heuristic form of
 * the same guarantee: it constrains the MECHANISM, not the prose.
 *
 * Runs in the P∩C sweep (src/__tests__ → the CI cov-shards gate it).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function read(rel: string): string {
  return require("node:fs").readFileSync(join(REPO_ROOT, rel), "utf8") as string;
}

function specFiles(): string[] {
  const proc = Bun.spawnSync(["bash", "-c", "find web/e2e -name '*.spec.ts' | sort"], {
    cwd: REPO_ROOT,
  });
  if (proc.exitCode !== 0) throw new Error(`find failed: ${proc.stderr.toString()}`);
  return proc.stdout
    .toString()
    .split("\n")
    .filter((l) => l.length > 0);
}

/**
 * The runner names a file imports as VALUES from `@playwright/test`.
 *
 * `import type { Page }` / `{ type Page }` are ignored — a type cannot carry
 * a fixture, so it cannot dodge the gate. `chromium` and friends are ignored
 * too: the global-setup files drive a browser directly and never hand a spec
 * a `page`. What matters is `test` (which carries the fixtures) and `expect`
 * (whose second package copy trips the "did not expect test.describe()"
 * runtime guard — see `fixtures/picker-helpers.ts`).
 */
const RUNNER_NAMES = new Set(["test", "expect"]);

function playwrightValueImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(
    /^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"@playwright\/test";$/gm,
  )) {
    if (m[1]) continue; // `import type { … }`
    const values = m[2]!
      .split(",")
      .map((s) => s.trim())
      .map((s) => s.replace(/^test as base$/, "test"))
      .filter((s) => !s.startsWith("type ") && RUNNER_NAMES.has(s));
    out.push(...values);
  }
  return out;
}

describe("e2e hydration gate", () => {
  test("link 1 — SSR ships the marker as `false` on every document", () => {
    const appHtml = read("web/src/app.html");
    // On the <html> tag specifically: app.html wraps EVERY document the app
    // serves (routes AND the SvelteKit error page), which is what lets
    // `waitForHydration` treat a MISSING marker as "not an app document"
    // instead of "an app page that hasn't hydrated yet".
    expect(appHtml).toMatch(/<html[^>]*\sdata-hydrated="false"/);
    // The server must never emit the hydrated value, or the gate false-passes
    // exactly the way the old `toBeVisible()` gate did.
    expect(appHtml).not.toContain('data-hydrated="true"');
  });

  test("link 2 — the root layout flips it to `true` inside onMount", () => {
    const layout = read("web/src/routes/+layout.svelte");
    const onMountIdx = layout.indexOf("onMount(");
    expect(onMountIdx).toBeGreaterThan(-1);
    const flip = layout.indexOf("setAttribute('data-hydrated', 'true')");
    expect(flip).toBeGreaterThan(-1);
    // Inside onMount, not at module scope — module scope also runs during SSR
    // in SvelteKit, which would make the marker meaningless.
    expect(flip).toBeGreaterThan(onMountIdx);
  });

  test("link 3 — the e2e base gates every `page.goto` on the marker", () => {
    const hydration = read("web/e2e/fixtures/hydration.ts");
    // The probe reads the attribute and only accepts the client's value.
    expect(hydration).toContain('HYDRATION_ATTR = "data-hydrated"');
    expect(hydration).toContain('state === "true"');
    // The `page` fixture must wrap goto — not merely export a helper specs
    // may forget to call.
    expect(hydration).toMatch(/page:\s*async\s*\(\s*\{\s*page\s*\}/);
    expect(hydration).toMatch(/page\.goto\s*=/);
    expect(hydration).toContain("await waitForHydration(page)");

    // And the mock tier inherits it rather than re-deriving from Playwright.
    const testBase = read("web/e2e/fixtures/test-base.ts");
    expect(testBase).toContain('import { test as base } from "./hydration.js"');
    expect(playwrightValueImports(testBase)).toEqual([]);
  });

  test("link 4 — no spec takes `test`/`expect` straight from @playwright/test", () => {
    // A spec that imports the raw Playwright `test` gets a raw `page`, whose
    // `goto` is NOT gated — the one way to reintroduce #145. Types are fine.
    const offenders: string[] = [];
    for (const f of specFiles()) {
      const values = playwrightValueImports(read(f));
      if (values.length > 0) offenders.push(`${f} → { ${values.join(", ")} }`);
    }
    expect(
      offenders,
      "spec(s) bypassing the hydration-gated base — import { test, expect } from " +
        "the fixtures instead (`fixtures/test-base.js` for the mock tier, " +
        "`fixtures/hydration.js` for real-auth/docker specs, which must not pull " +
        `in the fetch mocks):\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  test("link 4b — fixtures/hydration.ts is the ONLY module that may value-import @playwright/test", () => {
    const proc = Bun.spawnSync(["bash", "-c", "find web/e2e -name '*.ts' | sort"], {
      cwd: REPO_ROOT,
    });
    if (proc.exitCode !== 0) throw new Error(`find failed: ${proc.stderr.toString()}`);
    const all = proc.stdout
      .toString()
      .split("\n")
      .filter((l) => l.length > 0);
    // One root for the whole fixture tree. A helper that re-derives `test`
    // from `@playwright/test` could hand specs an ungated `page` again, and a
    // helper that imports a bare `expect` resolves a SECOND copy of the
    // package — the exact hazard `fixtures/composer.ts` documents.
    const owners = all.filter((f) => playwrightValueImports(read(f)).length > 0);
    expect(owners).toEqual(["web/e2e/fixtures/hydration.ts"]);
  });

  test("the marker is exercised by a real spec, not just asserted about", () => {
    const spec = read("web/e2e/hydration-marker.spec.ts");
    expect(spec).toContain('data-hydrated="false"'); // SSR side, over raw HTTP
    expect(spec).toContain('toHaveAttribute("data-hydrated", "true")'); // client side
    expect(spec).toContain("@evidence");
  });
});
