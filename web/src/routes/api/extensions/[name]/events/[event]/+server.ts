import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { getBus, getExecutor } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { isRegisteredExtensionEvent } from "$server/runtime/sse-conversation-filter";
import { getConversation, getOrCreateExtServiceConversation } from "$server/db/queries/conversations";
import { getProjectByPath } from "$server/db/queries/projects";
import { getToolCallConversationById } from "$server/db/queries/tool-calls";
import { getExtensionByName } from "$server/db/queries/extensions";
import {
  addConversationExtensions,
  getConversationExtensionIds,
} from "$server/db/queries/conversation-extensions";
import { ExtensionRegistry } from "$server/extensions/registry";
import { ToolExecutor } from "$server/extensions/tool-executor";
import { getPermissionEngine } from "$server/extensions/permission-engine";
import { registerFireCallProvenance } from "$server/extensions/call-provenance";
import { handleAppendMessageRpc } from "$server/extensions/append-message-handler";
import { handleFinalizeToolCallRpc } from "$server/extensions/finalize-tool-call-handler";
import { getPageCache } from "$server/extensions/page-cache";
import type { ExtensionPermissions } from "$server/extensions/types";
import { RateLimiter } from "$lib/server/security/rate-limiter";
import { readManifestPages } from "$lib/server/hub-extension-pages";
import { logger } from "$server/logger";

const log = logger.child("ext-events");

// ── /api/extensions/[name]/events/[event] — Phase A2 generic event route ──
//
// Replaces every per-extension bespoke POST route (e.g.
// `/api/ask-user/answer`) for canvas-style cards that need to
// round-trip user input back into the extension subprocess. Same
// security model as the ask-user route, generalized:
//
//   1. `requireScope(locals, "chat")` — same scope used by every
//      conversation-affecting endpoint.
//   2. `requireAuth(locals)` — pulls the session user.
//   3. URL params validated against the manifest-name regex.
//   4. The event must be declared by the extension in its manifest's
//      `permissions.eventSubscriptions`, captured at registration time
//      via `registerExtensionEvent`. Unknown events → 404.
//   5. Authorization: the active user must own the request body's
//      `conversationId`. 404 (not 403) so an attacker can't enumerate
//      which conversations exist.
//
// Wire format (matches every existing direct-carrier event — see
// `docs/extensions/examples/ask-user/index.ts:204-211` for the
// canonical reference): the bus emits a flat object with `toolCallId`
// and `conversationId` as siblings of the user-defined event data.

// Boundary validation. `conversationId` is the host-authoritative
// identity field every extension event must carry; `toolCallId` is
// required for canvas-card events (the original shape) and `messageId`
// is required for messageToolbar contributions. Exactly one of the two
// must be present — `loose()` preserves any additional user-defined
// keys without coercion.
//
// Length budget: conversationId is a UUID (~36 chars). toolCallId is
// provider-shaped — Anthropic uses `toolu_<24>` (~30 chars), OpenAI
// uses the compound `call_<24>|fc_<48>` form (~80 chars). 256 leaves
// comfortable headroom for any future provider while still bounding
// the input for DoS protection. messageId is a UUID like
// conversationId, but we allow 256 too — symmetry, no code-path
// branch needed.
//
// `selection` and `content` are optional and only present on
// messageToolbar-originated events. Caps mirror the messages POST
// limits (4_000 for highlights — the LLM's context budget for a TTS
// pass, 100_000 for full-message body). Validation only applies when
// the field is supplied so canvas-card events that legitimately omit
// them aren't accidentally rejected.
const eventBodySchema = z
  .looseObject({
    conversationId: z.string().min(1).max(256),
    toolCallId: z.string().min(1).max(256).optional(),
    messageId: z.string().min(1).max(256).optional(),
    /**
     * Multi-select payload: bulk messageToolbar contributions submit
     * an array of message ids whose contents are concatenated by the
     * route. Capped at 50 to bound DoS surface — the bulk-copy UI's
     * own ergonomic ceiling is ~10-20 turns, so 50 leaves headroom.
     * Per-id length matches the `messageId` cap above (UUID + slack).
     */
    messageIds: z.array(z.string().min(1).max(256)).min(1).max(50).optional(),
    selection: z.string().max(4_000).nullable().optional(),
    content: z.string().max(100_000).optional(),
  })
  .refine(
    (v) =>
      typeof v.toolCallId === "string" ||
      typeof v.messageId === "string" ||
      (Array.isArray(v.messageIds) && v.messageIds.length > 0),
    { message: "Either toolCallId, messageId, or messageIds[] is required" },
  );

