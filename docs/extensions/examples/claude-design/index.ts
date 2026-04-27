#!/usr/bin/env bun
// claude-design — first consumer of @ezcorp/sdk's canvas + preview
// primitives. JSON-RPC dispatcher that wires:
//   - tool handlers (extract-design-system, generate-design,
//     tweak-design, package-handoff, list-drafts, get-draft, open-canvas)
//   - the canvas event handler (claude-design:knob-change) via createCanvas
//   - panel state on run:complete
//
// Heavy lifting lives in lib/ (tokens, tweak, generator, handoff). This
// file is the routing layer + filesystem glue.

import { existsSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createCanvas,
  createToolDispatcher,
  getChannel,
  toolError,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

import { extractFromRoot } from "./lib/tokens";
import { applyKnobs } from "./lib/tweak";
import { buildScaffold } from "./lib/generator";
import { writeHandoffBundle } from "./lib/handoff";
import {
  defaultProjectSlug,
  draftIframeUrl,
  findProjectRoot,
  handoffsDir,
  projectDir,
  projectsDir,
} from "./lib/project";
import type { DesignSystem, DraftMeta, Knobs } from "./lib/types";

// ── createCanvas wiring (Phase A consumer) ─────────────────────────
//
// Knob events come back from the canvas card via the generic
// /api/extensions/claude-design/events/knob-change route. The handler
// resolves the active draft, calls applyKnobs to write a new revision,
// and the user can refresh the canvas to see the new draft. (Live
// refresh-from-extension is Phase B follow-up — see canvas.ts header.)

interface KnobChangePayload {
  toolCallId: string;
  conversationId: string;
  draftId?: string;
  knobs?: Knobs;
}

createCanvas<{ "knob-change": KnobChangePayload }>({
  cardType: "design-canvas",
  namespace: "claude-design",
  events: {
    "knob-change": async ({ payload }) => {
      // No `as` cast needed — payload is typed via the generic. The
      // SDK still extracts toolCallId/conversationId into the
      // `context` arg if a handler wants the typed convenience.
      if (!payload.draftId) return;
      try {
        await applyKnobsToDraft(payload.draftId, payload.knobs ?? {});
      } catch (err) {
        // Canvas event handlers must not throw — swallow and let the
        // user retry. The new revision (or absence thereof) will be
        // visible on the next list-drafts call.
        process.stderr.write(`[claude-design] knob-change failed: ${err}\n`);
      }
    },
  },
});

// ── Tool handlers ──────────────────────────────────────────────────

const extractDesignSystem: ToolHandler = async (args) => {
  const slug = typeof args.projectSlug === "string" ? args.projectSlug : defaultProjectSlug();
  const force = args.force === true;
  const dir = projectDir(slug);
  const dsPath = join(dir, "design-system.json");
  if (!force && existsSync(dsPath)) {
    const cached = readJsonSafe<DesignSystem>(dsPath);
    if (cached) return toolResult(JSON.stringify(cached, null, 2));
  }
  const root = findProjectRoot();
  const ds = await extractFromRoot({
    readFile: async (rel) => {
      const abs = join(root, rel);
      return existsSync(abs) ? readFileSync(abs, "utf-8") : null;
    },
    glob: async (pattern) => globSync(root, pattern),
  });
  writeFileSync(dsPath, JSON.stringify(ds, null, 2) + "\n");
  return toolResult(JSON.stringify(ds, null, 2));
};

const generateDesign: ToolHandler = async (args) => {
  const slug = typeof args.projectSlug === "string" ? args.projectSlug : defaultProjectSlug();
  const prompt = String(args.prompt ?? "").trim();
  const kind = String(args.kind ?? "page") as DraftMeta["kind"];
  const parentDraftId = typeof args.parentDraftId === "string" ? args.parentDraftId : undefined;
  const bodyMarkup = typeof args.bodyMarkup === "string" ? args.bodyMarkup : undefined;
  if (!prompt) return toolError("prompt is required");
  const dir = projectDir(slug);
  const dsPath = join(dir, "design-system.json");
  const ds = readJsonSafe<DesignSystem>(dsPath);
  if (!ds) {
    return toolError(
      "Design system not extracted yet — call extract-design-system first.",
    );
  }
  const draftId = `d-${Date.now().toString(36)}-${randomShort()}`;
  const meta: DraftMeta = {
    schemaVersion: 1,
    draftId,
    parentDraftId,
    prompt,
    kind,
    createdAt: new Date().toISOString(),
  };
  const html = buildScaffold({ meta, designSystem: ds, bodyMarkup });
  const htmlPath = join(dir, "drafts", `${draftId}.html`);
  const metaPath = join(dir, "drafts", `${draftId}.meta.json`);
  writeFileSync(htmlPath, html);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return toolResult(
    JSON.stringify(
      {
        draftId,
        path: htmlPath,
        iframeSrc: draftIframeUrl(slug, `${draftId}.html`),
      },
      null,
      2,
    ),
  );
};

const tweakDesign: ToolHandler = async (args) => {
  const draftId = String(args.draftId ?? "");
  const knobs = (args.knobs ?? {}) as Knobs;
  if (!draftId) return toolError("draftId is required");
  try {
    const result = await applyKnobsToDraft(draftId, knobs);
    return toolResult(JSON.stringify(result, null, 2));
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
};

const packageHandoff: ToolHandler = async (args) => {
  const draftId = String(args.draftId ?? "");
  const targetFramework = (args.targetFramework ?? "react") as
    | "react" | "svelte" | "vue" | "html";
  if (!draftId) return toolError("draftId is required");
  const located = locateDraft(draftId);
  if (!located) return toolError(`draft not found: ${draftId}`);
  const { slug, htmlPath, metaPath } = located;
  const html = readFileSync(htmlPath, "utf-8");
  const meta = readJsonSafe<DraftMeta>(metaPath);
  if (!meta) return toolError("draft metadata missing");
  const ds = readJsonSafe<DesignSystem>(join(projectDir(slug), "design-system.json"));
  if (!ds) return toolError("design system missing — call extract-design-system");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bundleDir = join(handoffsDir(), `${slug}-${ts}`);
  writeHandoffBundle({
    bundleDir,
    draftHtml: html,
    draftMeta: meta,
    designSystem: ds,
    targetFramework,
  });
  // Enumerate real files written so the LLM has a truthful manifest.
  // Was previously a hardcoded 3-file list that ignored README.md,
  // design-system.json, knob-trail.json, starter/, agents/.
  const files = listBundleFilesRelative(bundleDir);
  return toolResult(JSON.stringify({ bundleDir, files }, null, 2));
};

const listDrafts: ToolHandler = async (args) => {
  const slug = typeof args.projectSlug === "string" ? args.projectSlug : defaultProjectSlug();
  const dir = join(projectDir(slug), "drafts");
  if (!existsSync(dir)) return toolResult("[]");
  const drafts: Array<{ draftId: string; createdAt: string; prompt: string }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".meta.json")) continue;
    const meta = readJsonSafe<DraftMeta>(join(dir, name));
    if (meta) {
      drafts.push({ draftId: meta.draftId, createdAt: meta.createdAt, prompt: meta.prompt });
    }
  }
  drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return toolResult(JSON.stringify(drafts, null, 2));
};

