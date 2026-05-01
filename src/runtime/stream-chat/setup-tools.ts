import type { AgentTool } from "@mariozechner/pi-agent-core";
import { logger } from "../../logger";
import { getProject } from "../../db/queries/projects";
import { resolveModel } from "../../providers/router";
import { getCredential } from "../../providers/credentials";
import { extensionToAgentTool, ToolExecutor } from "../../extensions/tool-executor";
import { ExtensionRegistry } from "../../extensions/registry";
import type { AgentRun, TeamMember, TeamMemberOverrides, TeamToolScope } from "../../types";
import type { StreamChatContext } from "./context";
import type { StreamChatHost, PendingPermissionInfo } from "./host";

const log = logger.child("executor.streamChat.setup");

/**
 * Scratch fields stashed on the AgentRun by the orchestration tool-loader
 * (setup-tools.ts 2d) and consumed by {@link applyAutoSpinUp} after the
 * Promise.all completes. All optional — only set when the agent config /
 * mention resolution actually produces a team or sub-agent list.
 *
 * Exported so `auto-spin-up.ts` can re-use the cast without redeclaring
 * the field shape. Replaces the `(run as any)._field` pattern that used
 * to hide the whole schema in inline casts.
 *
 * These fields are deleted by auto-spin-up in the same turn, so they
 * never get persisted to the DB row.
 */
export interface RunOrchestrationMeta {
  _teamConfig?: { name: string; prompt: string; autoSpinUp?: boolean };
  _memberOverrides?: Map<string, TeamMemberOverrides>;
  _subAgentMembers?: TeamMember[];
  _teamToolScope?: TeamToolScope;
  _mentionedAgents?: Array<{ id: string; name: string; description: string }>;
  _pendingAutoSpinUp?: boolean;
}

/** Narrow `AgentRun` alias that exposes the orchestration scratch fields.
 *  Cast the run to this type when reading/writing `_*` fields so the
 *  compiler catches typos and renames. */
export type OrchestratedRun = AgentRun & RunOrchestrationMeta;

/** Subset of streamChat's options the setup-tools phase reads. */
export interface SetupToolsOptions {
  projectId?: string;
  parentMessageId?: string;
  agentConfigId?: string;
  permissionMode?: import("../tools/types").PermissionMode;
  modeId?: string;
  orchestrationDepth?: number;
  toolRestriction?: "all" | "read-only" | "none";
  allowedTools?: string[];
  deniedTools?: string[];
  memberOverrides?: Map<string, import("../../types").TeamMemberOverrides>;
  subAgentMembers?: import("../../types").TeamMember[];
  attachments?: import("../../chat/attachments/content-builder").StagedAttachment[];
  provider?: string;
  model?: string;
  /** Phase 48: Ez panel page-context payload. Captured client-side per
   *  turn (route metadata + opt-in `<EzContext>` data + form ids) and
   *  forwarded by the messages endpoint. setup-tools serializes this
   *  into a `<page_context>` block appended to ctx.system for Ez-mode
   *  turns ONLY. The Ez persona prompt looks for that tag explicitly
   *  to distinguish instrumented vs non-instrumented pages. Permissive
   *  shape (`unknown`) — schema validation lives at the route layer.
   *  Ignored on non-Ez turns even if a client manages to inject one. */
  ezContext?: unknown;
}

/** Subset of the conversation row the setup-tools phase reads — the
 *  CURRENT-TURN model + provider take precedence over these fallbacks
 *  (the UI's per-turn picker doesn't update the conversation row). */
export interface SetupToolsConvRecord {
  userId?: string | null;
  agentConfigId?: string | null;
  model?: string | null;
  provider?: string | null;
  /** Phase 48: 'ez' marks the conversation as the user's dedicated Ez
   *  concierge thread. setup-tools branches on this to wire the seven
   *  Ez tools (propose_*, summarize_conversation, find_agents,
   *  fill_form, navigate_to) BEFORE the allowlist filter runs. */
  kind?: "regular" | "ez" | null;
}

export interface SetupToolsResult {
  resolved: Awaited<ReturnType<typeof resolveModel>>;
  initialCred: Awaited<ReturnType<typeof getCredential>>;
}

/**
 * Drive the parallel "memory injection + tool loading + model resolution"
 * setup phase. Mutates `ctx.system`, `ctx.agentTools`,
 * `ctx.toolAbortControllers`, `ctx.builtinToolDefsMap`, `ctx.unsubModeChange`,
 * and stashes orchestration metadata on `run` (the legacy `_mentionedAgents`,
 * `_teamConfig`, `_memberOverrides`, etc. fields the post-Promise.all auto-spin-up
 * block reads).
 *
 * Returns the resolved model + initial credential so the caller can build
 * the pi-agent. The function is structured as one big `Promise.all` of three
 * IIFEs (memory/KB injection, tool loading, model resolution) — the same
 * shape as the original inline block — so timing, ordering, and which paths
 * race remain identical.
 */
