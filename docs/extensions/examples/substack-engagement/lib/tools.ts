// ── tools — the substack-engagement tool handlers ──────────────
//
// Every outbound action is draft-and-approve (locked decision #1):
//   - `scan_comments`  reads own-post comments, drafts a reply per new
//                      one (voice), enqueues kind:"reply" as pending.
//   - `list_queue`     enumerates the review queue (optionally filtered).
//   - `approve_item` / `reject_item` / `edit_item` mutate one record.
//   - `send_approved`  sends every APPROVED item via the SubstackClient
//                      seam, flips to sent/failed. Refuses non-approved
//                      items — the hard "you draft, you never send" rule.
//   - `open_review_queue` returns a `substack-review` card (dock layout).
//
// All Substack I/O goes through `resolveClient(...)` → the injectable
// SubstackClient seam. All LLM drafting goes through the `draftReply`
// voice seam. The voice-profile entity is read from the SDK's managed
// `__entity:voice-profile:<slug>` namespace via the injectable queue
// store shape (a plain `get`), so unit tests never touch a channel.

import { toolError, toolResult } from "@ezcorp/sdk/runtime";
import type { ToolCallResult } from "@ezcorp/sdk";
import type { ToolHandlerContext } from "@ezcorp/sdk/runtime";
import {
  draftReply,
  type DraftLlm,
  type DraftFramework,
  type VoiceProfile,
} from "./voice";
import {
  enqueue,
  list,
  get,
  approve,
  reject,
  editBody,
  markSent,
  markFailed,
  findActiveByTarget,
  type QueueItem,
  type QueueStoreLike,
} from "./review-queue";
import {
  resolveClient,
  type SubstackClient,
  type SendResult,
} from "./substack-client";

// ── Runtime configuration (bound by index.ts from settings/defaults) ─

export interface DraftConfig {
  provider: string;
  model: string;
  maxTokens: number;
  /** Agent-prompt floor used when no voice-profile exists. */
  agentPrompt: string;
}

let _config: DraftConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  maxTokens: 1024,
  agentPrompt:
    "You draft warm, concise engagement replies in the creator's voice. " +
    "You NEVER send — every message you write is queued for human review.",
};

export function setDraftConfig(config: Partial<DraftConfig>): void {
  _config = { ..._config, ...config };
}

// ── LLM seam ────────────────────────────────────────────────────

let _llm: DraftLlm | null = null;

/** Bind the production Llm (index.ts wires `new Llm()`). */
export function setLlm(llm: DraftLlm): void {
  _llm = llm;
}

/** Test-only: inject a fake LLM. */
export function _setLlmForTests(llm: DraftLlm | null): void {
  _llm = llm;
}

function llm(): DraftLlm {
  if (!_llm) {
    throw new Error("[substack-engagement] tools: LLM not bound — call setLlm()");
  }
  return _llm;
}

// ── Voice-profile reader (SDK managed entity namespace) ─────────
//
// The voice-profile entity is stored by the SDK at
// `__entity:voice-profile:<slug>`. We read the FIRST profile (the
// extension seeds a single `default` profile) through a tiny get-only
// store seam so tests inject a fake without channel wiring. Production
// is bound to `new Storage("user")` by index.ts (voice-profile is
// user-scoped per the manifest).

const VOICE_ENTITY_KEY = "__entity:voice-profile:default";

let _voiceStore: Pick<QueueStoreLike, "get"> | null = null;

/** Bind the production voice store (index.ts wires `new Storage("user")`). */
export function setVoiceStore(store: Pick<QueueStoreLike, "get">): void {
  _voiceStore = store;
}

/** Test-only: inject a fake voice-profile store. */
export function _setVoiceStoreForTests(
  store: Pick<QueueStoreLike, "get"> | null,
): void {
  _voiceStore = store;
}

/** Read the default voice-profile, or null when none exists / no store. */
export async function readVoiceProfile(): Promise<VoiceProfile | null> {
  if (!_voiceStore) return null;
  const res = await _voiceStore.get<VoiceProfile>(VOICE_ENTITY_KEY);
  if (!res.exists || !res.value) return null;
  return res.value;
}

/** Resolve the system guidance: voice description when set, else the
 *  agent-prompt floor (locked decision: voice has a floor). */
function systemGuidance(profile: VoiceProfile | null): string {
  const desc = profile?.voiceDescription?.trim();
  return desc && desc.length > 0 ? desc : _config.agentPrompt;
}

// ── Shared draft+enqueue helper (DRY across scan tools) ─────────

