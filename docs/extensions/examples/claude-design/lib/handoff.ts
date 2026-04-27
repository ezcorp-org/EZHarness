// `package-handoff` bundle writer. Produces a folder Claude Code can
// consume directly — see `knowledge/handoff-format-spec.md` for the
// full contract.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DesignSystem, DraftMeta } from "./types";

const TOKEN_BLOCK_RE =
  /<style\s+id="design-tokens"[^>]*>([\s\S]*?)<\/style>/i;

/**
 * Extract the `:root { … }` token block from a draft's HTML. Used by
 * `package-handoff` to write `tokens.css` reflecting the AS-TWEAKED
 * tokens (not the snapshot in design-system.json). The two diverge
 * after any knob change.
 */
function extractTokensBlockFromHtml(html: string): string {
  const match = TOKEN_BLOCK_RE.exec(html);
  if (!match) {
    throw new Error(
      "[claude-design.handoff] draft HTML missing `<style id=\"design-tokens\">` block — " +
        "cannot generate tokens.css. Was the draft produced by claude-design's generator?",
    );
  }
  return (match[1] ?? "").trim();
}

export interface HandoffInput {
  bundleDir: string;          // absolute path of the new bundle folder
  draftHtml: string;
  draftMeta: DraftMeta;
  designSystem: DesignSystem;
  targetFramework: "react" | "svelte" | "vue" | "html";
}

