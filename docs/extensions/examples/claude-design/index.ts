#!/usr/bin/env bun
// claude-design — first consumer of @ezcorp/sdk's canvas + preview
// primitives. JSON-RPC dispatcher that wires:
//   - tool handlers (extract-design-system, generate-design,
//     tweak-design, package-handoff, list-drafts, get-draft, open-canvas,
//     clarify-brief)
//   - the canvas event handlers (claude-design:knob-change,
//     claude-design:brief-answer) via createCanvas
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
  type ToolHandlerContext,
} from "@ezcorp/sdk/runtime";

import { extractFromRoot } from "./lib/tokens";
import {
  applyKnobs,
  applyKnobsByDescriptors,
  extractTokensBlock,
  LEGACY_DESCRIPTORS,
  replaceTokensBlock,
} from "./lib/tweak";
import { buildScaffold } from "./lib/generator";
import { writeHandoffBundle } from "./lib/handoff";
import { lintBodyMarkup } from "./lib/lint";
import {
  defaultProjectSlug,
  draftIframeUrl,
  findProjectRoot,
  handoffsDir,
  projectDir,
  projectsDir,
} from "./lib/project";
import {
  migrateMeta,
  type ApplyKnobsResult,
  type DesignSystem,
  type DraftMeta,
  type KnobDescriptor,
  type Knobs,
  type OpenCanvasResult,
  type Revision,
} from "./lib/types";

// ── Brief-answer gate (mirrors ask-user/index.ts:145-218) ──────────
//
// `clarify-brief` opens a form-card and pauses on a per-toolCallId promise
// gate. The card's submit button POSTs to the generic event route which
// emits `claude-design:brief-answer`; the canvas handler below resolves
// the matching gate. 5min timeout, abort signal, conversationId guard
// — same posture as the ask-user gate.

interface PendingBriefAnswer {
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  conversationId: string;
}

const pendingBriefAnswers = new Map<string, PendingBriefAnswer>();

const DEFAULT_BRIEF_TIMEOUT_MS = 5 * 60_000;
let briefTimeoutMs = DEFAULT_BRIEF_TIMEOUT_MS;

/** Test-only: shrink the 5-minute timeout. */
export function _setBriefTimeoutForTests(ms: number): void {
  briefTimeoutMs = ms;
}

interface ClarifyBriefToolContext extends ToolHandlerContext {
  signal?: AbortSignal;
}

const clarifyBrief: ToolHandler = async (args, ctx?: ClarifyBriefToolContext) => {
  const { fields } = args as { fields?: unknown };
  // Validate fields shape — the LLM occasionally hallucinates a string.
  if (!Array.isArray(fields) || fields.length === 0) {
    return toolError("'fields' is required and must be a non-empty array.");
  }
  for (const f of fields) {
    if (!f || typeof f !== "object") {
      return toolError("Each field must be an object.");
    }
    const fld = f as Record<string, unknown>;
    if (typeof fld.key !== "string" || fld.key.length === 0) {
      return toolError("Each field must have a non-empty string `key`.");
    }
    if (typeof fld.label !== "string" || fld.label.length === 0) {
      return toolError("Each field must have a non-empty string `label`.");
    }
    if (
      typeof fld.kind !== "string" ||
      !["text", "select", "multi-select"].includes(fld.kind)
    ) {
      return toolError("Each field's `kind` must be 'text' | 'select' | 'multi-select'.");
    }
  }

  const md = ctx?.invocationMetadata ?? {};
  const toolCallId = typeof md.toolCallId === "string" ? md.toolCallId : undefined;
  const conversationId =
    typeof md.conversationId === "string" ? md.conversationId : undefined;

  if (!toolCallId || !conversationId) {
    return toolError("missing tool-call context (toolCallId + conversationId).");
  }

  const signal = ctx?.signal;
  const onAbort = () => {
    const pending = pendingBriefAnswers.get(toolCallId);
    if (pending) {
      clearTimeout(pending.timeoutHandle);
      pendingBriefAnswers.delete(toolCallId);
      pending.reject(new Error("Aborted while waiting for brief answer"));
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const answer = await new Promise<string>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const pending = pendingBriefAnswers.get(toolCallId);
        if (pending) {
          pendingBriefAnswers.delete(toolCallId);
          pending.reject(new Error("Timed out waiting for brief answer"));
        }
      }, briefTimeoutMs);
      pendingBriefAnswers.set(toolCallId, {
        resolve,
        reject,
        timeoutHandle,
        conversationId,
      });
    });
    return toolResult(answer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(message);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
};