export interface DraftAndEnqueueInput {
  kind: QueueItem["kind"];
  framework: DraftFramework;
  target_ref: string;
  context: string;
  due_at?: number | null;
  sequence_step?: number;
}

/**
 * Draft a body via the voice seam (no enqueue). The single drafting
 * primitive — `draftAndEnqueue` and Phase 2's lazy follow-up drafting
 * both route through here so the voice + LLM + config wiring lives in
 * exactly one place (DRY).
 */
async function draftRowBody(
  profile: VoiceProfile | null,
  framework: DraftFramework,
  context: string,
): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  return draftReply({
    llm: llm(),
    provider: _config.provider,
    model: _config.model,
    maxTokens: _config.maxTokens,
    systemPrompt: systemGuidance(profile),
    voiceProfile: profile,
    sourceText: context,
    framework,
  });
}

/**
 * Draft a body via the voice seam and enqueue it as pending. Returns the
 * enqueued item, or an error string when the draft fails. Dedupe is the
 * caller's job (it varies per scan tool).
 */
async function draftAndEnqueue(
  profile: VoiceProfile | null,
  input: DraftAndEnqueueInput,
): Promise<{ ok: true; item: QueueItem } | { ok: false; error: string }> {
  const drafted = await draftRowBody(profile, input.framework, input.context);
  if (!drafted.ok) return { ok: false, error: drafted.error };

  const enqueueInput: Parameters<typeof enqueue>[0] = {
    kind: input.kind,
    target_ref: input.target_ref,
    context: input.context,
    draft_body: drafted.body,
    due_at: input.due_at ?? null,
  };
  if (input.sequence_step !== undefined) {
    enqueueInput.sequence_step = input.sequence_step;
  }
  const item = await enqueue(enqueueInput);
  return { ok: true, item };
}

// Re-export so Phase 2/3 scan tools share the same drafting path.
export { draftAndEnqueue, draftRowBody, systemGuidance };

// ── scan_comments ───────────────────────────────────────────────

export async function scanComments(
  args: Record<string, unknown>,
  ctx?: ToolHandlerContext,
): Promise<ToolCallResult> {
  const settings = (ctx?.invocationMetadata?.settings ?? {}) as Record<string, unknown>;
  const resolved = await resolveClient(settings);
  if (!resolved.ok) {
    return toolError(resolved.error, resolved.reason);
  }
  const client = resolved.client;

  const limit = typeof args.limit === "number" ? args.limit : undefined;
  let comments;
  try {
    comments = await client.listOwnPostComments(limit !== undefined ? { limit } : {});
  } catch (err) {
    return toolError(`Failed to list comments: ${(err as Error).message}`, "CLIENT_ERROR");
  }

  const profile = await readVoiceProfile();
  let drafted = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const comment of comments) {
    // Dedupe on target_ref (the comment id) — a re-scan never double-queues.
    const existing = await findActiveByTarget("reply", comment.id);
    if (existing) {
      skipped++;
      continue;
    }
    const res = await draftAndEnqueue(profile, {
      kind: "reply",
      framework: "reply",
      target_ref: comment.id,
      context: comment.body,
    });
    if (res.ok) drafted++;
    else failures.push(`${comment.id}: ${res.error}`);
  }

  return toolResult(
    JSON.stringify(
      {
        ok: true,
        scanned: comments.length,
        drafted,
        skipped,
        failed: failures.length,
        ...(failures.length > 0 ? { failures } : {}),
      },
      null,
      2,
    ),
  );
}

// ── list_queue ──────────────────────────────────────────────────

export async function listQueue(
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const filter: { status?: QueueItem["status"]; kind?: QueueItem["kind"] } = {};
  if (typeof args.status === "string") filter.status = args.status as QueueItem["status"];
  if (typeof args.kind === "string") filter.kind = args.kind as QueueItem["kind"];
  // A read against an un-provisioned store (e.g. the `ezcorp ext verify`
  // smoke harness, which wires no storage handler) is a valid EMPTY queue,
  // not a tool error — a freshly-installed extension simply has nothing
  // queued yet. This keeps `list_queue` a clean no-dependency smoke tool.
  let items: QueueItem[];
  try {
    items = await list(filter);
  } catch {
    items = [];
  }
  return toolResult(JSON.stringify({ ok: true, count: items.length, items }, null, 2));
}

// ── approve_item / reject_item / edit_item ──────────────────────

