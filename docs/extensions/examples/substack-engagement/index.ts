#!/usr/bin/env bun
// substack-engagement — JSON-RPC tool dispatcher + cron wiring.
//
// Draft-and-approve Substack engagement agent. Every outbound message
// (comment reply, welcome DM, note comment) is drafted into a review
// queue; the human approves/edits/rejects/sends. Nothing sends
// autonomously (locked decision #1).
//
// Wiring contract:
//   - tools/call → the handlers in `lib/tools.ts` (+ Phase 2/3 modules).
//   - the `*/15 * * * *` cron → `runScheduledScan` (drafts only, never
//     sends). The SDK's Schedule class registers the handler; the host's
//     ScheduleDaemon fires it ownerless (project-scope storage is the
//     only scope reachable, hence the queue's PROJECT scope).
//
// Production stores are bound here once: the review queue uses
// `Storage("project")`, the voice-profile reader uses `Storage("user")`
// (the entity is user-scoped). The drafting LLM is `new Llm()`. All
// three are injectable seams so unit tests run channel-free.

import {
  createToolDispatcher,
  getChannel,
  Llm,
  Schedule,
  Storage,
  createCanvas,
  type ToolHandler,
  type ToolHandlerContext,
} from "@ezcorp/sdk/runtime";

import {
  scanComments,
  listQueue,
  approveItem,
  rejectItem,
  editItem,
  sendApproved,
  openReviewQueue,
  setLlm,
  setVoiceStore,
  setDraftConfig,
} from "./lib/tools";
import { setQueueStore } from "./lib/review-queue";

// ── Tool handlers ───────────────────────────────────────────────

const scan_comments: ToolHandler = (args, ctx) =>
  scanComments(args as Record<string, unknown>, ctx as ToolHandlerContext | undefined);
const list_queue: ToolHandler = (args) => listQueue(args as Record<string, unknown>);
const approve_item: ToolHandler = (args) => approveItem(args as Record<string, unknown>);
const reject_item: ToolHandler = (args) => rejectItem(args as Record<string, unknown>);
const edit_item: ToolHandler = (args) => editItem(args as Record<string, unknown>);
const send_approved: ToolHandler = (args, ctx) =>
  sendApproved(args as Record<string, unknown>, ctx as ToolHandlerContext | undefined);
const open_review_queue: ToolHandler = () => openReviewQueue();

export const tools: Record<string, ToolHandler> = {
  scan_comments,
  list_queue,
  approve_item,
  reject_item,
  edit_item,
  send_approved,
  open_review_queue,
};

// ── Cron handler ────────────────────────────────────────────────
//
// Drafts only — never sends (locked decision #1; the cron is ownerless
// and there is no human in the loop to approve a send). On every fire:
//   1. scan own-post comments → draft replies (Phase 1)
//   2. poll new subscribers → draft welcome DMs + schedule follow-ups
//      (Phase 2)
//   3. draft any due, not-yet-drafted follow-up rows lazily (Phase 2)
//   4. scan targeted Notes → draft comments (Phase 3)
//
// The cron passes no `ctx.invocationMetadata.settings`; credential-
// gated reads soft-fail (drafting needs no creds — `getCredential()`
// resolves global/user creds without a conversation per locked
// decision #5; the SubstackClient reads needed for scans surface
// MISSING_CREDENTIALS cleanly when the user hasn't configured creds yet).

export async function runScheduledScan(): Promise<void> {
  // Each scan is independent; one failing must not abort the others.
  // Phase 2 adds subscriber polling + due follow-ups; Phase 3 adds the
  // targeted-Notes scan. They are appended to this list in those phases.
  await safe(() => scanComments({}, undefined));
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // Cron fires are best-effort; a scan failure is logged, never thrown.
    console.error("[substack-engagement] scheduled scan step failed:", (err as Error).message);
  }
}

// ── Production wiring ───────────────────────────────────────────
//
// Extracted so a test can cover the wiring branch without opening
// stdin. Binds the project-scope queue store, the user-scope voice
// store, the LLM, the dispatcher, the cron handler, and the canvas
// event surface for the review card (Phase 4).

export function start(): void {
  const ch = getChannel();

  // Bind production stores + LLM (all injectable seams; tests swap them).
  //
  // Locked decision #4 mandated a PROJECT-scope queue so an OWNERLESS cron
  // fire can read/write it (user scope needs an owner the cron lacks). The
  // SDK runtime `Storage` exposes no "project" scope — its scopes are
  // "global" | "conversation" | "user", and the host storage-handler
  // rejects any other value with -32602 (storage-handler.ts:157). "global"
  // is the SDK's only OWNERLESS scope (resolveScopeId → null), which is
  // exactly what the locked decision's rationale requires: the ownerless
  // */15 cron can reach it without a user or conversation. We therefore
  // satisfy the DECISION'S INTENT (ownerless, cron-reachable) with the
  // scope that actually exists. Deviation documented in the Phase 1 commit.
  setQueueStore(new Storage("global"));
  setVoiceStore(new Storage("user"));
  setLlm(new Llm());
  setDraftConfig({});

  createToolDispatcher(tools);

  // Register the cron handler. The SDK silently drops `on()` for crons
  // not in the manifest, so this matches `permissions.schedule.crons`.
  const schedule = new Schedule();
  schedule.on("*/15 * * * *", async () => {
    await runScheduledScan();
  });

  // Phase 4 review-card events: Approve & Send / Reject / Edit flow back
  // through the host's generic event route to these handlers. Wiring
  // decision (open question 2, documented in the Phase 4 commit): the
  // card uses createCanvas bidirectional events (NOT direct tool
  // invocation) so the ownerless-cron-drafted queue stays consistent
  // with a single subprocess source of truth.
  createCanvas<{
    approve: { id: string };
    reject: { id: string };
    edit: { id: string; draft_body: string };
    send: { id: string };
  }>({
    cardType: "substack-review",
    namespace: "substack-engagement",
    events: {
      approve: async ({ payload }) => {
        await approveItem({ id: (payload as { id?: string }).id ?? "" });
      },
      reject: async ({ payload }) => {
        await rejectItem({ id: (payload as { id?: string }).id ?? "" });
      },
      edit: async ({ payload }) => {
        const p = payload as { id?: string; draft_body?: string };
        await editItem({ id: p.id ?? "", draft_body: p.draft_body ?? "" });
      },
      send: async ({ payload }) => {
        await sendApproved({ id: (payload as { id?: string }).id ?? "" }, undefined);
      },
    },
  });

  ch.start();
}

// Gated on `import.meta.main` so test imports don't open stdin.
if (import.meta.main) start();
