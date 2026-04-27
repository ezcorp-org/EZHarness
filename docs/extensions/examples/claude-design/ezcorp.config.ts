import { defineExtension } from "../../../../src/extensions/sdk/define";

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
      name: "generate-design",
      description:
        "Generate an HTML draft. The tool wraps your `bodyMarkup` with a head section " +
        "containing a <style id=\"design-tokens\"> block (CSS variables for every project " +
        "token) and a Tailwind CDN link. You author the body markup; the tool is the " +
        "scaffolder, not a model caller. Body MUST reference design tokens via " +
        "`var(--color-*)` and `calc(var(--space-unit) * N)` — that's what makes " +
        "subsequent knob tweaks (color/spacing/typography) a one-line CSS-var rewrite. " +
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
              "Knob adjustments. Supported: primaryColor (hex), secondaryColor (hex), " +
              "spacingScale (e.g. '+10%' or '-5%'), borderRadius (px), density " +
              "('compact'|'cozy'|'spacious').",
            properties: {
              primaryColor: { type: "string" },
              secondaryColor: { type: "string" },
              spacingScale: { type: "string" },
              borderRadius: { type: "string" },
              density: {
                type: "string",
                "x-options": { options: ["compact", "cozy", "spacious"], allowCustom: false },
              },
            },
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
        "iframe with knob sliders along the edge. Knob changes round-trip back to " +
        "tweak-design via the canvas event subscription.",
      inputSchema: {
        type: "object",
        properties: {
          draftId: { type: "string" },
        },
        required: ["draftId"],
      },
      cardType: "design-canvas",
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
      "2. If tokens exist (Tailwind config, CSS vars, tokens.json), CONFORM to them.",
      "   If the project is greenfield (source: 'greenfield'), commit to a BOLD aesthetic",
      "   per `design-aesthetic-philosophy` — never default to Inter/Roboto/Arial.",
      "3. Call `generate-design` with `prompt`, `kind`, AND `bodyMarkup`. YOU author the",
      "   body markup — the tool only wraps your markup with the <head>, design-tokens",
      "   <style> block, and Tailwind CDN. Every color, spacing, font-size, and radius",
      "   MUST go through CSS variables (`var(--color-primary)`, `var(--color-fg)`,",
      "   `calc(var(--space-unit) * 4)`, `var(--font-display)`, `var(--radius-base)`,",
      "   etc.). Hard-coded values (e.g. `color: #ff0066`) WILL NOT respond to",
      "   tweak-design — fix this BEFORE returning.",
      "4. If the user asks for a refinement, call `tweak-design` with structured knobs.",
      "   Each tweak creates a NEW revision; never mutate prior drafts.",
      "5. When the user says 'ship it' or 'hand off', call `package-handoff`.",
      "6. To show the user the live canvas, call `open-canvas` AFTER `generate-design`.",
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
    eventSubscriptions: ["claude-design:knob-change"],
    network: ["cdn.jsdelivr.net"],
  },

  resources: {
    memory: "1GB",
    storage: "50MB",
    callTimeoutMs: 5 * 60_000,
  },
});