async function requireId(args: Record<string, unknown>): Promise<string | null> {
  const id = args.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function approveItem(args: Record<string, unknown>): Promise<ToolCallResult> {
  const id = await requireId(args);
  if (!id) return toolError("approve_item requires a string 'id'");
  const item = await approve(id);
  if (!item) return toolError(`Queue item "${id}" not found`, "NOT_FOUND");
  return toolResult(JSON.stringify({ ok: true, item }, null, 2));
}

export async function rejectItem(args: Record<string, unknown>): Promise<ToolCallResult> {
  const id = await requireId(args);
  if (!id) return toolError("reject_item requires a string 'id'");
  const item = await reject(id);
  if (!item) return toolError(`Queue item "${id}" not found`, "NOT_FOUND");
  return toolResult(JSON.stringify({ ok: true, item }, null, 2));
}

export async function editItem(args: Record<string, unknown>): Promise<ToolCallResult> {
  const id = await requireId(args);
  if (!id) return toolError("edit_item requires a string 'id'");
  const body = args.draft_body;
  if (typeof body !== "string" || body.trim().length === 0) {
    return toolError("edit_item requires a non-empty string 'draft_body'");
  }
  const item = await editBody(id, body);
  if (!item) return toolError(`Queue item "${id}" not found`, "NOT_FOUND");
  return toolResult(JSON.stringify({ ok: true, item }, null, 2));
}

// ── send_approved ───────────────────────────────────────────────
//
// The hard gate: refuses any item whose status !== "approved". Routes by
// kind to the right SubstackClient method. On failure, marks the item
// `failed` with the error; on success, marks it `sent`. Pacing for
// note-comment is layered in Phase 3 (this base path sends approved
// reply + welcome-dm items).

export async function sendItem(
  client: SubstackClient,
  item: QueueItem,
): Promise<SendResult> {
  switch (item.kind) {
    case "reply":
      return client.postCommentReply({
        commentId: item.target_ref,
        postId: item.target_ref,
        body: item.draft_body,
      });
    case "welcome-dm":
      return client.sendDirectMessage({
        subscriberId: item.target_ref,
        body: item.draft_body,
      });
    case "note-comment":
      return client.postNoteComment({
        noteId: item.target_ref,
        body: item.draft_body,
      });
  }
}

export async function sendApproved(
  args: Record<string, unknown>,
  ctx?: ToolHandlerContext,
): Promise<ToolCallResult> {
  // Optional `id` narrows to a single item; otherwise sends ALL approved.
  const onlyId = typeof args.id === "string" ? args.id : undefined;

  // Hard refusal: if a specific id is given and it isn't approved, refuse
  // loudly (the "never send a non-approved item" contract).
  if (onlyId) {
    const item = await get(onlyId);
    if (!item) return toolError(`Queue item "${onlyId}" not found`, "NOT_FOUND");
    if (item.status !== "approved") {
      return toolError(
        `Refusing to send item "${onlyId}" — status is "${item.status}", not "approved". ` +
          "Every send requires explicit approval.",
        "NOT_APPROVED",
      );
    }
  }

  const settings = (ctx?.invocationMetadata?.settings ?? {}) as Record<string, unknown>;
  const resolved = await resolveClient(settings);
  if (!resolved.ok) return toolError(resolved.error, resolved.reason);
  const client = resolved.client;

  const approvedItems = (await list({ status: "approved" })).filter(
    (i) => (onlyId ? i.id === onlyId : true),
  );

  let sent = 0;
  let failed = 0;
  const results: Array<{ id: string; kind: string; status: string; error?: string }> = [];

  for (const item of approvedItems) {
    let res: SendResult;
    try {
      res = await sendItem(client, item);
    } catch (err) {
      res = { ok: false, error: (err as Error).message };
    }
    if (res.ok) {
      await markSent(item.id);
      sent++;
      results.push({ id: item.id, kind: item.kind, status: "sent" });
    } else {
      await markFailed(item.id, res.error ?? "unknown send error");
      failed++;
      results.push({
        id: item.id,
        kind: item.kind,
        status: "failed",
        error: res.error ?? "unknown send error",
      });
    }
  }

  return toolResult(
    JSON.stringify({ ok: true, sent, failed, results }, null, 2),
  );
}

// ── open_review_queue ───────────────────────────────────────────
//
// Returns a `substack-review` card (dock layout). The host's
// `getCardComponentName("substack-review")` maps it to the Svelte
// SubstackReviewCard (Phase 4). The payload carries the current pending
// queue so the card renders without an extra round-trip.

export async function openReviewQueue(): Promise<ToolCallResult> {
  const pending = await list({ status: "pending" });
  const approved = await list({ status: "approved" });
  return toolResult(
    JSON.stringify({
      cardType: "substack-review",
      pending,
      approved,
      counts: { pending: pending.length, approved: approved.length },
    }),
    { cardType: "substack-review" },
  );
}