interface IncomingBriefAnswer {
  toolCallId: string;
  conversationId: string;
  answer: unknown;
}

async function handleBriefAnswer(payload: IncomingBriefAnswer): Promise<void> {
  const { toolCallId, conversationId, answer } = payload;
  const pending = pendingBriefAnswers.get(toolCallId);
  if (!pending) return;
  if (pending.conversationId !== conversationId) return;
  clearTimeout(pending.timeoutHandle);
  pendingBriefAnswers.delete(toolCallId);
  // Stringify structured answers so the tool result content is text.
  pending.resolve(typeof answer === "string" ? answer : JSON.stringify(answer));
}

// ── createCanvas wiring ────────────────────────────────────────────
//
// Knob events come back from the canvas card via the generic
// /api/extensions/claude-design/events/<event> route. The handler
// resolves the active draft, calls applyKnobs to write a new revision,
// and the user can refresh the canvas to see the new draft.
//
// Brief-answer events are routed to the clarify-brief gate above.

interface KnobChangePayload {
  toolCallId: string;
  conversationId: string;
  draftId?: string;
  knobs?: Record<string, string>;
}

createCanvas<{ "knob-change": KnobChangePayload }>({
  cardType: "design-canvas",
  namespace: "claude-design",
  events: {
    "knob-change": async ({ payload }) => {
      if (!payload.draftId) {
        // Structured log so the host can surface this failure even when
        // there's no draftId on the payload (e.g. the canvas wired the
        // event before the draft id resolved).
        process.stderr.write(
          JSON.stringify({
            extension: "claude-design",
            event: "knob-change",
            error: "missing draftId on payload",
            draftId: null,
          }) + "\n",
        );
        return;
      }
      try {
        await applyKnobsToDraft(payload.draftId, payload.knobs ?? {});
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          JSON.stringify({
            extension: "claude-design",
            event: "knob-change",
            error: message,
            draftId: payload.draftId,
          }) + "\n",
        );
      }
    },
  },
});