// ── Hub page actions (Extension Pages Hub §2.4) ───────────────────
//
// Discriminated sibling of the conversation-scoped shape: the Hub's
// action buttons POST `{source:"hub", pageId, payload?}` — no
// conversation exists. The manifest-event gate above the body parse
// applies identically; the branch additionally requires the page to be
// DECLARED in `manifest.pages` and rate-limits 10 actions/min/user.
// The subprocess receives the same `ezcorp/event/<ext>:<event>`
// notification shape `registerEventHandler`/`definePage` handle.

const HUB_PAGE_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HUB_PAYLOAD_MAX_BYTES = 2_048;

const hubEventBodySchema = z.object({
  source: z.literal("hub"),
  pageId: z.string().regex(HUB_PAGE_ID_REGEX),
  payload: z.record(z.string(), z.unknown()).optional(),
});

/** 10 hub actions per minute per user. Exported for test isolation. */
export const __hubActionRateLimiter = new RateLimiter(10, 60_000);

/**
 * Auto-release window for a hub event-fire's reverse-RPC provenance token
 * (4 h). A hub action can kick off a long pipeline segment (an ECF gate push
 * → agent dispatch → auto-fix rounds) whose reverse-RPCs land minutes-to-hours
 * after the fire. The old 2-min default reaped the token mid-run, so every
 * post-2-min host-mediated reverse-RPC failed `-32602`. 4 h dwarfs any
 * legitimate active segment (pipelines PARK before long CI waits) while
 * staying well under the 6 h tool-token TTL precedent.
 */
const HUB_EVENT_FIRE_TOKEN_MS = 4 * 60 * 60 * 1000;

// Mirrors `manifest.name` regex. We re-validate URL params in case the
// router accepted something the regex would reject (defense-in-depth).
const PARAM_REGEX = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

/**
 * Resolve the file-organizer quarantine TTL + size cap from its manifest
 * settings defaults (the route doesn't carry per-user settings; the
 * manifest declared defaults are the safe baseline used for new quarantine
 * entries' expiry + the size-cap prune). Falls back to 30d / 5GB.
 */
async function resolveFileOrganizerQuarantineSettings(
  manifest: unknown,
): Promise<{ quarantineTtlDays: number; quarantineCapGb: number }> {
  const settings = (manifest as { settings?: Record<string, { default?: unknown }> } | null | undefined)?.settings ?? {};
  const ttl = settings.quarantine_ttl_days?.default;
  const cap = settings.quarantine_cap_gb?.default;
  return {
    quarantineTtlDays: typeof ttl === "number" && Number.isFinite(ttl) ? ttl : 30,
    quarantineCapGb: typeof cap === "number" && Number.isFinite(cap) ? cap : 5,
  };
}

