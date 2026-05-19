// Tests for lib/lint.ts — body-markup CSS-variable enforcement.
//
// Locks down the three rule families:
//   1. Inline-style hex literals on color-bearing properties.
//   2. Inline-style hardcoded px on layout properties.
//   3. Tailwind arbitrary-color classes.
//
// Allowed token forms (var(--…), calc(…), `0`, viewport units) MUST NOT
// trip a violation. Reports a 1-based line number for each violation
// and truncates offending substrings to 80 characters.

import { describe, expect, test } from "bun:test";
import { lintBodyMarkup } from "./lint";

// ── Rule 1: inline-style hex literals ──────────────────────────────

describe("lintBodyMarkup — inline-style hex literals", () => {
  test("rejects style with hex color literal, includes offending substring", () => {
    const body = `<div style="color: #ff0066">Hello</div>`;
    const result = lintBodyMarkup(body);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBe(1);
    const v = result.violations[0]!;
    expect(v.rule).toBe("inline-hex");
    expect(v.message).toContain("#ff0066");
    expect(v.message).toContain("color");
  });

  test("allows style using var(--color-primary)", () => {
    const body = `<div style="color: var(--color-primary)">Hello</div>`;
    const result = lintBodyMarkup(body);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("allows style using var() with fallback hex", () => {
    const body = `<div style="color: var(--color-bg, #fff)">Hello</div>`;
    const result = lintBodyMarkup(body);
    expect(result.ok).toBe(true);
  });

  test("allows style using calc(var(...))", () => {
    const body = `<div style="color: calc(var(--space-unit) * 2)">x</div>`;
    const result = lintBodyMarkup(body);
    expect(result.ok).toBe(true);
  });
});

// ── Rule 2: inline-style hardcoded px on layout properties ────────

describe("lintBodyMarkup — inline-style hardcoded px", () => {
  test("rejects padding: 16px", () => {
    const body = `<div style="padding: 16px">x</div>`;
    const result = lintBodyMarkup(body);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0]!.rule).toBe("inline-px");
    expect(result.violations[0]!.message).toContain("padding");
    expect(result.violations[0]!.message).toContain("16px");
  });

  test("rejects margin: 32px", () => {
    const body = `<div style="margin: 32px">x</div>`;
    const result = lintBodyMarkup(body);
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.rule).toBe("inline-px");
    expect(result.violations[0]!.message).toContain("margin");
    expect(result.violations[0]!.message).toContain("32px");
  });

  test("allows padding: 0", () => {
    const result = lintBodyMarkup(`<div style="padding: 0">x</div>`);
    expect(result.ok).toBe(true);
  });

  test("allows width: 100% and height: 100vh", () => {
    const result1 = lintBodyMarkup(`<div style="width: 100%">x</div>`);
    expect(result1.ok).toBe(true);
    const result2 = lintBodyMarkup(`<div style="height: 100vh">x</div>`);
    expect(result2.ok).toBe(true);
  });

  test("allows padding: var(--space-2)", () => {
    const result = lintBodyMarkup(`<div style="padding: var(--space-2)">x</div>`);
    expect(result.ok).toBe(true);
  });

  test("allows padding: calc(var(--space-unit) * 4)", () => {
    const result = lintBodyMarkup(
      `<div style="padding: calc(var(--space-unit) * 4)">x</div>`,
    );
    expect(result.ok).toBe(true);
  });
});

// ── Rule 3: Tailwind arbitrary-color classes ──────────────────────

describe("lintBodyMarkup — Tailwind arbitrary-color classes", () => {
  test("rejects bg-[#ff0066]", () => {
    const body = `<div class="bg-[#ff0066]">x</div>`;
    const result = lintBodyMarkup(body);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0]!.rule).toBe("tailwind-arbitrary-color");
    expect(result.violations[0]!.message).toContain("#ff0066");
  });

  test("rejects text-[#abc]", () => {
    const body = `<span class="text-[#abc]">x</span>`;
    const result = lintBodyMarkup(body);
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.rule).toBe("tailwind-arbitrary-color");
  });

  test("rejects border-[#fff000]", () => {
    const body = `<div class="border-[#fff000]">x</div>`;
    const result = lintBodyMarkup(body);
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.rule).toBe("tailwind-arbitrary-color");
  });

  test("rejects bg-blue-500 (named color utility — D1 strict-mode)", () => {
    // Pre-D1 this was allowed; post-D1 the strict-token-only lint rejects
    // named Tailwind color utilities so every styling decision goes through
    // a CSS variable that knob tweaks can rewrite.
    const body = `<div class="bg-blue-500">x</div>`;
    const result = lintBodyMarkup(body);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.rule === "tailwind-color-utility")).toBe(true);
  });

  test("allows bg-[var(--color-primary)] (var-based arbitrary)", () => {
    const body = `<div class="bg-[var(--color-primary)]">x</div>`;
    const result = lintBodyMarkup(body);
    expect(result.ok).toBe(true);
  });
});