const getDraft: ToolHandler = async (args) => {
  const draftId = String(args.draftId ?? "");
  const maxChars = typeof args.maxChars === "number" ? args.maxChars : 8192;
  if (!draftId) return toolError("draftId is required");
  const located = locateDraft(draftId);
  if (!located) return toolError(`draft not found: ${draftId}`);
  const html = readFileSync(located.htmlPath, "utf-8");
  const meta = readJsonSafe<DraftMeta>(located.metaPath);
  const truncated = html.length > maxChars ? html.slice(0, maxChars) + "\n<!-- TRUNCATED -->" : html;
  return toolResult(
    JSON.stringify({ draftId, meta, html: truncated, fullSize: html.length }, null, 2),
  );
};

const openCanvas: ToolHandler = async (args) => {
  const draftId = String(args.draftId ?? "");
  if (!draftId) return toolError("draftId is required");
  const located = locateDraft(draftId);
  if (!located) return toolError(`draft not found: ${draftId}`);
  return toolResult(
    JSON.stringify(
      {
        draftId,
        iframeSrc: draftIframeUrl(located.slug, `${draftId}.html`),
        knobsAvailable: ["primaryColor", "secondaryColor", "spacingScale", "borderRadius", "density"],
      },
      null,
      2,
    ),
  );
};

const tools: Record<string, ToolHandler> = {
  "extract-design-system": extractDesignSystem,
  "generate-design": generateDesign,
  "tweak-design": tweakDesign,
  "package-handoff": packageHandoff,
  "list-drafts": listDrafts,
  "get-draft": getDraft,
  "open-canvas": openCanvas,
};

createToolDispatcher(tools);

