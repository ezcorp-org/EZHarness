import { logger } from "../../logger";
import { getProject } from "../../db/queries/projects";

/** Subset of streamChat's options the prompt-building phase reads. */
export interface BuildPromptOptions {
  projectId?: string;
  /** Conversation id — used to look up extensions wired to this conversation
   *  so their declared `acceptedAttachmentMimes` extend the capability
   *  table. Optional: omitting it falls back to the static per-model
   *  capabilities, which is correct for replays / preview paths that don't
   *  have a persisted conversation. */
  conversationId?: string;
  /** Owning user of the active conversation. Required (alongside
   *  `projectId`) for `%[lesson:…]` expansion — `getLessonBySlug` enforces
   *  visibility precedence (user > project > global) keyed by both ids.
   *  Replays / preview paths that don't have a user context omit this and
   *  the lesson-expansion block silently no-ops. */
  ownerId?: string;
  provider?: string;
  model?: string;
  attachments?: import("../../chat/attachments/content-builder").StagedAttachment[];
  commandResolver?: import("../mention-wiring").CommandResolver;
}

export interface BuildPromptResult {
  /** Final text to feed `piAgent.prompt(...)`. */
  text: string;
  /** Image parts for the `piAgent.prompt(text, images)` overload. Empty
   *  when the model is text-only or the user attached no images. */
  images: import("@earendil-works/pi-ai").ImageContent[];
}

/**
 * Build the prompt body for `piAgent.prompt`. Independent, non-fatal
 * expansions — each wrapped so one failure can't 500 the chat turn:
 *   - EZ-action strip (`![EZ:name]` removed from the LLM-facing text)
 *   - slash-command expansion (rewrite `/[cmd:name]` → command body)
 *   - file-mention prepend (`@[file:…]` → system note listing the
 *     resolved paths so the agent knows which files were referenced)
 *   - feature-mention prepend (`$[feature:…]` → description + files)
 *   - workflow-mention prepend (`![workflow:…]` → description +
 *     `inputSchema`, so the model can compose a `run_workflow` call)
 *   - lesson-mention prepend (`%[lesson:…]` → title + body)
 *   - multi-modal attachment lift (image/text/pdf parts → either
 *     inlined into text, or split into the images return value)
 *
 * Every prepending pass parses the ORIGINAL `userMessage`, never the
 * partially-expanded `text` — expansion is literal, and re-parsing
 * expanded output for further sigils is the indirect prompt-injection
 * hole this ordering closes. Later passes prepend above earlier ones,
 * so the final order is lesson → workflow → feature → file → message.
 *
 * Pure function — no IO except the project lookup for file mentions.
 */