// ── Clean markup ──────────────────────────────────────────────────

describe("lintBodyMarkup — clean markup", () => {
  test("returns ok:true with empty violations on clean markup", () => {
    // Clean markup uses var(--…) for all visual tokens, layout utilities
    // for structure, and arbitrary forms with var() for color/sizing.
    const body = `<main class="flex items-center justify-between" style="color: var(--color-fg); padding: var(--space-4)">
  <h1 class="bg-[var(--color-primary)] text-[var(--color-fg)]">Hello</h1>
  <p style="margin: 0; line-height: 1.5">Body text.</p>
</main>`;
    const result = lintBodyMarkup(body);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

// ── Line numbering ────────────────────────────────────────────────

describe("lintBodyMarkup — line numbers", () => {
  test("reports 1-based line numbers for each violation", () => {
    const body = [
      `<main>`, // line 1
      `  <h1>Title</h1>`, // line 2
      `  <div style="color: #ff0066">x</div>`, // line 3
      `  <p>good</p>`, // line 4
      `  <span class="bg-[#abc]">y</span>`, // line 5
      `</main>`, // line 6
    ].join("\n");
    const result = lintBodyMarkup(body);
    expect(result.ok).toBe(false);
    const lines = result.violations.map((v) => v.line).sort((a, b) => a - b);
    expect(lines).toContain(3);
    expect(lines).toContain(5);
    // Every violation has a positive line number.
    for (const v of result.violations) {
      expect(v.line).toBeGreaterThanOrEqual(1);
    }
  });
});

// ── Snippet truncation ────────────────────────────────────────────

describe("lintBodyMarkup — snippet truncation", () => {
  test("truncates offending substring to 80 chars when longer", () => {
    // Build a Tailwind class with lots of padding around the arbitrary
    // color so the matched substring exceeds 80 chars.
    const longClass =
      "some-prefix-class another-class third-class fourth-class fifth-class bg-[#ff0066]";
    const body = `<div class="${longClass}">x</div>`;
    const result = lintBodyMarkup(body);
    expect(result.ok).toBe(false);
    // The message contains the matched class string truncated to ≤80
    // chars (with `...` suffix when truncated).
    const v = result.violations[0]!;
    // Extract the truncated snippet portion (everything after `: `).
    const colonIdx = v.message.indexOf(": ");
    const snippet = colonIdx >= 0 ? v.message.slice(colonIdx + 2) : v.message;
    expect(snippet.length).toBeLessThanOrEqual(80);
    if (snippet.length === 80) {
      expect(snippet.endsWith("...")).toBe(true);
    }
  });
});

// ── D1: hardcoded Tailwind utility lint ─────────────────────────────
//
// The earlier rules only catch literal hex (`style="color:#…"`) and
// arbitrary-color brackets (`bg-[#…]`). D1 closes the larger gap:
// named Tailwind utilities like `bg-blue-500`, `p-4`, `text-3xl`,
// `rounded-lg` bake values from Tailwind's theme — they don't reference
// the design-system CSS variables, so subsequent knob tweaks have no
// surface to act on. These rules force the agent to use `var(--…)`
// arbitraries instead.

describe("lintBodyMarkup D1 — hardcoded Tailwind color utilities", () => {
  test("rejects bg-blue-500", () => {
    const r = lintBodyMarkup(`<div class="bg-blue-500">x</div>`);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.rule === "tailwind-color-utility")).toBe(true);
  });
  test("rejects text-red-700, border-gray-300, ring-purple-500", () => {
    const r = lintBodyMarkup(
      `<div class="text-red-700 border-gray-300 ring-purple-500">x</div>`,
    );
    const colorRules = r.violations.filter((v) => v.rule === "tailwind-color-utility");
    expect(colorRules.length).toBe(3);
  });
  test("allows bg-[var(--color-primary)]", () => {
    const r = lintBodyMarkup(`<div class="bg-[var(--color-primary)]">x</div>`);
    expect(r.violations.some((v) => v.rule === "tailwind-color-utility")).toBe(false);
  });
  test("strips variant prefixes (hover:bg-blue-500 still flagged)", () => {
    const r = lintBodyMarkup(`<div class="hover:bg-blue-500 md:dark:text-red-700">x</div>`);
    expect(r.violations.filter((v) => v.rule === "tailwind-color-utility").length).toBe(2);
  });
});

describe("lintBodyMarkup D1 — hardcoded Tailwind spacing utilities", () => {
  test("rejects p-4, mx-2, gap-8", () => {
    const r = lintBodyMarkup(`<div class="p-4 mx-2 gap-8">x</div>`);
    expect(r.violations.filter((v) => v.rule === "tailwind-spacing-utility").length).toBe(3);
  });
  test("allows p-[calc(var(--space-unit)*4)]", () => {
    const r = lintBodyMarkup(`<div class="p-[calc(var(--space-unit)*4)]">x</div>`);
    expect(r.violations.some((v) => v.rule === "tailwind-spacing-utility")).toBe(false);
  });
  test("allows space-y-[var(--space-2)]", () => {
    const r = lintBodyMarkup(`<div class="gap-[var(--space-2)]">x</div>`);
    expect(r.violations.some((v) => v.rule === "tailwind-spacing-utility")).toBe(false);
  });
});

describe("lintBodyMarkup D1 — hardcoded Tailwind sizing utilities", () => {
  test("rejects w-64, h-32 (numeric sizes)", () => {
    const r = lintBodyMarkup(`<div class="w-64 h-32">x</div>`);
    expect(r.violations.filter((v) => v.rule === "tailwind-sizing-utility").length).toBe(2);
  });
  test("allows w-full, h-screen, min-h-screen, w-fit, w-auto", () => {
    const r = lintBodyMarkup(
      `<div class="w-full h-screen min-h-screen w-fit w-auto">x</div>`,
    );
    expect(r.violations.some((v) => v.rule === "tailwind-sizing-utility")).toBe(false);
  });
});

describe("lintBodyMarkup D1 — hardcoded Tailwind typography + radius utilities", () => {
  test("rejects text-3xl, text-base, text-9xl", () => {
    const r = lintBodyMarkup(`<div class="text-3xl"><h2 class="text-base">a</h2><p class="text-9xl">b</p></div>`);
    expect(r.violations.filter((v) => v.rule === "tailwind-typography-utility").length).toBe(3);
  });
  test("allows text-[var(--font-size-3)]", () => {
    const r = lintBodyMarkup(`<div class="text-[var(--font-size-3)]">x</div>`);
    expect(r.violations.some((v) => v.rule === "tailwind-typography-utility")).toBe(false);
  });
  test("rejects rounded-lg, rounded-2xl, rounded-t-md", () => {
    const r = lintBodyMarkup(
      `<div class="rounded-lg"><a class="rounded-2xl"><span class="rounded-t-md">x</span></a></div>`,
    );
    expect(r.violations.filter((v) => v.rule === "tailwind-radius-utility").length).toBe(3);
  });
  test("allows rounded-[var(--radius-base)]", () => {
    const r = lintBodyMarkup(`<div class="rounded-[var(--radius-base)]">x</div>`);
    expect(r.violations.some((v) => v.rule === "tailwind-radius-utility")).toBe(false);
  });
});

describe("lintBodyMarkup D1 — allowlist + integration", () => {
  test("allows pure layout utilities (flex, grid, items-center, gap)", () => {
    const r = lintBodyMarkup(
      `<div class="flex items-center justify-between grid grid-cols-3 col-span-2 z-10 relative absolute hidden">x</div>`,
    );
    expect(r.ok).toBe(true);
    expect(r.violations.length).toBe(0);
  });
  test("flags bad utilities even when mixed with good ones (no double-flagging)", () => {
    const r = lintBodyMarkup(`<div class="flex items-center bg-blue-500 rounded-lg p-4">x</div>`);
    // Three D1 violations: color, radius, spacing. flex/items-center pass.
    expect(r.violations.length).toBe(3);
  });
  test("reports line numbers", () => {
    const body = `<div>line 1</div>\n<div>line 2</div>\n<div class="bg-red-500">line 3</div>`;
    const r = lintBodyMarkup(body);
    expect(r.violations[0]!.line).toBe(3);
  });
});
