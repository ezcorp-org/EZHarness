import { readFileSync } from "node:fs";
import { defineExtension } from "../../../../src/extensions/sdk/define";

// Load the bundled skill knowledge files at module init so the
// content can be inlined into the agent prompt. Wrap each read in a
// try/catch so a missing file degrades to an empty section rather
// than failing the manifest load (which would prevent the bundled-
// installer from running at boot).
function loadSkill(filename: string): string {
  try {
    return readFileSync(
      new URL(`./knowledge/${filename}`, import.meta.url),
      "utf-8",
    );
  } catch {
    return "";
  }
}

const aestheticPhilosophy = loadSkill("design-aesthetic-philosophy.md");
const systemGuide = loadSkill("design-system-guide.md");

export default defineExtension({
  schemaVersion: 2,
  name: "claude-design",
  version: "0.1.0",
  description:
    "Visual design collaboration — extract a project-specific design system " +
    "from your codebase, generate HTML drafts honoring it, refine via " +
    "knob-based tweaks, and package a Claude-Code-ready handoff bundle. " +
    "First consumer of the @ezcorp/sdk canvas primitives.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  persistent: true,
  category: "Design",
  tags: ["design", "prototyping", "design-system", "demo"],

  tools: [
    {
      name: "extract-design-system",
      description:
        "Walk the project codebase and synthesize a design system: brand colors, " +
        "typography scale, spacing scale, component catalog. Reads tailwind.config.{ts,js}, " +
        ":root CSS variables, tokens.json, and theme.ts in priority order. Persists to " +
        "projects/<slug>/design-system.json. Idempotent — safe to call repeatedly.",
      inputSchema: {
        type: "object",
        properties: {
          projectSlug: {
            type: "string",
            description: "Optional project slug. Defaults to basename(projectRoot).",
          },
          force: {
            type: "boolean",
            description: "Re-scan even if a cached design-system.json exists.",
          },
        },
      },
    },
    {
      name: "clarify-brief",
      description:
        "Open a form card collecting structured design-brief answers from the user. " +
        "Use BEFORE generate-design when the prompt is missing tone/audience/sections/brand/" +
        "references/output mode. Skip when the prompt already covers them. Renders inline " +
        "in the assistant message — text fields become textareas, select fields become " +
        "single-select dropdowns, multi-select fields become checkbox groups.",
      inputSchema: {
        type: "object",
        properties: {
          intro: {
            type: "string",
            description: "Optional one-line preface above the form.",
          },
          fields: {
            type: "array",
            description: "Ordered list of fields the form should collect.",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                label: { type: "string" },
                kind: {
                  type: "string",
                  enum: ["text", "select", "multi-select"],
                },
                options: {
                  type: "array",
                  items: { type: "string" },
                  description: "Required for kind=select / multi-select.",
                },
                placeholder: { type: "string" },
                required: { type: "boolean" },
              },
              required: ["key", "label", "kind"],
            },
          },
        },
        required: ["fields"],
      },
      cardType: "design-brief",
    },
    {
      name: "generate-design",
      description:
        "Generate an HTML draft. The tool wraps your `bodyMarkup` with a head section " +
        "containing a <style id=\"design-tokens\"> block (CSS variables for every project " +
        "token) and a Tailwind CDN link. You author the body markup; the tool is the " +
        "scaffolder, not a model caller. Body MUST reference design tokens via " +
        "`var(--color-*)` and `calc(var(--space-unit) * N)` — that's what makes " +
        "subsequent knob tweaks (color/spacing/typography) a one-line CSS-var rewrite. " +
        "Optionally pass `knobs` (descriptor array) and `knobsTitle` so the canvas " +
        "sidebar renders inputs that match the variables you actually used. " +
        "Returns the draft id and path.",
      inputSchema: {
        type: "object",
        properties: {
          projectSlug: { type: "string", description: "Project slug; defaults to active project." },
          prompt: { type: "string", description: "Free-text design brief — recorded in the draft's meta and as an HTML comment in the scaffold." },
          kind: {
            type: "string",
            format: "combo-box",
            description: "What to generate.",
            "x-options": {
              options: ["page", "slide", "one-pager", "component"],
              allowCustom: false,
            },
          },
          bodyMarkup: {
            type: "string",
            description:
              "Body markup for the draft. This is everything that goes inside <body>...</body> — " +
              "you may use Tailwind utility classes (the CDN is included) and inline styles, but " +
              "all colors/spacing/typography MUST go through the design tokens (var(--color-primary), " +
              "calc(var(--space-unit) * 4), var(--font-display), etc.). Tokens NOT referenced through " +
              "var() will not respond to tweak-design. When omitted, a labeled placeholder is rendered.",
          },
          parentDraftId: {
            type: "string",
            description: "If iterating on a prior draft, pass its id to fork from it.",
          },
          knobs: {
            type: "array",
            description:
              "Optional descriptor array driving the canvas sidebar. Each descriptor declares " +
              "ONE knob: key (logical id), label, kind (color|range|select|text), var (CSS variable " +
              "rewritten on change; auto-derived from kebab(key) when absent), and optional " +
              "options (for select), min/max/step/unit (for range), behavior=\"scale-spacing\", " +
              "current (initial value).",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                label: { type: "string" },
                kind: {
                  type: "string",
                  enum: ["color", "range", "select", "text"],
                },
                var: { type: "string" },
                behavior: { type: "string", enum: ["scale-spacing"] },
                options: { type: "array", items: { type: "string" } },
                min: { type: "number" },
                max: { type: "number" },
                step: { type: "number" },
                unit: { type: "string", enum: ["px", "rem", "em", "%", ""] },
                current: { type: "string" },
              },
              required: ["key", "label", "kind"],
            },
          },
          knobsTitle: {
            type: "string",
            description: "Sidebar header text (e.g. 'Hero & feature grid knobs').",
          },
          skipBriefReason: {
            type: "string",
            description:
              "OPTIONAL — only set when you skipped clarify-brief. One sentence quoting which signals " +
              "from the user's prompt let you skip (tone, audience, sections, brand colors). " +
              "If the prompt is too vague to honor without made-up answers AND you didn't call " +
              "clarify-brief AND you don't supply this reason, generate-design returns a toolError.",
          },
        },
        required: ["prompt", "kind", "bodyMarkup"],
      },
    },
    {
      name: "tweak-design",
      description:
        "Apply structured 'knob' adjustments to a draft's design tokens. Mutates only the " +
        "<style id=\"design-tokens\"> CSS variables — body markup is untouched. Each call " +
        "writes a new revision under drafts/<id>__rN.html and appends to the knob trail " +
        "metadata. Reversible: pass parent revision id to revert.",
      inputSchema: {
        type: "object",
        properties: {
          draftId: { type: "string", description: "Existing draft id." },
          knobs: {
            type: "object",
            description:
              "Knob values keyed by descriptor `key`. For legacy drafts (no descriptors), " +
              "supported keys: primaryColor, secondaryColor, spacingScale, borderRadius, density.",
          },
        },
        required: ["draftId", "knobs"],
      },
    },
    {
      name: "package-handoff",
      description:
        "Bundle a draft as a Claude-Code-readable handoff package. Output: a folder " +
        "under handoffs/<slug>-<timestamp>/ containing IMPLEMENT.md, design.html, " +
        "tokens.css, design-system.json, knob-trail.json, and a starter component for " +
        "the requested target framework.",
      inputSchema: {
        type: "object",
        properties: {
          draftId: { type: "string" },
          targetFramework: {
            type: "string",
            format: "combo-box",
            "x-options": {
              options: ["react", "svelte", "vue", "html"],
              allowCustom: false,
            },
          },
        },
        required: ["draftId"],
      },
    },
    {
      name: "list-drafts",
      description: "List all drafts in a project, ordered by most recent.",
      inputSchema: {
        type: "object",
        properties: {
          projectSlug: { type: "string" },
        },
      },
    },
    {
      name: "list-revisions",
      description:
        "List revisions of a draft, newest first. Each revision carries the knobValues " +
        "that produced it. Useful for showing the user a history and for revert: pass a " +
        "revision's knobValues back through tweak-design to recreate that state.",
      inputSchema: {
        type: "object",
        properties: { draftId: { type: "string" } },
        required: ["draftId"],
      },
    },
    {
      name: "get-draft",
      description: "Read a specific draft's HTML and metadata.",
      inputSchema: {
        type: "object",
        properties: {
          draftId: { type: "string" },
          maxChars: { type: "number", description: "Truncate the html field at this length." },
        },
        required: ["draftId"],
      },
    },
    {
      name: "open-canvas",
      description:
        "Open the canvas card for a draft. The card renders the draft in a sandboxed " +
        "iframe with knob inputs along the edge — descriptors come from the draft's meta " +
        "(falling back to the legacy 5-knob set for older drafts). Knob changes round-" +
        "trip back to tweak-design via the canvas event subscription.",
      inputSchema: {
        type: "object",
        properties: {
          draftId: { type: "string" },
        },
        required: ["draftId"],
      },
      cardType: "design-canvas",
      cardLayout: "dock",
    },
  ],

  skills: [
    {
      name: "design-system-guide",
      description:
        "How claude-design extracts a design system from a project's codebase, and how the " +
        "generator and tweaks conform to it.",
      files: ["./knowledge/design-system-guide.md"],
    },
    {
      name: "design-aesthetic-philosophy",
      description:
        "Bold-aesthetic commitment rules for greenfield drafts; design-system-conformance " +
        "rules when tokens exist. Adapted from Anthropic's frontend-design SKILL.md.",
      files: ["./knowledge/design-aesthetic-philosophy.md"],
    },
    {
      name: "handoff-format-spec",
      description:
        "Layout of the package-handoff bundle so Claude Code can implement the design " +
        "in the target framework.",
      files: ["./knowledge/handoff-format-spec.md"],
    },
  ],

  agent: {
    prompt: [
      "You are Claude Design — a visual collaboration assistant for designs, prototypes, slides, and one-pagers.",
      "",
      "## Workflow",
      "",
      "1. Before any generation, call `extract-design-system` (idempotent). Read the result.",
      "2. **DEFAULT TO ASKING.** Call `clarify-brief` BEFORE `generate-design` unless",
      "   ALL FOUR of the following are explicitly present in the user's prompt:",
      "     (a) a tone keyword (e.g. modern, brutalist, playful, editorial, retro-futuristic, refined-minimal, maximalist),",
      "     (b) an audience signal (e.g. developers, executives, designers, end-consumers, or a specific persona),",
      "     (c) at least ONE section the page must contain (hero, features, pricing, testimonials, CTA, FAQ, gallery, contact, etc.),",
      "     (d) brand colors as hex codes OR a named palette OR an explicit \"surprise me\" delegation.",
      "   If even ONE of (a)-(d) is absent, you MUST call `clarify-brief`. Do NOT",
      "   substitute your own assumptions for the user's preferences — \"answering",
      "   yourself\" instead of asking is a failure mode, not a shortcut.",
      "",
      "   When you DO skip clarify-brief, START your assistant message with one",
      "   sentence quoting which signals you found in the prompt — e.g.",
      "   \"Skipping clarify-brief: prompt specifies brutalist tone, developer audience,",
      "    hero+features+CTA sections, and electric-blue (#0066ff).\" If you can't",
      "   write that sentence honestly, you can't skip — call clarify-brief.",
      "",
      "   Question set when calling clarify-brief:",
      "     - tone (kind: select; options: modern, playful, corporate, brutalist, editorial, retro-futuristic, refined-minimal, maximalist)",
      "     - audience (kind: select; options: developers, executives, designers, general-consumers)",
      "     - sections (kind: multi-select; options: hero, features, pricing, testimonials, CTA, footer, FAQ, about, gallery, contact)",
      "     - brand colors (kind: text; placeholder: hex codes or palette names)",
      "     - references (kind: text; placeholder: URLs or product names)",
      "     - output mode (kind: select; options: one-pager, multi-section, slide)",
      "3. Call `generate-design` with `prompt`, `kind`, `bodyMarkup`, AND `knobs`",
      "   (descriptor array matching the `var(--…)` references in your body) AND",
      "   `knobsTitle` (one-line description of the design — e.g. 'Hero & feature",
      "   grid knobs'). YOU author the body markup; the tool only wraps it with the",
      "   <head>, design-tokens <style> block, and Tailwind CDN.",
      "4. **Lint rules** (every value MUST satisfy these — `generate-design` rejects",
      "   markup that doesn't):",
      "   - Every color through `var(--color-*)` (inline style or `bg-[var(--…)]`",
      "     arbitrary). NO `style=\"color: #…\"`, NO `class=\"bg-[#…]\"`, NO named",
      "     Tailwind color utilities like `bg-blue-500` / `text-red-700` /",
      "     `border-gray-300` / `ring-purple-500`. Named utilities bake values from",
      "     Tailwind's theme; subsequent knob tweaks have no surface to act on.",
      "   - Every dimension through `var(--space-*)` / `calc(var(--space-unit) * N)`",
      "     (inline style) or `p-[calc(var(--space-unit)*4)]` (Tailwind arbitrary).",
      "     NO inline `padding: 16px`, `gap: 12px`. NO numeric Tailwind utilities",
      "     like `p-4`, `mx-2`, `gap-8`, `w-64`, `h-32`. (`0`, `100%`, `100vh`,",
      "     `w-full`, `h-screen`, `min-h-screen`, `w-fit`, `w-auto` are fine.)",
      "   - Every font-size through `var(--font-size-N)` or `text-[var(--…)]`. NO",
      "     `text-3xl` / `text-base` / etc.",
      "   - Every radius through `var(--radius-*)` or `rounded-[var(--…)]`. NO",
      "     `rounded-lg` / `rounded-2xl` / etc.",
      "   - Layout-only Tailwind utilities (flex, grid, items-*, justify-*, gap-[…],",
      "     z-*, overflow-*, transition-*, prose) DO NOT bake values and are fine.",
      "   Zero hardcoded values. If lint fails you'll receive a `toolError` listing",
      "   each violation by line — fix and retry.",
      "5. **Body↔descriptor cross-check**: every `var(--…)` you reference (other than",
      "   scaffold tokens `--color-bg`, `--color-fg`, `--font-display`, `--font-body`,",
      "   `--font-mono`, `--space-unit`, scale tokens `--space-N`, `--font-size-N`,",
      "   `--radius-*`, `--color-neutral-N`) MUST be declared by a `KnobDescriptor` in",
      "   the `knobs` array passed to `generate-design`. Otherwise the user has no",
      "   knob for it. The check returns a toolError listing missing descriptors.",
      "",
      "   **Knob descriptor rules — `behavior: \"scale-spacing\"` is special:**",
      "   - Use it ONLY for a single global density / spacing-scale knob that",
      "     rescales every `--space-*`/`--radius-*` proportionally.",
      "   - It MUST be `kind: \"range\"` AND `unit: \"%\"`. The value the canvas",
      "     sends is a signed-delta percent (e.g. `+30%` = 30% larger,",
      "     `-15%` = 15% smaller, `+0%` = unchanged).",
      "   - Recommended shape: `{ key: \"spacing\", label: \"Spacing\", kind: \"range\",",
      "     behavior: \"scale-spacing\", unit: \"%\", min: -30, max: 30, step: 5,",
      "     current: \"+0%\" }`.",
      "   - Do NOT pair `behavior: \"scale-spacing\"` with `unit: \"px\"`/`\"rem\"`/etc.",
      "     — `generate-design` rejects that. (Mistake here once produced",
      "     1152px space tokens by treating the px slider value as a multiplier.)",
      "   - For an absolute pixel knob targeting one variable (e.g. `--space-unit`",
      "     directly, or `--radius-base`), OMIT `behavior` and use",
      "     `kind: \"range\"` + `unit: \"px\"`. The value is written verbatim.",
      "6. If the user asks for a refinement, call `tweak-design` with structured knobs.",
      "   Each tweak creates a NEW revision; never mutate prior drafts.",
      "   To revert to a prior version, call `list-revisions` and pass the chosen",
      "   revision's `knobValues` back through `tweak-design` — the originalTokensBlock",
      "   snapshot ensures the result equals that revision's HTML byte-for-byte.",
      "7. When the user says 'ship it' or 'hand off', call `package-handoff`.",
      "8. To show the user the live canvas, call `open-canvas` AFTER `generate-design`.",
      "",
      "## Quality bar (every generation must satisfy)",
      "",
      "Content quality:",
      "- Real, specific copy. NO 'Lorem ipsum', NO 'Click here', NO 'Learn more' buttons.",
      "  Every CTA reads like a confident human wrote it for a real product.",
      "- At least three depths of content per section: heading + supporting line +",
      "  body/list/CTA. A page of headlines alone is not finished.",
      "- Real numerical / proper-noun specificity wherever it doesn't lie about facts:",
      "  'Trusted by 240 teams' if the brief says so, otherwise omit (don't fabricate).",
      "",
      "Structure:",
      "- Semantic HTML: `<header>`, `<main>`, `<nav>`, `<section>` with aria-labels,",
      "  `<footer>`. Every interactive element is `<button>` or `<a>`, never a `<div>`",
      "  with onclick.",
      "- Each section has a clear, single purpose. If you can't articulate it in one",
      "  sentence, cut or merge.",
      "- Heading hierarchy: one `<h1>`, multiple `<h2>` for section headers, `<h3>` for",
      "  nested. Don't skip levels.",
      "",
      "Visuals:",
      "- Contrast: heading text uses `var(--color-fg)` on `var(--color-bg)` (or the",
      "  inverse pair). Don't put `--color-fg` on a tinted surface — declare a tint",
      "  variable and a knob descriptor for it.",
      "- Whitespace via `var(--space-*)`, never raw px. Density should match the chosen",
      "  tone (compact for editorial, generous for refined-minimal).",
      "- Hero / above-the-fold has ONE focal element. Multiple 'look at me' elements",
      "  compete and lose.",
      "",
      "Tokens:",
      "- Every color through `var(--color-*)`. Every spacing through `var(--space-*)`.",
      "  Every font-size through `var(--font-size-*)`. Every radius through",
      "  `var(--radius-*)`.",
      "- For every `var(--…)` you use beyond the scaffold tokens, declare a matching",
      "  `KnobDescriptor` in the `knobs` array (label + kind + var). The user gets a",
      "  control for every variable you wired in.",
      "",
      "## Critical: never silently change brand colors or typography during a tweak",
      "",
      "If the user asks for 'a more warm feel' but the project's design system has a",
      "fixed primary color, propose the change explicitly and wait for approval before",
      "calling tweak-design. Design-system enforcement is the default.",
      "",
      "## When tokens are missing",
      "",
      "Pick a true direction (brutalist, editorial, retro-futuristic, refined minimalism,",
      "maximalist) and execute it precisely. Don't hedge.",
      "",
      "## Reference: aesthetic philosophy",
      "",
      aestheticPhilosophy,
      "",
      "## Reference: design-system guide",
      "",
      systemGuide,
    ].join("\n"),
    category: "Design",
    capabilities: ["html-generation", "design-system-extraction", "design-tokens"],
    modelRequirements: { tier: "powerful" },
    temperature: 0.4,
  },

  panel: {
    position: "bottom",
    defaultCollapsed: false,
    stateSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        components: { type: "array" },
      },
    },
  },

  scripts: {
    postinstall: "./scripts/postinstall.ts",
  },

  permissions: {
    filesystem: ["$CWD"],
    shell: false,
    storage: true,
    eventSubscriptions: ["claude-design:knob-change", "claude-design:brief-answer"],
    network: ["cdn.jsdelivr.net"],
  },

  resources: {
    memory: "1GB",
    storage: "50MB",
    callTimeoutMs: 5 * 60_000,
  },
});