// Lifecycle: panel snapshot on run:complete is a v0.2 follow-up.
// The PanelBuilder wiring needs separate work; shipping an empty hook
// today is dead code that would only mask the actual feature gap.

getChannel().start();

// ── Helpers ────────────────────────────────────────────────────────

interface ApplyKnobsResult {
  draftId: string;
  parentDraftId: string;
  htmlPath: string;
  changedVars: string[];
}

async function applyKnobsToDraft(
  parentDraftId: string,
  knobs: Knobs,
): Promise<ApplyKnobsResult> {
  const located = locateDraft(parentDraftId);
  if (!located) throw new Error(`draft not found: ${parentDraftId}`);
  const { slug, htmlPath, metaPath } = located;
  const html = readFileSync(htmlPath, "utf-8");
  const { html: nextHtml, changedVars } = applyKnobs(html, knobs);
  const parentMeta = readJsonSafe<DraftMeta>(metaPath);
  if (!parentMeta) throw new Error("parent draft metadata missing");
  const draftId = `${parentDraftId}__r${Date.now().toString(36)}`;
  const nextMeta: DraftMeta = {
    schemaVersion: 1,
    draftId,
    parentDraftId,
    prompt: parentMeta.prompt,
    kind: parentMeta.kind,
    knobs: knobs as Record<string, string>,
    createdAt: new Date().toISOString(),
  };
  const draftsDir = join(projectDir(slug), "drafts");
  const newHtmlPath = join(draftsDir, `${draftId}.html`);
  writeFileSync(newHtmlPath, nextHtml);
  writeFileSync(
    join(draftsDir, `${draftId}.meta.json`),
    JSON.stringify(nextMeta, null, 2) + "\n",
  );
  return { draftId, parentDraftId, htmlPath: newHtmlPath, changedVars };
}

interface LocatedDraft {
  slug: string;
  htmlPath: string;
  metaPath: string;
}

function locateDraft(draftId: string): LocatedDraft | null {
  const root = projectsDir();
  if (!existsSync(root)) return null;
  for (const slug of readdirSync(root)) {
    const draftsDir = join(root, slug, "drafts");
    if (!existsSync(draftsDir)) continue;
    const htmlPath = join(draftsDir, `${draftId}.html`);
    const metaPath = join(draftsDir, `${draftId}.meta.json`);
    if (existsSync(htmlPath) && existsSync(metaPath)) {
      return { slug, htmlPath, metaPath };
    }
  }
  return null;
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function randomShort(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Recursively list relative paths under `dir` for the package-handoff
 *  result. Sorted alphabetically for stable LLM-facing output. */
function listBundleFilesRelative(dir: string): string[] {
  const out: string[] = [];
  function walk(absDir: string, rel: string): void {
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(absDir, name);
      const r = rel ? `${rel}/${name}` : name;
      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        walk(abs, r);
      } else {
        out.push(r);
      }
    }
  }
  walk(dir, "");
  out.sort();
  return out;
}

/** Directories the glob walker NEVER descends into. Build artifacts,
 *  package caches, framework outputs — everything an extension's
 *  design-system extraction has no business looking at. */
const GLOB_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".svelte-kit",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".vercel",
  ".netlify",
]);

function globSync(root: string, pattern: string): string[] {
  // Tiny synchronous glob wrapper — only handles patterns this
  // extension actually emits (`**/*.css`, `**/components/*.svelte`,
  // bare filenames). Avoids pulling in a full glob lib for the
  // sandbox-restricted subprocess.
  //
  // `**/<x>` must match BOTH a top-level file (`<x>` with no leading
  // slash) AND any nested file. We handle this by emitting two regexes
  // — one with the literal `.*/` prefix, one without. Without this,
  // patterns like `**/*.css` silently miss `theme.css` at the project
  // root. [In3 from the Phase B integration review]
  const compiled = compileGlob(pattern);
  const out: string[] = [];
  function walk(dir: string, rel: string): void {
    if (out.length >= 256) return; // safety bound
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (GLOB_SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        walk(abs, relPath);
      } else if (compiled.test(relPath)) {
        out.push(relPath);
      }
    }
  }
  walk(root, "");
  return out;
}

function compileGlob(pattern: string): { test: (s: string) => boolean } {
  const escaped = pattern.replace(/\./g, "\\.");
  // Pattern with `**/` prefix → also accept zero-segment match.
  const expanded = escaped
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  const re = new RegExp("^" + expanded + "$");
  return { test: (s: string) => re.test(s) };
}