export const POST: RequestHandler = async ({ request, locals, params }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  // URL param shape — reject anything outside the manifest-name regex
  // before we touch the body. SvelteKit decodes `params.name` /
  // `params.event` for us; we validate post-decoding.
  const name = params.name;
  const event = params.event;
  if (!name || !PARAM_REGEX.test(name)) return errorJson(404, "Not found");
  if (!event || !PARAM_REGEX.test(event)) return errorJson(404, "Not found");

  // Manifest-clamp: the event MUST have been declared at extension
  // registration time. Cross-namespace forgery (POST to ext-A's route
  // claiming ext-B's event) is rejected here because the registry is
  // populated per-extension by the dispatcher.
  const fullEventName = `${name}:${event}`;
  if (!isRegisteredExtensionEvent(fullEventName)) {
    return errorJson(404, "Not found");
  }

  // Body. Strict at the known fields, passthrough on the rest so
  // extensions can ship arbitrary user-defined payloads without the
  // host having to know their shape.
  const raw = await request.json().catch(() => null);

  // ── Hub page action branch (Extension Pages Hub §2.4) ───────────
  if (raw != null && typeof raw === "object" && (raw as Record<string, unknown>).source === "hub") {
    const hubParsed = hubEventBodySchema.safeParse(raw);
    if (!hubParsed.success) return errorJson(400, "Invalid body");
    const { pageId, payload } = hubParsed.data;
    if (payload !== undefined && JSON.stringify(payload).length > HUB_PAYLOAD_MAX_BYTES) {
      return errorJson(400, "Invalid body");
    }

    const ext = await getExtensionByName(name);
    if (!ext?.enabled) return errorJson(404, "Not found");
    // Page must be DECLARED — a granted event alone doesn't expose a
    // hub surface (404, not 403: no declaration-enumeration oracle).
    if (!readManifestPages(ext.manifest).some((p) => p.id === pageId)) {
      return errorJson(404, "Not found");
    }

    const limit = __hubActionRateLimiter.check(`hub-events:${user.id}`);
    if (!limit.allowed) {
      return errorJson(
        429,
        "Too many actions — slow down",
        { retryAfter: limit.retryAfter },
        { "Retry-After": String(limit.retryAfter ?? 1) },
      );
    }

    // ── file-organizer in-process apply branch (architecture spine) ──
    //
    // Accept/Reject/restore/config-edits that touch HOST folders run
    // host-side here (raw node:fs + engine.authorize audit + realpath/
    // lstat guards), NOT in a subprocess action handler — the subprocess
    // fs grant is `$CWD`-only, so it cannot touch Desktop/Downloads. The
    // applier looks proposals up BY ID and CAS-checks status (double-
    // accept is a no-op); caller payload PATHS are never trusted. Mirrors
    // the existing append-message in-process host branch above. Pure-view
    // events (select-segment/page-window/focus) just invalidate the cache;
    // agent-driven events (classify-move/teach-rule/…) fall through to the
    // subprocess forward below.
    if (name === "file-organizer") {
      const { dispatchFileOrganizerEvent, IN_PROCESS_EVENTS } = await import(
        "$server/extensions/file-organizer-events"
      );
      if (IN_PROCESS_EVENTS.has(event)) {
        const { getProjectRoot } = await import("$server/extensions/bundled");
        const { join } = await import("node:path");
        const dataDir = join(getProjectRoot(), ".ezcorp", "extension-data", "file-organizer");
        const settings = await resolveFileOrganizerQuarantineSettings(ext.manifest);
        const result = await dispatchFileOrganizerEvent(event, payload, {
          dataDir,
          engine: getPermissionEngine(),
          extensionId: ext.id,
          userId: user.id,
          settings,
        });
        if (result.handled) {
          if (result.changed) getPageCache().invalidate(ext.id, pageId);
          return json({ ok: result.ok ?? true, message: result.message });
        }
        // handled:false ⇒ fall through to the subprocess forward.
      }
    }

    // Spawn + wire: `sendNotification` no-ops on a dead process, so a
    // failed spawn here must surface (the action would silently vanish).
    try {
      const registry = ExtensionRegistry.getInstance();
      const proc = await registry.getProcess(ext.id);
      const engine = getPermissionEngine();
      const wirer = new ToolExecutor(registry, engine, { bus: getBus() });
      // FULL runtime wiring — required, not optional: this wirer's
      // ensureSubprocessRpcWired REPLACES the subprocess's single request
      // handler, so leaving executor/spawnQuota unset here doesn't just
      // degrade THIS request — it breaks `ezcorp/spawn-assignment` for
      // every later reverse-RPC on the proc (e.g. a pipeline extension's
      // agent dispatch fails "Spawn path unavailable in this context"
      // after any Hub action re-wired the proc). Guarded: an executor-less
      // context (unit tests) keeps today's spawn-less wiring.
      try {
        const executor = getExecutor();
        wirer.setExecutor(executor);
        wirer.setSpawnQuota(executor.spawnQuota);
      } catch {
        /* executor not booted (test context) — spawn path stays unwired */
      }
      await wirer.ensureSubprocessRpcWired(ext.id, proc);

      // ── Gate-push service-conversation owner (ECF control plane, L1) ──
      //
      // A gate push carries `payload.projectRoot`. A push-fired agent spawn's
      // reverse-RPC must resolve to a REAL conversation that carries the
      // project's id (the spawn handler derives the parent project from the
      // conversation) AND has the extension wired — otherwise the spawn fails
      // `-32602 "Conversation scope unavailable"`. Resolve the (shape-
      // validated) root to a REGISTERED project (the host-side trust
      // boundary), then find-or-create the persistent per-(project, extension)
      // service conversation owned by the gate-key user and wire the extension
      // into it. FAIL-CLOSED: an unregistered root / any resolution error
      // leaves `conversationId: null` exactly as before, so the spawn keeps
      // rejecting — we NEVER borrow ambient scope. Plain hub button clicks
      // (no `projectRoot`) are unaffected.
      let serviceConversationId: string | null = null;
      const projectRoot =
        typeof payload?.projectRoot === "string" && payload.projectRoot.trim()
          ? payload.projectRoot
          : undefined;
      if (projectRoot) {
        try {
          const project = await getProjectByPath(projectRoot);
          if (project) {
            const serviceConv = await getOrCreateExtServiceConversation({
              extensionName: name,
              projectId: project.id,
              userId: user.id,
              title: `${name} gate — ${project.name}`,
            });
            // Wiring gate parity (spawn-assignment-handler.ts:212): the gate
            // extension must be wired into the service conversation. Idempotent.
            const alreadyWired = await getConversationExtensionIds(serviceConv.id);
            if (!alreadyWired.includes(ext.id)) {
              await addConversationExtensions(serviceConv.id, [{ extensionId: ext.id }]);
            }
            serviceConversationId = serviceConv.id;
          }
        } catch (err) {
          log.warn(
            "gate-push service-conversation resolution failed — failing closed to null scope (spawn will reject)",
            { extensionId: ext.id, name, error: err instanceof Error ? err.message : String(err) },
          );
        }
      }

      // Mint a per-fire reverse-RPC provenance token (onBehalfOf = the
      // clicking / gate-key user) and stamp it onto `_meta.ezCallId`, exactly
      // like the EventSubscriptionDispatcher does for background event fires.
      // Without it the subprocess handler runs with no ambient callId, so
      // EVERY downstream host-mediated reverse-RPC the action triggers
      // (fs.write, spawn, and any provenance-gated capability) fails `-32602`.
      // The `conversationId` is the resolved service conversation for a gate
      // push (so a push-fired spawn has a resolvable owner scope), else null.
      const ezCallId = registerFireCallProvenance({
        onBehalfOf: user.id,
        conversationId: serviceConversationId,
        runId: null,
        parentCallId: null,
        actorExtensionId: ext.id,
        kind: "event",
        ownerless: false,
      }, { autoReleaseMs: HUB_EVENT_FIRE_TOKEN_MS });
      proc.sendNotification(`ezcorp/event/${fullEventName}`, {
        source: "hub",
        pageId,
        userId: user.id,
        ...(payload !== undefined ? { payload } : {}),
        _meta: { ezCallId },
      });
    } catch (err) {
      log.warn("hub action subprocess dispatch failed", {
        extensionId: ext.id,
        name,
        event,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorJson(500, "Extension is unavailable");
    }

    // The action likely mutates page state — drop the cached tree so
    // the client's follow-up re-fetch (or the extension's own
    // pushPage) serves fresh content.
    getPageCache().invalidate(ext.id, pageId);

    return json({ ok: true });
  }

  const parsed = eventBodySchema.safeParse(raw);
  if (!parsed.success) return errorJson(400, "Invalid body");
  const { conversationId, toolCallId, ...userData } = parsed.data;

  // Authorization: the acting user must own the conversation. 404 (not
  // 403) — never leak the existence of conversations the user can't
  // see. Mirror `ask-user/answer/+server.ts:73-75`.
  const conv = await getConversation(conversationId);
  if (!conv || conv.userId !== user.id) {
    return errorJson(404, "Not found");
  }

  // Defense-in-depth: when toolCallId is supplied, bind it to
  // conversationId. Without this, a user who owns BOTH conv-A and
  // conv-B could POST to conv-A's route with conv-B's toolCallId and
  // trick an extension into resolving the wrong card. We accept
  // missing rows (canvas tools may persist after the subprocess
  // returns) but reject mismatches. [F2 from the Phase A security
  // review.] messageToolbar events legitimately omit toolCallId, so
  // we skip the check entirely in that branch.
  if (typeof toolCallId === "string") {
    const toolCall = await getToolCallConversationById(toolCallId);
    if (toolCall && toolCall.conversationId !== conversationId) {
      return errorJson(404, "Not found");
    }
  }

  // ── Auto-wire + spawn for messageToolbar events ─────────────────
  //
  // messageToolbar contributions are USER-facing UI affordances — the
  // icon is rendered on every chat row regardless of whether the
  // extension was previously wired into this conversation. Without
  // wiring, the EventSubscriptionDispatcher silently drops the event
  // (its `wired.has(extId)` gate fails) and the user sees nothing.
  //
  // Two things must be true before the bus emit:
  //   1. `conversation_extensions` has a row for (conv, ext) — so
  //      the dispatcher's wiring gate passes.
  //   2. The subprocess is running — so the dispatcher's
  //      `getProcessIfRunning` returns non-null. `persistent: false`
  //      extensions don't auto-spawn at boot; we have to nudge them.
  //
  // Discriminator: messageToolbar events carry `messageId` (single
  // row) or `messageIds[]` (multi-select bulk), and never a
  // `toolCallId`. Canvas-card events are the inverse. We only
  // auto-wire/spawn in the messageToolbar branch — leaving canvas-card
  // semantics untouched (those still require explicit wiring via
  // `!ext:NAME` mention or programmatic add).
  const messageIdsParsed = (parsed.data as { messageIds?: unknown }).messageIds;
  const isBulkMessageToolbarEvent =
    Array.isArray(messageIdsParsed) &&
    messageIdsParsed.length > 0 &&
    typeof toolCallId !== "string";
  const isSingleMessageToolbarEvent =
    typeof (parsed.data as { messageId?: unknown }).messageId === "string" &&
    typeof toolCallId !== "string" &&
    !isBulkMessageToolbarEvent;
  const isMessageToolbarEvent =
    isSingleMessageToolbarEvent || isBulkMessageToolbarEvent;

  if (isMessageToolbarEvent) {
    // ── Diagnostic instrumentation [kokoro-tts-flow] ────────────────
    // Step-by-step logs let the user see where the flow breaks
    // between click → 200 response → new turn rendering. Each stage
    // mirrors a `log.info` plus a push into `diagnostics.stages` so
    // the network-tab response body carries the same trail.
    const flowStartedAt = Date.now();
    const diagnostics: { stages: Array<Record<string, unknown>>; elapsedMs: number } = {
      stages: [],
      elapsedMs: 0,
    };
    const recordStage = (stage: string, data: Record<string, unknown>) => {
      const entry = { stage, t: Date.now() - flowStartedAt, ...data };
      diagnostics.stages.push(entry);
      log.info(`[kokoro-tts-flow][server] ${stage}`, entry);
    };

    const messageIdProbe = (parsed.data as { messageId?: unknown }).messageId as string | undefined;
    const messageIdsProbe = isBulkMessageToolbarEvent
      ? (messageIdsParsed as string[])
      : undefined;
    recordStage("[messageToolbar] received", {
      name,
      event,
      conversationId,
      messageId: messageIdProbe,
      messageIdsCount: messageIdsProbe?.length ?? 0,
      hasSelection: typeof userData.selection === "string" && userData.selection !== null,
      contentLength: typeof userData.content === "string" ? userData.content.length : 0,
      bulk: isBulkMessageToolbarEvent,
    });

    const ext = await getExtensionByName(name);
    const grantedProbe = (ext as { grantedPermissions?: ExtensionPermissions } | null)?.grantedPermissions;
    recordStage("[messageToolbar] extension lookup", {
      extId: ext?.id ?? null,
      enabled: ext?.enabled ?? false,
      hasAppendMessagesGrant: !!grantedProbe?.appendMessages,
    });
    if (!ext?.enabled) {
      log.warn("[kokoro-tts-flow][server] messageToolbar event for unknown/disabled extension", {
        name,
        event,
      });
      return errorJson(404, "Not found");
    }
    const wired = await getConversationExtensionIds(conversationId);
    const alreadyWired = wired.includes(ext.id);
    if (!alreadyWired) {
      await addConversationExtensions(conversationId, [{ extensionId: ext.id }]);
      log.info("[kokoro-tts-flow][server] auto-wired extension via messageToolbar click", {
        extensionId: ext.id,
        name,
        conversationId,
      });
    }
    recordStage("[messageToolbar] auto-wire", {
      alreadyWired,
      addedNow: !alreadyWired,
    });

    // ── Direct in-process append-message (bypasses subprocess) ──────
    //
    // We used to emit on the bus and rely on the
    // dispatcher → subprocess → reverse-RPC chain to call
    // `ezcorp/append-message`. That worked in tests but failed in
    // production for messageToolbar events because of multiple silent
    // failure points (subprocess spawn races, RPC handler wiring
    // lifecycle, dispatcher ordering, SDK shape mismatches). The
    // user-visible symptom: 200 response + click toast + nothing
    // else.
    //
    // For messageToolbar events the subprocess's only job is to
    // compute `text = (selection || content).slice(0, 4000)` and
    // call append-message with a `<name>-player` card type. That's
    // pure plumbing — pulling it inline is far more reliable AND
    // lets the user-facing flow always succeed when the route
    // returns 200. The card itself (kokoro-tts-player) still runs
    // in the browser; only the host-side bookkeeping moves.
    //
    // Phase 2 (future): generalize this with manifest-declared
    // `messageToolbar[i].action` fields (cardType, toolName,
    // contentTemplate) so other extensions can opt in. For now
    // every messageToolbar contribution gets the kokoro-tts shape.
    // Parent-message anchor:
    //   - Single mode: the row the user clicked.
    //   - Bulk mode:   the LAST id in messageIds[] — the natural anchor
    //     because the new extension turn appends below the most-recent
    //     selected reply, mirroring the visual order in the chat.
    const rawMessageIds = isBulkMessageToolbarEvent
      ? (messageIdsParsed as string[])
      : [(parsed.data as { messageId: string }).messageId];
    const messageId = rawMessageIds[rawMessageIds.length - 1] as string;
    const rawContent = typeof userData.content === "string" ? userData.content : "";
    const rawSelection = typeof userData.selection === "string" ? userData.selection : null;
    // `selection` is meaningful only for single-row clicks. Bulk mode
    // ignores any caller-supplied selection — the bulk button has no
    // single-row highlight semantics.
    const usedSelection =
      !isBulkMessageToolbarEvent &&
      rawSelection !== null &&
      rawSelection.trim().length > 0;
    const text = (usedSelection ? rawSelection.trim() : rawContent).slice(0, 4_000);
    const headerSubject = isBulkMessageToolbarEvent
      ? `${rawMessageIds.length} turns`
      : usedSelection
        ? "selection"
        : "message";
    const headerContent = `🔊 TTS of ${headerSubject} (${text.length} chars)`;

    const granted = (ext as { grantedPermissions?: ExtensionPermissions }).grantedPermissions;
    if (!granted?.appendMessages) {
      log.warn("[kokoro-tts-flow][server] messageToolbar event for extension without appendMessages grant", {
        extensionId: ext.id,
        name,
      });
      return errorJson(403, "Extension lacks appendMessages permission");
    }

    // Spawn + wire the subprocess so the BROWSER card's later
    // `*:save` callback can be handled. (For the speak event itself
    // we don't need the subprocess — the route does the work
    // directly below.) Failures here log but don't abort: the user
    // can still hear the audio, only the persist-on-reload step
    // would later fail.
    const registry = ExtensionRegistry.getInstance();
    const wireStartedAt = Date.now();
    let wireOk = true;
    let wireError: string | undefined;
    try {
      const proc = await registry.getProcess(ext.id);
      // PDP singleton — pre-initialized by the executor at boot. We
      // pass no deps so a stale `getBus()` ref here can't silently
      // lose an init race. Boot-order regressions surface as a clear
      // factory throw.
      const engine = getPermissionEngine();
      const wirer = new ToolExecutor(registry, engine, { bus: getBus() });
      // Same full-wiring requirement as the hub branch above — this
      // re-wire must not strip the spawn path from the proc's handler.
      try {
        const executor = getExecutor();
        wirer.setExecutor(executor);
        wirer.setSpawnQuota(executor.spawnQuota);
      } catch {
        /* executor not booted (test context) — spawn path stays unwired */
      }
      await wirer.ensureSubprocessRpcWired(ext.id, proc);
    } catch (err) {
      wireOk = false;
      wireError = err instanceof Error ? err.message : String(err);
      log.warn("[kokoro-tts-flow][server] subprocess spawn/wire failed for messageToolbar event (non-fatal)", {
        extensionId: ext.id,
        name,
        error: wireError,
      });
    }
    recordStage("[messageToolbar] subprocess wire", {
      ok: wireOk,
      error: wireError,
      durationMs: Date.now() - wireStartedAt,
    });

    recordStage("[messageToolbar] append-message call", {
      textLength: text.length,
      usedSelection,
      headerContent,
    });

    // Call append-message directly. This is the same handler the
    // subprocess would invoke via reverse-RPC — same security
    // ladder (permission check, wiring check, attachment
    // reattribution), same row shape.
    const rpcReq = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "ezcorp/append-message",
      params: {
        conversationId,
        parentMessageId: messageId,
        role: "extension",
        content: headerContent,
        excluded: true,
        toolCalls: [
          {
            name: `${name}.synthesize`,
            input: { text },
            cardType: `${name}-player`,
            status: "running",
          },
        ],
      },
    };
    const ctx = {
      conversationId,
      userId: user.id,
      grantedPermissions: granted,
      // Phase 54 SEC-06 (Claim-1 close-out) — wire the PDP singleton
      // so handleAppendMessageRpc takes the engine.authorize() path
      // (append-message-handler.ts:197) instead of the legacy boolean
      // fallback at line 213-215. The fallback silently bypassed:
      //   1. The audit row that PERM_ALLOWED writes (compliance gap).
      //   2. The always-allow scope ladder (sensitive-cap gate).
      //   3. The override lookup (per-conversation effective grants).
      //
      // getPermissionEngine() returns the boot-wired singleton; it
      // always succeeds in this code path because the engine is
      // initialized at boot BEFORE any HTTP route can fire. (The
      // wireOk=false branch at line 313-330 is about subprocess RPC
      // wiring, not engine initialization — those are independent.)
      //
      // See tasks/v1.3-security-review.md Claim 1 caveat,
      // .planning/phases/54-security-backbone-hardening-cc1-cc5-claim-1/54-03-PLAN.md
      engine: getPermissionEngine(),
    };
    const response = await handleAppendMessageRpc(ext.id, rpcReq, ctx);
    const respHasError = "error" in response && response.error;
    if (respHasError) {
      recordStage("[messageToolbar] append-message response", {
        ok: false,
        error: { code: response.error!.code, message: response.error!.message },
      });
      log.warn("[kokoro-tts-flow][server] append-message in-process call failed", {
        extensionId: ext.id,
        code: response.error!.code,
        message: response.error!.message,
      });
      return errorJson(500, response.error!.message);
    }

    const result = response.result as { messageId: string; toolCallIds: string[] };
    recordStage("[messageToolbar] append-message response", {
      ok: true,
      messageId: result.messageId,
      toolCallIds: result.toolCallIds,
    });

    // Notify the chat UI. The frontend's `ez:turn_saved` listener
    // recognises the synthetic `ext:` runId and calls
    // `loadMessages()` to fetch the new row + its tool-card.
    const runId = `ext:${ext.id}:${result.messageId}`;
    getBus().emit("run:turn_saved", {
      runId,
      conversationId,
      messageId: result.messageId,
      parentMessageId: messageId,
      content: headerContent,
      // Extension-authored turns are one-shot and route through
      // handleExtensionTurnSaved on the client, not the streaming
      // placeholder path.
      final: true,
    });
    recordStage("[messageToolbar] run:turn_saved emitted", {
      runId,
      messageId: result.messageId,
      conversationId,
    });

    diagnostics.elapsedMs = Date.now() - flowStartedAt;
    return json({
      ok: true,
      messageId: result.messageId,
      toolCallIds: result.toolCallIds,
      diagnostics,
    });
  }

  // ── Save-event short-circuit (e.g. `kokoro-tts:save`) ────────────
  //
  // The browser card POSTs `{toolCallId, attachmentId, messageId}`
  // when its async work (synth + upload) completes. Same in-process
  // shortcut: bypass the subprocess and call finalize-tool-call
  // directly. The handler enforces ownership (extensionId match),
  // so we don't widen the trust boundary.
  const userDataRecord = userData as Record<string, unknown>;
  const isSaveShape =
    typeof toolCallId === "string" &&
    typeof userDataRecord.attachmentId === "string";
  if (isSaveShape) {
    const ext = await getExtensionByName(name);
    if (!ext?.enabled) return errorJson(404, "Not found");
    const granted = (ext as { grantedPermissions?: ExtensionPermissions }).grantedPermissions;
    if (!granted?.appendMessages) {
      return errorJson(403, "Extension lacks appendMessages permission");
    }

    const finalizeReq = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "ezcorp/finalize-tool-call",
      params: {
        toolCallId,
        output: { attachmentId: userDataRecord.attachmentId },
        status: "complete",
      },
    };
    const finalizeCtx = {
      conversationId,
      userId: user.id,
      grantedPermissions: granted,
    };
    const finalizeResp = await handleFinalizeToolCallRpc(ext.id, finalizeReq, finalizeCtx);
    if ("error" in finalizeResp && finalizeResp.error) {
      log.warn("finalize-tool-call in-process call failed", {
        extensionId: ext.id,
        code: finalizeResp.error.code,
        message: finalizeResp.error.message,
      });
      return errorJson(500, finalizeResp.error.message);
    }
    return json({ ok: true });
  }

  // Default path (canvas-card events with toolCallId): emit on the
  // bus. The dispatcher fans out to subscribed extensions (gated on
  // `conversation_extensions` wiring + per-extension rate limit).
  // The SSE filter treats this event as a direct carrier because
  // `isRegisteredExtensionEvent` returned true.
  getBus().emit(fullEventName as never, {
    ...(typeof toolCallId === "string" ? { toolCallId } : {}),
    conversationId,
    ...userData,
  } as never);

  return json({ ok: true });
};