export async function setupTools(
  ctx: StreamChatContext,
  host: StreamChatHost,
  conversationId: string,
  userMessage: string,
  options: SetupToolsOptions,
  allPastAttachments: import("../../chat/attachments/content-builder").StagedAttachment[],
  convRecord: SetupToolsConvRecord | null,
  credentialConversationId: string,
): Promise<SetupToolsResult> {
  const { run } = ctx;
  // Typed view onto the orchestration scratch fields set by tool-loader 2d
  // and consumed by auto-spin-up. Replaces the inline `(run as any)` casts
  // — same underlying object, but the compiler now knows the field shapes.
  const orchRun = run as OrchestratedRun;

  // ── Parallel setup: memory/KB, tools, model resolution all run concurrently ──
  host.bus.emit("run:status", { runId: run.id, status: "Preparing..." });

  // Build the attachment-handle resolver for this turn. The content-builder
  // emits `ez-attachment://<id>` handles in the LLM-visible text; when the
  // LLM echoes them back in tool args, this resolver substitutes the real
  // `data:<mime>;base64,<bytes>` URI before the extension subprocess sees
  // them. Includes BOTH this turn's staged attachments AND all attachments
  // from earlier user messages in the branch, so handles emitted on any
  // prior turn remain resolvable in a later tool call.
  const attachmentArgsResolver = await (async () => {
    const currentTurn = options.attachments ?? [];
    if (currentTurn.length === 0 && allPastAttachments.length === 0) return null;
    const { buildAttachmentHandleResolver, toResolvableAttachments } =
      await import("../../chat/attachments/handle-resolver");
    // Dedupe by id so we don't double-read bytes when the current turn's
    // attachment is also present in history (can happen if the caller
    // resends the same files verbatim).
    const byId = new Map<string, typeof allPastAttachments[number]>();
    for (const a of allPastAttachments) byId.set(a.id, a);
    for (const a of currentTurn) byId.set(a.id, a);
    return buildAttachmentHandleResolver(toResolvableAttachments(Array.from(byId.values())));
  })();

  const [, , resolvedModel] = await Promise.all([
    // 1. Memory/KB injection (non-fatal) — skip entirely if project has no data
    (async () => {
      if (!options.projectId) return;
      try {
        // Fast-path: skip expensive embedding if project has no memories or KB
        let hasMem = true, hasKB = true; // default to true (assume data exists) if check fails
        try {
          const [{ hasMemories }, { hasKBChunks }] = await Promise.all([
            import("../../db/queries/memories"),
            import("../../db/queries/knowledge-base"),
          ]);
          [hasMem, hasKB] = await Promise.all([
            hasMemories(options.projectId!),
            hasKBChunks(options.projectId!),
          ]);
        } catch { /* check failed — proceed with full pipeline */ }
        if (!hasMem && !hasKB) return; // No data to search — skip embedding entirely

        const { generateEmbedding } = await import("../../memory/embeddings");
        const queryEmbedding = await generateEmbedding(userMessage, (status) => {
          host.bus.emit("run:status", { runId: run.id, status });
        });
        const [injectionModule, kbChunks] = await Promise.all([
          import("../../memory/injection"),
          (async () => {
            if (!hasKB) return undefined;
            try {
              const { searchKBChunksForQuery } = await import("../../memory/retrieval");
              return await searchKBChunksForQuery(userMessage, queryEmbedding, options.projectId!, 5);
            } catch { return undefined; }
          })(),
        ]);
        const injection = await injectionModule.buildSystemPromptWithMemories(ctx.system, userMessage, options.projectId!, { kbChunks, queryEmbedding });
        ctx.system = injection.systemPrompt;
        if (injection.memoriesUsed.length > 0) run.memoriesUsed = injection.memoriesUsed;
      } catch {
        // run:status carries extra `degraded` + `message` fields when
        // surfacing a soft-failure (not defined on the AgentEvents shape,
        // which only requires runId + status); forwarded verbatim by the
        // bus subscribers. Cast through `unknown` to the event shape.
        host.bus.emit("run:status", {
          runId: run.id, status: "memory_unavailable", degraded: true,
          message: "Memory is currently unavailable. Responses won't include past context.",
        } as unknown as { runId: string; status: string });
      }
    })(),

    // 2. Tool loading (builtin + extensions + mentions — all non-fatal)
    (async () => {
      // 2a. Built-in project file tools
      if (options.projectId) {
        try {
          const project = await getProject(options.projectId);
          if (project?.path) {
            const { getBuiltinToolDefs } = await import("../tools");
            const { needsApproval, getPermissionMode, createPermissionGate } = await import("../tools/permissions");
            const toolDefs = getBuiltinToolDefs(project.path);
            for (const def of toolDefs) ctx.builtinToolDefsMap.set(def.name, def);
            const projectId = options.projectId;

            // Bus-driven override — only set when user explicitly switches mode mid-run
            let busOverrideMode: import("../tools/permissions").PermissionMode | undefined;
            // Pre-cache permission mode to avoid DB hit on every tool call
            getPermissionMode(projectId).then(mode => {
              if (!busOverrideMode) busOverrideMode = mode;
            }).catch(() => {});
            ctx.unsubModeChange = host.bus.on("tool:permission_mode_change", (data) => {
              if (data.conversationId === conversationId) {
                busOverrideMode = data.mode as import("../tools/permissions").PermissionMode;
              }
            });

            const wrappedTools: AgentTool[] = toolDefs.map((def) => ({
              name: def.name, label: def.label, description: def.description, parameters: def.parameters,
              execute: async (toolCallId, params, signal, onUpdate) => {
                const toolController = new AbortController();
                ctx.toolAbortControllers.set(toolCallId, toolController);
                const combinedSignal = signal ? AbortSignal.any([signal, toolController.signal]) : toolController.signal;
                try {
                  const permissionMode = options.permissionMode ?? busOverrideMode ?? await getPermissionMode(projectId);
                  if (needsApproval(def.category, permissionMode)) {
                    const permInfo: PendingPermissionInfo = {
                      conversationId, toolCallId, toolName: def.name,
                      input: params, cardType: def.cardType, category: def.category,
                    };
                    host.pendingPermissions.set(toolCallId, permInfo);
                    host.bus.emit("tool:permission_request", {
                      conversationId, toolCallId, toolName: def.name,
                      input: params, cardType: def.cardType, category: def.category,
                    });
                    try { await createPermissionGate(toolCallId, conversationId); }
                    catch { return { content: [{ type: "text" as const, text: "Permission denied by user" }], details: { isError: true } }; }
                    finally { host.pendingPermissions.delete(toolCallId); }
                  }
                  return await def.execute(toolCallId, params, combinedSignal, onUpdate);
                } finally { ctx.toolAbortControllers.delete(toolCallId); }
              },
            }));
            ctx.agentTools.push(...wrappedTools);
          }
        } catch { /* Built-in tool loading failure is non-fatal */ }
      }

      // 2b. Extension tools
      if (options.agentConfigId) {
        try {
          const registry = ExtensionRegistry.getInstance();
          const extTools = await registry.getToolsForAgent(options.agentConfigId);
          if (extTools.length > 0) {
            const toolExec = new ToolExecutor(registry, { bus: host.bus });
            if (host.stateMediator) toolExec.setStateMediator(host.stateMediator);
            toolExec.setExecutor(host.executor);
            toolExec.setSpawnQuota(host.spawnQuota);
            if (attachmentArgsResolver) toolExec.setArgsResolver(attachmentArgsResolver);
            // Thread the conversation owner's id into the tool executor
            // so bundled extensions (ai-kit) can act on-behalf-of the
            // real user when they call back into this server.
            if (convRecord?.userId) toolExec.setCurrentUserId(convRecord.userId);
            // Thread the model + provider so sibling chats spawned by
            // ai-kit inherit them. PREFER `options.model` (the model
            // the user picked in the UI for THIS turn) over
            // `convRecord.model` (the conversation's stored default at
            // creation time). The UI's model picker updates per-turn,
            // not on the conversation row, so falling back to
            // convRecord would send stale values.
            toolExec.setCurrentModel(options.model ?? convRecord?.model);
            toolExec.setCurrentProvider(options.provider ?? convRecord?.provider);
            toolExec.setCurrentAgentConfigId(options.agentConfigId ?? convRecord?.agentConfigId);
            try {
              const { checkSensitiveConfirmation } = await import("../../extensions/permissions");
              toolExec.setPermissionChecker(async (extensionId, _toolName, _input) => {
                const shellCheck = await checkSensitiveConfirmation(extensionId, "shell");
                const fsCheck = await checkSensitiveConfirmation(extensionId, "filesystem");
                return shellCheck === "allowed" && fsCheck === "allowed";
              });
            } catch { /* permissions.ts not available yet */ }
            ctx.agentTools = extTools.map((t) => extensionToAgentTool(
              { name: t.name, description: t.description, inputSchema: t.inputSchema },
              toolExec, conversationId, run.id,
            ));
          }
        } catch { /* Extension loading failure is non-fatal */ }
      }

      // 2c. Mentioned extensions
      try {
        const { wireMentionedExtensions } = await import("../mention-wiring");
        const { getConversationExtensionIds } = await import("../../db/queries/conversation-extensions");
        // Phase 3 intended task-tracking as wire-on-first-use, but its
        // `/api/tool-invoke` hook only fires for MANUAL UI tool clicks —
        // LLM-driven tool calls go through the in-process agentTools
        // pipeline instead. Without this the LLM never sees task_plan /
        // task_add / task_list and can't plan tasks when asked to. Match
        // the orchestration extension's auto-wire pattern below so this
        // path picks up the task tools for every turn.
        try {
          const { ensureTaskTrackingWired } = await import("../task-tracking-host");
          await ensureTaskTrackingWired(conversationId);
        } catch (taskWireErr) {
          log.warn("Task-tracking wire failed — task tools unavailable this turn", {
            error: String(taskWireErr),
          });
        }
        // ask-user: auto-wire-every-turn so the LLM can ask the user a
        // question on any conversation. Wire BEFORE the generic
        // convExtIds loop below so we can pass `invocationMetadata: {
        // conversationId }` — the loop omits invocationMetadata, and
        // the handler needs it. The dedup check at the loop (`some(at
        // => at.name === t.name)`) prevents the loop from double-wiring
        // ask_user_question without the metadata.
        try {
          const { ensureAskUserWired, wireAskUserToolForTurn } = await import("../ask-user-host");
          const wired = await ensureAskUserWired(conversationId);
          if (wired) {
            await wireAskUserToolForTurn({
              agentTools: ctx.agentTools,
              conversationId,
              runId: run.id,
              registry: ExtensionRegistry.getInstance(),
              bus: host.bus,
              userId: convRecord?.userId ?? undefined,
            });
          }
        } catch (askUserWireErr) {
          log.warn("ask-user wire failed — ask_user_question unavailable this turn", {
            error: String(askUserWireErr),
          });
        }

        // Phase 48: Ez concierge tools. Mirrors the ask-user wire-pattern —
        // auto-wire on every turn before the allowlist filter runs, but
        // ONLY for `kind='ez'` conversations. The seven Ez tool names must
        // be in `ctx.agentTools` BEFORE `applyToolFilters` runs against
        // `mode.allowedTools = [...ezNames]` (executor.ts:432-435); without
        // this branch the filter would strip every project-rooted tool
        // and the Ez turn would be left with only orchestration tools,
        // making propose_*/summarize/find/fill/navigate unreachable.
        // The wire is fail-soft: any error logs + falls through, the LLM
        // sees an empty Ez toolset rather than a hard 500.
        if (convRecord?.kind === "ez") {
          try {
            const { wireEzToolsForTurn } = await import("../ez-tools-host");
            // userId is REQUIRED for Ez tools (propose_* persists
            // user-owned drafts, find_agents scopes by user). Skip the
            // wire if it's missing — log explicitly so a misconfigured
            // Ez conversation surfaces in the operator dashboard.
            if (!convRecord.userId) {
              log.warn(
                "Ez wire skipped — convRecord.userId missing on a kind='ez' row. " +
                "Drafts could not be attributed; the Ez tools have been omitted for this turn.",
                { conversationId },
              );
            } else {
              // Phase 48 defense-in-depth: extract the conversation id
              // the user is currently viewing from the page-context
              // payload so summarize_conversation can fall back to it
              // when the LLM fails to lift the id from
              // JSON-in-system-prompt. The serializer at
              // `web/src/lib/ez/context-serializer.ts` already populates
              // `route.conversationId` from the URL params (`convId`
              // first, then `conversationId`); we read defensively in
              // case a future serializer change moves the field — the
              // tool simply degrades to "conversationId is required"
              // when the extraction yields nothing.
              const ezRoute = (options.ezContext as { route?: { conversationId?: unknown } } | null | undefined)?.route;
              const defaultConversationId =
                typeof ezRoute?.conversationId === "string" && ezRoute.conversationId.length > 0
                  ? ezRoute.conversationId
                  : undefined;

              wireEzToolsForTurn({
                agentTools: ctx.agentTools,
                builtinToolDefsMap: ctx.builtinToolDefsMap,
                conversationId,
                userId: convRecord.userId,
                bus: host.bus,
                // Thread the per-turn provider/model the user picked in
                // the UI (options.*) — falling back to the conversation's
                // stored default — so summarize_conversation uses the
                // SAME model as the surrounding Ez chat. Without this
                // the tool's defaultSummarize would fall through to the
                // Anthropic-first default tier and throw "no Anthropic
                // credentials" when the user picked OpenAI. Mirrors the
                // toolExec.setCurrentModel/setCurrentProvider pattern
                // used a few blocks above for ai-kit sibling chats.
                provider: options.provider ?? convRecord.provider,
                model: options.model ?? convRecord.model,
                defaultConversationId,
              });
            }
          } catch (ezWireErr) {
            log.warn("Ez tools wire failed — ez tools unavailable this turn", {
              error: String(ezWireErr),
            });
          }

          // NOTE: page_context append for Ez turns is DEFERRED until
          // after the surrounding Promise.all returns (see the post-
          // Promise.all block near the bottom of this function). The
          // memory-injection branch (1) snapshots ctx.system BEFORE its
          // `await generateEmbedding(...)` and writes back the snapshot
          // + memory block at the end — clobbering anything else that
          // mutated ctx.system during the await. Appending here
          // produced an intermittent silent loss of `<page_context>`
          // depending on whether memory injection happened to win the
          // race. Same pattern as the orchestrator-prompt deferral
          // (see comment at "system prompt injection is deferred"
          // below) — fixed identically.
        }
        await wireMentionedExtensions(conversationId, userMessage, options.parentMessageId ?? run.id);
        const convExtIds = await getConversationExtensionIds(conversationId);
        if (convExtIds.length > 0) {
          const registry = ExtensionRegistry.getInstance();
          const toolExec = new ToolExecutor(registry, { bus: host.bus });
          if (host.stateMediator) toolExec.setStateMediator(host.stateMediator);
          toolExec.setExecutor(host.executor);
          toolExec.setSpawnQuota(host.spawnQuota);
          if (attachmentArgsResolver) toolExec.setArgsResolver(attachmentArgsResolver);
          // See comment above — ai-kit and friends need the conversation
          // owner's id to create rows on their behalf, plus the CURRENT
          // TURN's model + provider (options.*, falling back to the
          // conversation default) so sibling chats inherit the user's
          // active selection.
          if (convRecord?.userId) toolExec.setCurrentUserId(convRecord.userId);
          toolExec.setCurrentModel(options.model ?? convRecord?.model);
          toolExec.setCurrentProvider(options.provider ?? convRecord?.provider);
          toolExec.setCurrentAgentConfigId(options.agentConfigId ?? convRecord?.agentConfigId);
          for (const extId of convExtIds) {
            for (const t of registry.getToolsForExtension(extId)) {
              if (!ctx.agentTools.some(at => at.name === t.name)) {
                ctx.agentTools.push(extensionToAgentTool(
                  { name: t.name, description: t.description, inputSchema: t.inputSchema },
                  toolExec, conversationId, run.id,
                ));
              }
            }
          }
        }
      } catch { /* Dynamic tool wiring failure is non-fatal */ }

      // 2c-mode. Mode-attached extensions: wire any extensions declared
      // by the active mode (mode.extensionIds) the same way as
      // mention-wired extensions above. Without this, the extensionIds
      // → allowlist filter at executor.ts (mode-restriction block)
      // intersects against tools that were never injected, leaving the
      // LLM with only orchestration tools. Lives OUTSIDE the 2c outer
      // try so an earlier wire failure (ask-user / ez / mention-wiring)
      // doesn't skip the mode wire — those steps share a non-fatal
      // catch but their failure shouldn't strip the user's mode tools.
      // Additive: dedupe by tool name against tools already added by 2b
      // (agent-config) or 2c (mentions / auto-wired hosts).
      if (options.modeId) {
        try {
          const { getMode } = await import("../../db/queries/modes");
          const mode = await getMode(options.modeId);
          const modeExtIds = mode?.extensionIds ?? [];
          log.info("mode-extensions wire", {
            subsystem: "setup-tools.modeExtWire",
            modeId: options.modeId,
            modeFound: !!mode,
            modeExtIds,
            modeExtIdCount: modeExtIds.length,
          });
          if (modeExtIds.length > 0) {
            const registry = ExtensionRegistry.getInstance();
            const toolExec = new ToolExecutor(registry, { bus: host.bus });
            if (host.stateMediator) toolExec.setStateMediator(host.stateMediator);
            toolExec.setExecutor(host.executor);
            toolExec.setSpawnQuota(host.spawnQuota);
            if (attachmentArgsResolver) toolExec.setArgsResolver(attachmentArgsResolver);
            if (convRecord?.userId) toolExec.setCurrentUserId(convRecord.userId);
            toolExec.setCurrentModel(options.model ?? convRecord?.model);
            toolExec.setCurrentProvider(options.provider ?? convRecord?.provider);
            toolExec.setCurrentAgentConfigId(options.agentConfigId ?? convRecord?.agentConfigId);
            for (const extId of modeExtIds) {
              const extTools = registry.getToolsForExtension(extId);
              log.info("mode-extensions resolveExt", {
                subsystem: "setup-tools.modeExtWire",
                extId,
                toolCount: extTools.length,
                toolNames: extTools.map(t => t.name),
              });
              for (const t of extTools) {
                if (!ctx.agentTools.some(at => at.name === t.name)) {
                  ctx.agentTools.push(extensionToAgentTool(
                    { name: t.name, description: t.description, inputSchema: t.inputSchema },
                    toolExec, conversationId, run.id,
                  ));
                }
              }
            }
            log.info("mode-extensions wired", {
              subsystem: "setup-tools.modeExtWire",
              finalAgentToolCount: ctx.agentTools.length,
              finalAgentToolNames: ctx.agentTools.map(t => t.name),
            });
          }
        } catch (err) {
          log.warn("mode-extensions wire failed", {
            subsystem: "setup-tools.modeExtWire",
            error: String(err),
          });
        }
      }

      // 2d. Multi-agent orchestration: resolve mentions, auto-wire references, inject tools
      // NOTE: system prompt injection is deferred until after Promise.all to avoid race with memory injection
      try {
        const depth = options.orchestrationDepth ?? 0;
        const MAX_ORCHESTRATION_DEPTH = 3;

        if (depth < MAX_ORCHESTRATION_DEPTH && options.projectId) {
          const { resolveMentionedAgents, resolveMentionedTeams } = await import("../mention-wiring");
          const allAvailableAgents: Array<{ id: string; name: string; description: string }> = [];
          const seenIds = new Set<string>();

          // 2d-i. Resolve @agent mentions
          const mentionedAgents = await resolveMentionedAgents(userMessage);
          for (const a of mentionedAgents) {
            if (!seenIds.has(a.id)) { seenIds.add(a.id); allAvailableAgents.push(a); }
          }

          // 2d-ii. Resolve ![team:…] mentions → store team info for prompt injection
          // Only resolve team mentions at depth 0 — sub-conversations must NOT re-expand the
          // parent's team mention, otherwise auto-spin-up causes exponential recursive spawning
          // (each sub-agent sees ![team:...] in the task, resolves it, spins up all members again).
          const mentionedTeams = depth === 0
            ? await resolveMentionedTeams(userMessage)
            : [];
          for (const t of mentionedTeams) {
            for (const m of t.members) {
              if (!seenIds.has(m.id)) { seenIds.add(m.id); allAvailableAgents.push(m); }
            }
          }

          // 2d-iii. Auto-wire references.agents from agent config (teams & supervisor agents)
          // If subAgentMembers is provided (nested invocation), use it directly
          if (options.subAgentMembers?.length) {
            try {
              const { getAgentConfigsByIds } = await import("../../db/queries/agent-configs");
              // Single batched round trip for every sub-agent member id
              // (was N concurrent `getAgentConfig` calls — typically < 50
              // members per team, but each was its own SELECT). Walk the
              // member list in source order, consuming the Map.
              const memberIds = options.subAgentMembers.map((m) => m.agentConfigId);
              const memberById = await getAgentConfigsByIds(memberIds);
              for (const member of options.subAgentMembers) {
                if (seenIds.has(member.agentConfigId)) continue;
                const cfg = memberById.get(member.agentConfigId);
                if (cfg) {
                  seenIds.add(cfg.id);
                  allAvailableAgents.push({ id: cfg.id, name: cfg.name, description: cfg.description });
                } else {
                  log.warn(`Sub-agent member ${member.agentConfigId} not found in DB — skipped`);
                }
              }
            } catch { /* Sub-agent member wiring failure is non-fatal */ }
          } else if (options.agentConfigId) {
            try {
              const { getAgentConfig, getAgentConfigsByIds } = await import("../../db/queries/agent-configs");
              const config = await getAgentConfig(options.agentConfigId);
              const refs = config?.references as { agents?: string[]; extensions?: string[]; members?: import("../../types").TeamMember[]; autoSpinUp?: boolean; teamToolScope?: import("../../types").TeamToolScope } | null;
              if (refs?.agents?.length) {
                // Single batched round trip for the team's referenced
                // agents (was N concurrent `getAgentConfig` calls).
                const memberById = await getAgentConfigsByIds(refs.agents);
                for (const agentId of refs.agents) {
                  if (seenIds.has(agentId)) continue;
                  const member = memberById.get(agentId);
                  if (member) {
                    seenIds.add(member.id);
                    allAvailableAgents.push({ id: member.id, name: member.name, description: member.description });
                  }
                }
                // If config is a team, store for team prompt injection
                if (config?.category === "team" && mentionedTeams.length === 0) {
                  orchRun._teamConfig = { name: config.name, prompt: config.prompt, autoSpinUp: refs?.autoSpinUp ?? false };
                }
              }
              // Build memberOverrides from team config members
              if (refs?.members?.length) {
                const overridesMap = new Map<string, TeamMemberOverrides>();
                for (const m of refs.members) {
                  if (m.overrides) overridesMap.set(m.agentConfigId, m.overrides);
                }
                if (overridesMap.size > 0) {
                  orchRun._memberOverrides = overridesMap;
                  orchRun._subAgentMembers = refs.members;
                }
              }
              // Team-level tool scope (overrides per-member tool lists)
              const scope = refs?.teamToolScope;
              if (scope && ((scope.allowedTools?.length ?? 0) > 0 || (scope.deniedTools?.length ?? 0) > 0)) {
                orchRun._teamToolScope = scope;
              }
            } catch { /* Agent config ref wiring failure is non-fatal */ }
          }

          log.info("Agent orchestration resolution", {
            userMessage: userMessage.slice(0, 100),
            agents: allAvailableAgents.map(a => a.name),
            teams: mentionedTeams.map(t => t.team.name),
            depth,
          });

          if (allAvailableAgents.length > 0) {
            // Resolve memberOverrides: from options (nested call) or from team config refs
            const resolvedMemberOverrides = options.memberOverrides ?? orchRun._memberOverrides;
            const resolvedSubAgentMembers = options.subAgentMembers ?? orchRun._subAgentMembers;
            // Team-level tool scope — from team-mention (depth 0) or from team config refs.
            // Cascades to all invoked sub-members, overriding any per-member tool lists.
            const firstMentionedTeam = mentionedTeams[0];
            const resolvedTeamToolScope =
              firstMentionedTeam?.team.teamToolScope
              ?? orchRun._teamToolScope;

            // Orchestration extension (Phase 4 commit-5): wire-on-first-use for
            // invoke_agent. The legacy built-in was deleted; the same tool
            // surface is now served by the bundled `orchestration` extension
            // (docs/extensions/examples/orchestration/). Mirrors the Phase 3
            // `ensureTaskTrackingWired` pattern.
            try {
              const { ensureOrchestrationWired, wireOrchestrationToolsForTurn } =
                await import("../orchestration-host");
              const wired = await ensureOrchestrationWired(conversationId);
              if (wired) {
                await wireOrchestrationToolsForTurn({
                  agentTools: ctx.agentTools,
                  conversationId,
                  runId: run.id,
                  availableAgents: allAvailableAgents,
                  parentModel: options.model,
                  parentProvider: options.provider,
                  parentMessageId: options.parentMessageId,
                  depth,
                  memberOverrides: resolvedMemberOverrides
                    ? Object.fromEntries(resolvedMemberOverrides)
                    : undefined,
                  subAgentMembers: resolvedSubAgentMembers,
                  teamToolScope: resolvedTeamToolScope,
                  registry: ExtensionRegistry.getInstance(),
                  executor: host.executor,
                  stateMediator: host.stateMediator,
                  spawnQuota: host.spawnQuota,
                  userId: convRecord?.userId ?? undefined,
                });
              }
            } catch (orchWireErr) {
              log.warn("Orchestration extension wire failed — agent orchestration unavailable this turn", {
                error: String(orchWireErr),
              });
            }
            if (resolvedTeamToolScope) {
              orchRun._teamToolScope = resolvedTeamToolScope;
            }

            // Auto-wire the bundled `scratchpad` extension for this
            // conversation. Fail-closed on three independent gates (S7):
            //   (1) extension row exists — required so the DB-backed
            //       grant is discoverable;
            //   (2) extension is enabled — operator/admin may have
            //       disabled it through the admin UI or failure-counter;
            //   (3) `storage` permission is granted — required by
            //       src/extensions/storage-handler.ts:117 on every
            //       write/read, so without it the tools would be
            //       visible-but-useless.
            // Any gate miss → log + skip. Tools simply don't appear
            // in this turn's toolset; nothing breaks.
            try {
              const { getExtensionByName } = await import("../../db/queries/extensions");
              const scratchpadExt = await getExtensionByName("scratchpad");
              const storageGranted = (scratchpadExt?.grantedPermissions as { storage?: boolean } | undefined)?.storage === true;
              if (!scratchpadExt?.enabled || !storageGranted) {
                log.info("Scratchpad auto-wire skipped: not enabled or storage not granted", {
                  exists: !!scratchpadExt,
                  enabled: scratchpadExt?.enabled ?? false,
                  storageGranted,
                });
              } else {
                const { addConversationExtensions } = await import("../../db/queries/conversation-extensions");
                await addConversationExtensions(conversationId, [{ extensionId: scratchpadExt.id }]);
                const registry = ExtensionRegistry.getInstance();
                const toolExec = new ToolExecutor(registry, { bus: host.bus });
                if (host.stateMediator) toolExec.setStateMediator(host.stateMediator);
                toolExec.setExecutor(host.executor);
                toolExec.setSpawnQuota(host.spawnQuota);
                if (attachmentArgsResolver) toolExec.setArgsResolver(attachmentArgsResolver);
                if (convRecord?.userId) toolExec.setCurrentUserId(convRecord.userId);
                toolExec.setCurrentModel(options.model ?? convRecord?.model);
                toolExec.setCurrentProvider(options.provider ?? convRecord?.provider);
                toolExec.setCurrentAgentConfigId(options.agentConfigId ?? convRecord?.agentConfigId);
                for (const t of registry.getToolsForExtension(scratchpadExt.id)) {
                  if (!ctx.agentTools.some(at => at.name === t.name)) {
                    ctx.agentTools.push(extensionToAgentTool(
                      { name: t.name, description: t.description, inputSchema: t.inputSchema },
                      toolExec, conversationId, run.id,
                    ));
                  }
                }
              }
            } catch (scratchpadWireErr) {
              log.warn("Scratchpad auto-wire failed — proceeding without it", { error: String(scratchpadWireErr) });
            }

            // Store metadata for system prompt injection after Promise.all
            orchRun._mentionedAgents = allAvailableAgents;
            const firstTeam = mentionedTeams[0];
            if (firstTeam) {
              orchRun._teamConfig = { name: firstTeam.team.name, prompt: firstTeam.team.prompt, autoSpinUp: firstTeam.team.autoSpinUp };
            }
            log.info("Injected orchestration tools", { agents: allAvailableAgents.map(a => a.name), toolCount: ctx.agentTools.length });

            // Store flag for auto-spin-up (executed after Promise.all to avoid blocking tool loading)
            if (orchRun._teamConfig?.autoSpinUp) {
              orchRun._pendingAutoSpinUp = true;
            }
          }
        }
      } catch (agentWireErr) {
        log.error("Agent orchestration wiring failed", { error: String(agentWireErr), stack: agentWireErr instanceof Error ? agentWireErr.stack : undefined });
      }

      // Phase 3 commit-5: task-tracking moved to a bundled extension.
      // Tools flow through the ExtensionRegistry path like every other
      // extension; wire-on-first-use is handled by
      // task-tracking-host.ensureTaskTrackingWired at the tool-invoke
      // boundary, so no per-streamChat wiring needed here.
    })(),

    // 3. Model resolution + credential pre-validation (runs in parallel with 1 & 2)
    (async (): Promise<SetupToolsResult> => {
      const r = await resolveModel(options.provider, options.model);
      run.provider = r.provider;
      const cred = await getCredential(r.provider, credentialConversationId);
      return { resolved: r, initialCred: cred };
    })(),
  ]);

  // ── Post-Promise.all: append the Ez page-context block ───────────────
  // The persona seeded in the migration explicitly looks for
  // `<page_context>` to distinguish instrumented from non-instrumented
  // pages. We only emit the tag for Ez turns — a regular conversation
  // that somehow received an `ezContext` payload (defense-in-depth: the
  // messages endpoint shouldn't forward one for non-Ez convs, but this
  // branch enforces it even if upstream changes) gets nothing.
  //
  // Done AFTER Promise.all so the memory-injection branch's snapshot/
  // write-back race can no longer clobber our append. The orchestrator-
  // prompt block (applied later in applyAutoSpinUp) prepends to
  // ctx.system, so the final ordering is:
  //   [orchestrator-prompt]\n\n[base-system]\n\n[memory-injection]\n\n[page_context]
  // — `<page_context>` is preserved unconditionally for every Ez turn
  // that supplied an ezContext payload.
  //
  // Compact JSON keeps the token cost minimal; the client-side
  // serializer already capped data at ~500 tokens
  // (context-serializer.ts:TOKEN_BUDGET).
  if (
    convRecord?.kind === "ez" &&
    options.ezContext !== undefined &&
    options.ezContext !== null
  ) {
    try {
      const block = `<page_context>${JSON.stringify(options.ezContext)}</page_context>`;
      ctx.system = ctx.system ? `${ctx.system}\n\n${block}` : block;
    } catch (ezCtxErr) {
      // JSON.stringify can throw on circular refs — log once and fall
      // through. The Ez panel's serializer already guards its own
      // input; reaching this branch implies upstream tampering, in
      // which case dropping the block is the safe outcome.
      log.warn("Ez ezContext serialization failed — page_context block omitted", {
        error: String(ezCtxErr),
      });
    }
  }

  // The third tuple slot is the only one we surface upward.
  return resolvedModel;
}