export function writeHandoffBundle(input: HandoffInput): void {
  mkdirSync(input.bundleDir, { recursive: true });
  mkdirSync(join(input.bundleDir, "starter"), { recursive: true });
  mkdirSync(join(input.bundleDir, "agents"), { recursive: true });

  writeFileSync(join(input.bundleDir, "design.html"), input.draftHtml);

  writeFileSync(
    join(input.bundleDir, "design-system.json"),
    JSON.stringify(input.designSystem, null, 2) + "\n",
  );

  // tokens.css MUST reflect the FINAL draft's tokens (post-tweaks),
  // not the snapshot in design-system.json. The two diverge after any
  // knob change — the snapshot is the as-designed reference, the
  // draft is the as-tweaked reality. Claude Code consuming the bundle
  // needs the as-tweaked values to recreate the draft faithfully.
  // [C1 from the Phase B review]
  writeFileSync(
    join(input.bundleDir, "tokens.css"),
    extractTokensBlockFromHtml(input.draftHtml) +
      "\n",
  );

  writeFileSync(
    join(input.bundleDir, "knob-trail.json"),
    JSON.stringify(
      {
        draftId: input.draftMeta.draftId,
        parentDraftId: input.draftMeta.parentDraftId,
        knobs: input.draftMeta.knobs ?? {},
        appliedAt: input.draftMeta.createdAt,
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(join(input.bundleDir, "README.md"), readmeFor(input));
  writeFileSync(join(input.bundleDir, "IMPLEMENT.md"), implementFor(input));
  writeFileSync(
    join(input.bundleDir, "starter", starterFilename(input.targetFramework)),
    starterContent(input),
  );

  writeFileSync(
    join(input.bundleDir, "agents", "claude-design-implement.md"),
    [
      "---",
      "name: claude-design-implement",
      "description: Implement a packaged claude-design handoff in this project.",
      "---",
      "Read IMPLEMENT.md in this directory. Build the components per `targetFramework`,",
      "wire `tokens.css` into the project's global stylesheet, and verify against",
      "design.html as a visual reference.",
      "",
    ].join("\n"),
  );
}

// ── README + IMPLEMENT ─────────────────────────────────────────────

function readmeFor(input: HandoffInput): string {
  const ds = input.designSystem;
  return [
    `# Design handoff: ${input.draftMeta.prompt}`,
    "",
    `- **Kind**: ${input.draftMeta.kind}`,
    `- **Target framework**: ${input.targetFramework}`,
    `- **Design system source**: ${ds.source}`,
    `- **Primary color**: ${ds.colors.primary}`,
    `- **Display font**: ${ds.typography.display}`,
    `- **Spacing unit**: ${ds.spacing.unit}px`,
    "",
    "## Files",
    "",
    "- `design.html` — the chosen draft (open in a browser to see the visual reference)",
    "- `tokens.css` — CSS variables ready to import",
    "- `design-system.json` — machine-readable token snapshot",
    "- `IMPLEMENT.md` — agent-facing implementation spec",
    "- `knob-trail.json` — how this draft was tweaked from its parent",
    `- \`starter/${starterFilename(input.targetFramework)}\` — starter component for ${input.targetFramework}`,
    "- `agents/claude-design-implement.md` — slash-command stub (drop into your `agents/` dir to make it discoverable)",
    "",
    "## Next step",
    "",
    "Run the slash command `/claude-design-implement` (after wiring the agents file) or",
    "ask Claude Code to read IMPLEMENT.md in this directory.",
    "",
  ].join("\n");
}

function implementFor(input: HandoffInput): string {
  const ds = input.designSystem;
  const componentList = ds.components.length > 0
    ? ds.components.map((c) => `- \`${c.name}\` — \`${c.path}\``).join("\n")
    : "_No components catalogued — every component the design uses is new._";
  return [
    `# Implement: ${input.draftMeta.prompt}`,
    "",
    "## Overview",
    "",
    `Build a ${input.draftMeta.kind} matching the design in \`design.html\`. The visual is`,
    "the source of truth; this document is the agent-facing spec.",
    "",
    "## Tokens",
    "",
    "Import the CSS variables into the project's global stylesheet:",
    "",
    "```css",
    `@import url('./tokens.css');`,
    "```",
    "",
    "Snapshot of the token values (also in `design-system.json`):",
    "",
    "```json",
    JSON.stringify(ds, null, 2),
    "```",
    "",
    "## Components",
    "",
    componentList,
    "",
    "## Pages",
    "",
    `Place the component(s) under the path conventional for ${input.targetFramework} in this`,
    "project. Reference the body markup in `design.html` for the structural layout —",
    "the markup uses CSS variables directly, so a 1:1 port preserves the design.",
    "",
  ].join("\n");
}

// ── Starter scaffolds ──────────────────────────────────────────────

function starterFilename(framework: HandoffInput["targetFramework"]): string {
  switch (framework) {
    case "react":
      return "DesignDraft.tsx";
    case "svelte":
      return "DesignDraft.svelte";
    case "vue":
      return "DesignDraft.vue";
    case "html":
      return "design.html";
  }
}

function starterContent(input: HandoffInput): string {
  switch (input.targetFramework) {
    case "react":
      return [
        `// Generated by claude-design. Edit freely — design.html is the visual ref.`,
        `import "./tokens.css";`,
        ``,
        `export function DesignDraft(): JSX.Element {`,
        `  return (`,
        `    <main style={{ background: "var(--color-bg)", color: "var(--color-fg)", fontFamily: "var(--font-body)" }}>`,
        `      {/* TODO: port the body of design.html here */}`,
        `    </main>`,
        `  );`,
        `}`,
        ``,
      ].join("\n");
    case "svelte":
      return [
        `<!-- Generated by claude-design. Edit freely. -->`,
        `<script lang="ts">`,
        `  import "./tokens.css";`,
        `</script>`,
        ``,
        `<main style="background: var(--color-bg); color: var(--color-fg); font-family: var(--font-body);">`,
        `  <!-- TODO: port the body of design.html here -->`,
        `</main>`,
        ``,
      ].join("\n");
    case "vue":
      return [
        `<!-- Generated by claude-design. Edit freely. -->`,
        `<template>`,
        `  <main :style="{`,
        `    background: 'var(--color-bg)',`,
        `    color: 'var(--color-fg)',`,
        `    fontFamily: 'var(--font-body)'`,
        `  }">`,
        `    <!-- TODO: port the body of design.html here -->`,
        `  </main>`,
        `</template>`,
        ``,
        `<style>`,
        `  @import "./tokens.css";`,
        `</style>`,
        ``,
      ].join("\n");
    case "html":
      return input.draftHtml;
  }
}