export async function buildPromptInput(
  userMessage: string,
  options: BuildPromptOptions,
): Promise<BuildPromptResult> {
  // EZ-action tokens (`![EZ:name]`) are stripped FIRST so subsequent
  // expansions (slash commands, file mentions, features, lessons) see
  // the same prose the LLM will. The token strip is literal — no
  // expansion, no recursion — and it runs before slash-command
  // expansion because EZ actions never produce prompt text (they're
  // side-channel side effects whose results render as separate cards
  // post-stream). The persisted message keeps the raw tokens; only
  // the LLM-facing variant has them removed. Mirrors the
  // `applyCommandExpansion` discipline: persisted text is faithful;
  // LLM input is the cleaned variant.
  let text = userMessage;
  // Strip variant — feeds slash-command expansion AND becomes the
  // baseline for all subsequent prepended-note expansions (file /
  // feature / lesson). Those passes parse the ORIGINAL `userMessage`
  // for THEIR tokens (which are kind-disjoint from EZ), but `text`
  // (the LLM-facing variant) must be the cleaned version so the LLM
  // never sees `![EZ:…]`.
  let strippedUserMessage = userMessage;
  {
    const { stripEzActionTokens } = await import("../mention-wiring");
    const { stripped } = stripEzActionTokens(userMessage);
    strippedUserMessage = stripped;
    text = stripped;
  }
  // Slash-command expansion runs against the (post-EZ-strip) text and
  // produces the text that goes to the LLM. The persisted message
  // (stored upstream) keeps the raw `/[cmd:name]` tokens so edit /
  // replay semantics remain stable. Expansion is literal — we do NOT
  // re-parse the expanded text for other mention kinds (see
  // expand-command-mentions.test.ts for the injection guards).
  if (options.commandResolver) {
    try {
      const { applyCommandExpansion } = await import("../mention-wiring");
      text = await applyCommandExpansion(strippedUserMessage, options.commandResolver);
    } catch { /* Slash-command expansion failure is non-fatal */ }
  }

  // Resolve @[file:…] mentions against the active project and prepend a
  // lazy system note so the agent knows which files the user referenced.
  // The agent can read them on demand via the readFile tool.
  if (options.projectId) {
    try {
      const { resolveFileMentions, formatFileMentionSystemNotes } = await import("../mention-wiring");
      const project = await getProject(options.projectId);
      const fileMentions = await resolveFileMentions(userMessage, project?.path);
      const note = formatFileMentionSystemNotes(fileMentions);
      if (note) text = `${note}\n\n${text}`;
    } catch { /* File mention resolution failure is non-fatal */ }
  }

  // Resolve $[feature:…] mentions against the active project's Feature
  // Index and prepend a system note per feature listing its description
  // + plain-text file paths. This runs in the SAME pass as @[file:…]
  // (both are project-scoped, both produce prepended system notes),
  // and like @[file:…] failures here are non-fatal — a missing feature
  // shouldn't 500 the chat turn. Files are emitted as plain text, NOT
  // `@[file:…]` tokens — no double-expansion (see design doc §4).
  if (options.projectId) {
    try {
      const { applyFeatureExpansion } = await import("../mention-wiring");
      const { getFeature } = await import("../../db/queries/features");
      const projectId = options.projectId;
      const note = await applyFeatureExpansion(userMessage, async (name) => {
        const feature = await getFeature(projectId, name);
        if (!feature) return null;
        return {
          description: feature.description,
          files: feature.files.map((f) => f.relpath),
        };
      });
      if (note) text = `${note}\n\n${text}`;
    } catch { /* Feature mention resolution failure is non-fatal */ }
  }

  // Resolve ![workflow:…] mentions against the merged (extension + YAML
  // + DB) workflow cache and prepend one system note per workflow so the
  // model knows it exists and what input it takes. The mention is a
  // REFERENCE, not a trigger — nothing runs here; execution is the
  // separate `run_workflow` tool.
  //
  // Unlike the file/feature/lesson passes this one is NOT project-gated:
  // `workflow_definitions` has no project column, so workflows are
  // global and a mention resolves the same way from any conversation.
  //
  // The cache lives in the web layer (`$lib/server/context`), which
  // `src/` may not import, so we reach it through the runtime registry.
  // `getWorkflowRuntime()` and `getWorkflows()` are BOTH called inside
  // the resolver, per lookup: `context.ts` REPLACES its workflows array
  // wholesale on every CRUD write, so hoisting either read out of the
  // resolver would risk pinning a stale list. A backend-only boot (CLI,
  // pre-web-init) has no registration and the resolver returns null —
  // i.e. the same silent no-op as an unknown name.
  //
  // ── REFERENCING IS DELIBERATELY UNFILTERED (decision, not oversight) ──
  //
  // This resolver runs NO authorization check. Any name in the merged
  // cache resolves for any caller, and the note carries the workflow's
  // description AND its `inputSchema`. `canRunWorkflow` is NOT consulted
  // here and must not be added without revisiting this decision.
  //
  // Enforcement is at the point of ACTION instead: `run_workflow` calls
  // `canRunWorkflow` and surfaces a denial as a visible error card
  // (`Workflow "x" is owned by another user`). That was judged better
  // than filtering here, where an unauthorized reference would silently
  // expand to nothing and be indistinguishable from a typo — the user
  // would get no feedback at all. `inputSchema` stays for the same
  // reason: without it the model cannot compose a run, so a reference the
  // user IS allowed to act on would be useless.
  //
  // Residual gap, accepted knowingly: a caller can read a workflow
  // description + input schema they could not run, and a `chat`-scoped
  // API key can therefore obtain metadata that `GET /api/workflows`
  // would refuse it (that route requires the `read` scope). Referencing
  // is a weaker gate than listing.
  //
  // Consequence for `mention-wiring.ts`: because descriptions reach the
  // model unfiltered by authz, the sanitisation + nonce fence in
  // `applyWorkflowExpansion` is the ONLY thing between an
  // attacker-controlled description and a forged instruction to call the
  // tool. Weakening it re-opens this path — see `sanitizeNoteValue`.
  try {
    const { applyWorkflowExpansion } = await import("../mention-wiring");
    const { getWorkflowRuntime } = await import("../workflow/runtime-registry");
    const note = await applyWorkflowExpansion(userMessage, async (name) => {
      const workflow = getWorkflowRuntime()?.getWorkflows().find((w) => w.name === name);
      if (!workflow) return null;
      return { description: workflow.description, inputSchema: workflow.inputSchema };
    });
    if (note) text = `${note}\n\n${text}`;
  } catch { /* Workflow mention resolution failure is non-fatal */ }

  // Resolve %[lesson:…] mentions against the lessons table. The resolver
  // delegates visibility precedence (user > project > global) to
  // `getLessonBySlug`; per-turn caps (5 expansions / 8 KB joined text) are
  // enforced inside `applyLessonExpansion`. `onFired` bumps fired_count +
  // last_fired_at on every successfully included lesson — fire-and-forget
  // so a slow UPDATE never blocks prompt build, and a thrown error is
  // logged but non-fatal (the lesson STILL surfaces in the prompt). This
  // block runs AFTER feature expansion so lesson notes end up at the TOP
  // of the final prompt — they're persistent guidance, while file/feature
  // notes are turn-specific context. Like every other expansion in this
  // function, exceptions are swallowed: a DB hiccup must not 500 chat.
  if (options.projectId && options.ownerId) {
    try {
      const { applyLessonExpansion } = await import("../mention-wiring");
      const { getLessonBySlug, incrementFiredCount } = await import("../../db/queries/lessons");
      const projectId = options.projectId;
      const ownerId = options.ownerId;
      const note = await applyLessonExpansion(
        userMessage,
        async (slug) => {
          const lesson = await getLessonBySlug(projectId, ownerId, slug);
          if (!lesson) return null;
          return { title: lesson.title, body: lesson.body, lessonId: lesson.id };
        },
        (lessonId) => {
          // Fire-and-forget — never await, never block the prompt build.
          incrementFiredCount(lessonId).catch((err) => {
            // debug, not warn — a missed counter bump is operational
            // telemetry (drives v3 ranking signals) but does not affect
            // prompt correctness, so it shouldn't surface as a warning
            // in normal log streams.
            logger.debug("incrementFiredCount failed", { lessonId, error: String(err) });
          });
        },
      );
      if (note) text = `${note}\n\n${text}`;
    } catch { /* Lesson mention resolution failure is non-fatal */ }
  }

  // Multi-modal attachments for the current turn: convert to pi-ai parts.
  // Images go through the prompt(text, images) overload; text/pdf content
  // is inlined into the prompt string. Incompatible attachments throw
  // UnsupportedAttachmentError, which the endpoint should have prevented —
  // if we reach here, the user provided a model that can't accept them and
  // we surface the error rather than silently dropping content.
  const images: import("@earendil-works/pi-ai").ImageContent[] = [];
  if (options.attachments && options.attachments.length > 0 && options.provider && options.model) {
    const { getCapabilitiesWithExtensions } = await import("../../providers/model-capabilities");
    const { buildUserContent } = await import("../../chat/attachments/content-builder");
    let extensionMimes: string[] = [];
    if (options.conversationId) {
      try {
        const { getConversationExtensionMimes } = await import("../../db/queries/conversation-extensions");
        extensionMimes = await getConversationExtensionMimes(options.conversationId);
      } catch { /* non-fatal: fall through with no extension overlay */ }
    }
    const caps = getCapabilitiesWithExtensions(options.provider, options.model, extensionMimes);
    const built = await buildUserContent(text, options.attachments, caps);
    if (Array.isArray(built)) {
      const textBits: string[] = [];
      for (const part of built) {
        if (part.type === "text") textBits.push(part.text);
        else if (part.type === "image") images.push(part);
      }
      text = textBits.join("\n\n");
    }
  }

  return { text, images };
}