createCanvas<{ "brief-answer": IncomingBriefAnswer }>({
  cardType: "design-brief",
  namespace: "claude-design",
  events: {
    "brief-answer": async ({ payload }) => {
      await handleBriefAnswer(payload);
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
  const knobsTitle = typeof args.knobsTitle === "string" ? args.knobsTitle : undefined;
  const rawKnobs = args.knobs;
  const skipBriefReason = typeof args.skipBriefReason === "string" ? args.skipBriefReason.trim() : "";
  if (!prompt) return toolError("prompt is required");

  // Brief-presence soft gate. The agent prompt instructs the model to
  // call `clarify-brief` UNLESS all four signals (tone, audience, ≥1
  // section, brand colors) are explicitly present. The check below is a
  // last-line guard that nudges the agent back when the prompt is so
  // under-specified that proceeding would mean fabricating answers.
  // Detection is heuristic on purpose — false negatives are tolerable
  // (the agent prompt is the primary defense); false positives hurt UX.
  // Only fail closed when ALL of: prompt is short AND has no hex code
  // AND has no section keyword AND no skipBriefReason was supplied.
  if (!skipBriefReason) {
    const evidence = analyzePromptSpecificity(prompt);
    if (evidence.score === 0 && prompt.split(/\s+/).filter(Boolean).length < 12) {
      return toolError(
        "Prompt is too under-specified to generate a polished design. " +
          "Call `clarify-brief` first to collect tone / audience / sections / brand " +
          "colors from the user. If the user explicitly told you to skip questions, " +
          "pass `skipBriefReason: \"<one-sentence justification listing what the user said>\"` " +
          "and retry.\nPrompt was: " +
          JSON.stringify(prompt),
      );
    }
  }

  // Lint the body markup before scaffolding. On failure, return a
  // clear toolError listing each violation with its line number — the
  // agent uses the message to author a corrected revision.
  if (typeof bodyMarkup === "string" && bodyMarkup.length > 0) {
    const lint = lintBodyMarkup(bodyMarkup);
    if (!lint.ok) {
      const lines = lint.violations
        .map((v) => "  - " + v.message + (v.line ? " (line " + v.line + ")" : ""))
        .join("\n");
      return toolError(
        "bodyMarkup failed lint:\n" +
          lines +
          "\nReplace hardcoded values with var(--…) tokens and retry.",
      );
    }
  }

  // Validate descriptor array, if supplied.
  let knobs: KnobDescriptor[] | undefined;
  if (rawKnobs !== undefined) {
    if (!Array.isArray(rawKnobs)) {
      return toolError("`knobs`, if provided, must be an array of KnobDescriptor objects.");
    }
    for (const d of rawKnobs) {
      if (!d || typeof d !== "object") {
        return toolError("Each knob descriptor must be an object.");
      }
      const dd = d as Record<string, unknown>;
      if (typeof dd.key !== "string" || dd.key.length === 0) {
        return toolError("Each knob descriptor needs a non-empty `key`.");
      }
      if (typeof dd.label !== "string" || dd.label.length === 0) {
        return toolError("Each knob descriptor needs a non-empty `label`.");
      }
      if (
        typeof dd.kind !== "string" ||
        !["color", "range", "select", "text"].includes(dd.kind)
      ) {
        return toolError("Each knob descriptor needs `kind` ∈ {color, range, select, text}.");
      }
      if (dd.kind === "select") {
        if (!Array.isArray(dd.options) || dd.options.length === 0) {
          return toolError("Knob descriptor with `kind: \"select\"` requires `options[]`.");
        }
      }
      // `behavior: "scale-spacing"` rescales every `--space-*`/`--radius-*`
      // by a multiplicative factor. The wire format the canvas sends is
      // signed-delta percent ("+30%"), and that only works when the
      // descriptor declares `unit: "%"`. A scale-spacing knob with
      // `unit: "px"` (the prior bug) makes the slider value land on
      // backend's bare-number branch — `12px` was treated as a 12×
      // multiplier and blew --space-unit from 8 to 96 to 1152. Reject
      // up-front so the agent must use signed-delta percentages.
      if (dd.behavior === "scale-spacing" && dd.unit !== "%") {
        return toolError(
          "Knob descriptor `" +
            String(dd.key) +
            "` has `behavior: \"scale-spacing\"` but `unit` is " +
            JSON.stringify(dd.unit ?? null) +
            ". Scale-spacing knobs MUST use `unit: \"%\"` and signed-delta semantics " +
            "(min/max in percent, e.g. -30..30 with step 5). " +
            "For absolute pixel adjustments to a single variable, omit `behavior` and use `unit: \"px\"`.",
        );
      }
    }
    knobs = rawKnobs as KnobDescriptor[];
  }

  // ── D2: body ↔ descriptor cross-check ──────────────────────────
  // Every `var(--…)` referenced in bodyMarkup must be covered by a
  // descriptor (so the user has a knob for it) OR be a scaffold token
  // (covered by the host's <style id="design-tokens"> block + spacing
  // scale behavior). Otherwise the agent has authored an orphan
  // variable — reachable in the rendered HTML but with no UI control.
  // Returns toolError so the agent regenerates with a complete
  // descriptor set.
  if (typeof bodyMarkup === "string" && bodyMarkup.length > 0) {
    const usedVars = extractCssVarsFromBody(bodyMarkup);
    const cover = descriptorsCoverVars(knobs ?? [], usedVars);
    if (!cover.ok) {
      const list = cover.missingDescriptorsFor.map((v) => "  - " + v).join("\n");
      return toolError(
        "Body uses CSS variables not covered by knob descriptors:\n" +
          list +
          "\nAdd a KnobDescriptor for each so the user can tweak it. Or remove the var() reference.",
      );
    }
  }

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
    schemaVersion: 2,
    draftId,
    parentDraftId,
    prompt,
    kind,
    createdAt: new Date().toISOString(),
  };
  if (knobs !== undefined) meta.knobs = knobs;
  if (knobsTitle !== undefined) meta.knobsTitle = knobsTitle;
  // Initial knobValues from descriptor.current.
  if (knobs && knobs.length > 0) {
    const initial: Record<string, string> = {};
    for (const d of knobs) {
      if (typeof d.current === "string") initial[d.key] = d.current;
    }
    if (Object.keys(initial).length > 0) meta.knobValues = initial;
  }
  const html = buildScaffold({ meta, designSystem: ds, bodyMarkup });
  // Snapshot the tokens block as authored. `applyKnobsToDraft` restores
  // this block before each apply so knob math always operates on the
  // baseline — successive applies don't compound and produce
  // ever-larger spacing tokens.
  const initialTokensBlock = extractTokensBlock(html);
  if (initialTokensBlock !== null) {
    meta.originalTokensBlock = initialTokensBlock;
  }
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
  const knobs = (args.knobs ?? {}) as Record<string, string>;
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
  // Read the persisted meta — `meta.knobs` (descriptor array) drives
  // the canvas sidebar. Legacy drafts (no descriptors) get the
  // historical 5-knob set so the UI keeps working unchanged.
  const meta = migrateMeta(readJsonSafe<unknown>(located.metaPath));
  const knobs = Array.isArray(meta.knobs) && meta.knobs.length > 0
    ? meta.knobs
    : LEGACY_DESCRIPTORS;
  const knobsTitle = meta.knobsTitle ?? "Design knobs";
  const knobValues = meta.knobValues ?? {};
  const revisions = listRevisionsForDraft(draftId);
  const payload: OpenCanvasResult = {
    draftId,
    iframeSrc: draftIframeUrl(located.slug, `${draftId}.html`),
    knobs,
    knobsTitle,
    knobValues,
    revisions,
  };
  // Only include the snapshot when the draft actually has one — legacy
  // drafts (no `originalTokensBlock` in meta) must omit the field.
  if (typeof meta.originalTokensBlock === "string") {
    payload.originalTokensBlock = meta.originalTokensBlock;
  }
  return toolResult(JSON.stringify(payload, null, 2));
};

const listRevisions: ToolHandler = async (args) => {
  const draftId = String(args.draftId ?? "");
  if (!draftId) return toolError("draftId is required");
  const located = locateDraft(draftId);
  if (!located) return toolError(`draft not found: ${draftId}`);
  const revisions = listRevisionsForDraft(draftId);
  return toolResult(JSON.stringify(revisions, null, 2));
};

const tools: Record<string, ToolHandler> = {
  "extract-design-system": extractDesignSystem,
  "generate-design": generateDesign,
  "tweak-design": tweakDesign,
  "package-handoff": packageHandoff,
  "list-drafts": listDrafts,
  "list-revisions": listRevisions,
  "get-draft": getDraft,
  "open-canvas": openCanvas,
  "clarify-brief": clarifyBrief,
};

createToolDispatcher(tools);

// Lifecycle: panel snapshot on run:complete is a v0.2 follow-up.

// Gate channel start so test imports don't open stdin. Mirrors
// ask-user/index.ts:306. No production code imports this module —
// `import.meta.main` is the real-world entry point.
if (import.meta.main) getChannel().start();

// ── Helpers ────────────────────────────────────────────────────────

async function applyKnobsToDraft(
  parentDraftId: string,
  values: Record<string, string>,
): Promise<ApplyKnobsResult> {
  const located = locateDraft(parentDraftId);
  if (!located) throw new Error(`draft not found: ${parentDraftId}`);
  const { slug, htmlPath, metaPath } = located;
  const html = readFileSync(htmlPath, "utf-8");
  const parentMeta = migrateMeta(readJsonSafe<unknown>(metaPath));
  if (!parentMeta.draftId) throw new Error("parent draft metadata missing");

  // Restore the original tokens block before applying knobs. Without
  // this restore step, each apply scales against the previous apply's
  // output — a 1.3× spacing factor applied twice yielded 1.69×, four
  // times yielded 2.86×, and the design "zoomed in" on every drag.
  // Snapshot is captured in `generateDesign`; legacy drafts without it
  // fall through to the existing in-place transform (no compounding
  // protection, but they were authored before this fix existed).
  const baselineHtml = parentMeta.originalTokensBlock
    ? replaceTokensBlock(html, parentMeta.originalTokensBlock)
    : html;

  // Descriptor path when meta.knobs is a non-empty array; legacy shim
  // when absent (preserves backwards compat for old drafts).
  let nextHtml: string;
  let changedVars: string[];
  if (Array.isArray(parentMeta.knobs) && parentMeta.knobs.length > 0) {
    const result = applyKnobsByDescriptors(baselineHtml, parentMeta.knobs, values);
    nextHtml = result.html;
    changedVars = result.changedVars;
  } else {
    const result = applyKnobs(baselineHtml, values as Knobs);
    nextHtml = result.html;
    changedVars = result.changedVars;
  }

  // Append a `randomShort()` suffix so two applies in the same
  // millisecond (common when the canvas debounces a slider drag) don't
  // collide on the revision file path.
  const draftId = `${parentDraftId}__r${Date.now().toString(36)}-${randomShort()}`;
  const nextMeta: DraftMeta = {
    schemaVersion: 2,
    draftId,
    parentDraftId,
    prompt: parentMeta.prompt,
    kind: parentMeta.kind,
    createdAt: new Date().toISOString(),
  };
  if (Array.isArray(parentMeta.knobs)) nextMeta.knobs = parentMeta.knobs;
  if (parentMeta.knobsTitle) nextMeta.knobsTitle = parentMeta.knobsTitle;
  // Carry the snapshot forward so a future apply against this revision
  // (or against the overwritten parent — same content) still has the
  // baseline available.
  if (parentMeta.originalTokensBlock) {
    nextMeta.originalTokensBlock = parentMeta.originalTokensBlock;
  }
  nextMeta.knobValues = values;
  // Persist the diff so `list-revisions` can report it without
  // re-running knob math against the snapshot.
  if (changedVars.length > 0) nextMeta.changedVars = changedVars;

  const draftsDir = join(projectDir(slug), "drafts");
  const newHtmlPath = join(draftsDir, `${draftId}.html`);
  writeFileSync(newHtmlPath, nextHtml);
  writeFileSync(
    join(draftsDir, `${draftId}.meta.json`),
    JSON.stringify(nextMeta, null, 2) + "\n",
  );
  // Also overwrite the parent draft's HTML so the canvas iframe — which
  // points at `<parentDraftId>.html` — picks up the new tokens on reload.
  writeFileSync(htmlPath, nextHtml);

  // Surface the new tokens block in the response — frontend uses it to
  // render the diff banner without a second read.
  const tokensBlock = extractTokensBlock(nextHtml) ?? "";
  // Iframe URL points at the parent path because the parent file is
  // overwritten on every apply (iframe-stability invariant).
  const iframeSrc = draftIframeUrl(slug, `${parentDraftId}.html`);
  const revisions = listRevisionsForDraft(parentDraftId);
  return {
    draftId,
    parentDraftId,
    htmlPath: newHtmlPath,
    iframeSrc,
    changedVars,
    knobValues: values,
    tokensBlock,
    revisions,
  };
}

/** Walk a parent draft's directory and return its revision history,
 *  newest-first. The parent draft itself is included as the first
 *  entry (`isOriginal: true`); each `<parent>__r*` file becomes a
 *  Revision entry carrying the persisted `knobValues` and `changedVars`. */
function listRevisionsForDraft(parentDraftId: string): Revision[] {
  const located = locateDraft(parentDraftId);
  if (!located) return [];
  const draftsDir = join(projectDir(located.slug), "drafts");
  const out: Revision[] = [];
  const parentMeta = migrateMeta(readJsonSafe<unknown>(located.metaPath));
  out.push({
    revisionId: parentDraftId,
    parentDraftId,
    knobValues: parentMeta.knobValues ?? {},
    ...(parentMeta.changedVars ? { changedVars: parentMeta.changedVars } : {}),
    createdAt: parentMeta.createdAt,
    isOriginal: true,
  });
  const prefix = `${parentDraftId}__r`;
  let entries: string[];
  try {
    entries = readdirSync(draftsDir);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    if (!name.endsWith(".meta.json")) continue;
    const meta = migrateMeta(readJsonSafe<unknown>(join(draftsDir, name)));
    if (!meta.draftId) continue;
    out.push({
      revisionId: meta.draftId,
      parentDraftId,
      knobValues: meta.knobValues ?? {},
      ...(meta.changedVars ? { changedVars: meta.changedVars } : {}),
      createdAt: meta.createdAt,
      isOriginal: false,
    });
  }
  // Newest-first by createdAt (string ISO compare). Stable enough for
  // ISO-8601 timestamps; ties land in directory-order.
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
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

// ── D2: body ↔ descriptor cross-check helpers ──────────────────────
//
// `extractCssVarsFromBody` returns the set of every `var(--name)`
// reference in the body markup. `descriptorsCoverVars` checks that
// every used var is either declared by a knob descriptor or is a
// scaffold token (`--color-bg`/`--color-fg`/`--font-display`/etc.,
// always present in the host's <style id="design-tokens"> block) or
// is covered by the spacing/typography scale behavior (`--space-*` /
// `--font-size-*`).
//
// Exported via `_internals` so tests can call them directly without
// going through the full generateDesign flow.

export function extractCssVarsFromBody(body: string): Set<string> {
  const re = /var\(\s*(--[a-zA-Z0-9_-]+)/g;
  const found = new Set<string>();
  for (const m of body.matchAll(re)) found.add(m[1]!);
  return found;
}

// ── Prompt specificity analyzer ───────────────────────────────────
//
// Heuristic check used by `generateDesign` to refuse generation when
// the prompt is so vague that the agent must be fabricating answers.
// Counts four cheap signals: a tone keyword, a section keyword, a
// brand color hex / palette name, an audience keyword. Returns a
// `score` (0..4) and the detected signal labels for diagnostics.
// Pure — testable without I/O.

const TONE_KEYWORDS = [
  "modern", "playful", "corporate", "brutalist", "editorial",
  "retro-futuristic", "retro futuristic", "retro", "futuristic",
  "refined-minimal", "refined minimal", "minimalist", "minimal",
  "maximalist", "maximalism", "elegant", "luxurious", "industrial",
  "neon", "cyberpunk", "y2k", "hand-drawn", "sketchy",
];
const SECTION_KEYWORDS = [
  "hero", "features", "pricing", "testimonials", "cta",
  "footer", "faq", "about", "gallery", "contact", "navigation",
  "nav", "header", "team", "blog", "case studies", "stats",
];
const AUDIENCE_KEYWORDS = [
  "developer", "developers", "executive", "executives", "designer",
  "designers", "consumer", "consumers", "user", "users", "team",
  "teams", "founder", "founders", "startup", "enterprise",
  "marketer", "marketers", "investor", "investors", "agent",
  "agents", "engineer", "engineers", "operator", "operators",
  "creator", "creators",
];

export interface PromptSpecificity {
  score: number;
  signals: {
    tone: boolean;
    section: boolean;
    color: boolean;
    audience: boolean;
  };
}

export function analyzePromptSpecificity(prompt: string): PromptSpecificity {
  const lower = prompt.toLowerCase();
  const tone = TONE_KEYWORDS.some((k) => lower.includes(k));
  const section = SECTION_KEYWORDS.some((k) => lower.includes(k));
  const audience = AUDIENCE_KEYWORDS.some((k) => lower.includes(k));
  // Hex codes (#rgb / #rrggbb) OR named CSS colors that signal brand
  // intent (heuristic — we don't enumerate every CSS named color).
  const hex = /#[0-9a-fA-F]{3,8}\b/.test(prompt);
  const namedBrandColor =
    /\b(electric blue|navy|royal blue|forest green|emerald|crimson|magenta|teal|charcoal|coral|gold|silver|bronze)\b/i.test(
      prompt,
    );
  const color = hex || namedBrandColor;
  const score =
    Number(tone) + Number(section) + Number(audience) + Number(color);
  return { score, signals: { tone, section, color, audience } };
}

const SCAFFOLD_VARS: ReadonlySet<string> = new Set([
  // Always emitted by the scaffold's `<style id="design-tokens">` block;
  // tracking them is `extract-design-system`'s job, not the agent's.
  "--color-bg",
  "--color-fg",
  "--font-display",
  "--font-body",
  "--font-mono",
  "--space-unit",
]);

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function descriptorsCoverVars(
  descriptors: KnobDescriptor[],
  usedVars: Set<string>,
): { ok: boolean; missingDescriptorsFor: string[] } {
  const declared = new Set<string>();
  for (const d of descriptors) {
    declared.add(d.var ?? `--${kebab(d.key)}`);
  }
  const missing: string[] = [];
  for (const v of usedVars) {
    if (SCAFFOLD_VARS.has(v)) continue;
    if (declared.has(v)) continue;
    // Scale-spacing knobs cover every `--space-*` and `--font-size-*`
    // numerically — the agent doesn't need a per-step knob for each.
    if (v.startsWith("--space-") || v.startsWith("--font-size-")) continue;
    // Radius scale also folded in (scale-spacing also rescales radii).
    if (v.startsWith("--radius-")) continue;
    // Per-numbered neutral ramp tokens (`--color-neutral-1..N`) come
    // from `extract-design-system`, not from a per-step knob.
    if (/^--color-neutral-\d+$/.test(v)) continue;
    missing.push(v);
  }
  return { ok: missing.length === 0, missingDescriptorsFor: missing };
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

// ── Test seam ───────────────────────────────────────────────────────
//
// Mirrors ask-user's `_internals` export. Tests drive the gate handler
// directly and read the pending map without going through the real
// channel.

export const _internals = {
  pendingBriefAnswers,
  handleBriefAnswer,
  clarifyBrief,
  generateDesign,
  applyKnobsToDraft,
  openCanvas,
  listRevisions,
  listRevisionsForDraft,
  tweakDesign,
  tools,
  DEFAULT_BRIEF_TIMEOUT_MS,
  // D2 helpers exposed for direct testing.
  extractCssVarsFromBody,
  analyzePromptSpecificity,
  descriptorsCoverVars,
};
