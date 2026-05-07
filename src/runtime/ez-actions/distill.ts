/**
 * `!EZ:distill` action handler — force-trigger lesson distillation
 * bypassing the pre-LLM trigger gate.
 *
 * Why bypass the gate? The lessons-keeper v1 trigger heuristics are
 * designed to dodge the false-positive rate of running the LLM on
 * every chat turn. They under-fire on perfectly distillable
 * conversations (e.g. a long-form discussion that didn't happen to
 * use ≥5 tools, no "no, instead" correction phrasing, no `[lesson]`
 * tag). The user invoking `!EZ:distill` is the explicit override —
 * they read the conversation, decided there's a lesson to capture,
 * and asked the runtime to extract it. The trigger gate's purpose is
 * served; only the per-call cost remains, which the user is
 * explicitly opting in to.
 *
 * Decline reasons surfaced as cards (the v1.5 diagnostic gap that
 * motivated the EZ Actions sigil):
 *   - empty_conversation       → "Not enough context"
 *   - llm_empty                → "Distiller declined" — model said no
 *                                reusable insight, the desired path
 *   - llm_malformed            → "Distiller declined" — model output
 *                                couldn't be parsed; surfaces detail
 *   - slug_collision           → "Already captured" — a previous
 *                                run already produced this lesson
 *
 * Error variants:
 *   - db_error                 → DB write failed
 *   - llm_error                → LLM call threw
 *   - settings_disabled        → admin disabled the distiller globally
 *
 * Auth: the dispatch endpoint verifies the user owns
 * `ctx.conversationId` before invoking us. We re-fetch the
 * conversation to get the projectId AND assert ownerId matches
 * `ctx.userId` — defense-in-depth so a future refactor of the
 * dispatch path can't accidentally widen the auth surface.
 */
import type { EzAction, EzActionContext, EzActionResult } from "./types";
import { getSetting } from "../../db/queries/settings";
import { getConversation } from "../../db/queries/conversations";
import { runDistillation } from "../lessons/distiller";

const ACTION_NAME = "distill";
const ACTION_DESCRIPTION =
  "Force-trigger lesson distillation on this conversation (bypasses the trigger gate)";

async function handler(ctx: EzActionContext): Promise<EzActionResult> {
  // ── Settings toggle ────────────────────────────────────────────
  // Manual invocations honor the global enable flag — if the admin
  // disabled the distiller, surface that as a decline card with the
  // diagnostic reason rather than running silently. Mirrors
  // distiller.ts:166 (auto-listener silent skip).
  const enabled = await getSetting("global:lessonDistillerEnabled");
  if (enabled === false) {
    return {
      kind: "decline",
      card: {
        title: "Distiller is disabled",
        body: "The lessons distiller is turned off in global settings. Re-enable it to use this action.",
        variant: "warning",
      },
    };
  }

  // ── Conversation fetch + auth re-check ─────────────────────────
  // The dispatch endpoint already verified ownership; we re-check
  // here so this handler is correct in isolation (a future direct
  // caller can't bypass the gate) and to resolve the projectId.
  const conversation = await getConversation(ctx.conversationId);
  if (!conversation) {
    return {
      kind: "error",
      card: {
        title: "Conversation not found",
        body: "The conversation could not be loaded — it may have been deleted.",
        variant: "error",
      },
    };
  }
  if (conversation.userId !== ctx.userId) {
    // Should never reach here if the dispatch endpoint is correct,
    // but defense-in-depth: collapse "not owned" + "doesn't exist"
    // into the same surface so the action result doesn't leak which
    // conversations exist.
    return {
      kind: "error",
      card: {
        title: "Not authorized",
        body: "You don't own this conversation.",
        variant: "error",
      },
    };
  }
  const projectId = conversation.projectId;

  // ── Run the post-trigger-gate pipeline ─────────────────────────
  // `skipTriggerGate: true` is the whole point of this action — the
  // user explicitly asked, the trigger heuristics don't apply.
  let outcome: Awaited<ReturnType<typeof runDistillation>>;
  try {
    outcome = await runDistillation({
      conversationId: ctx.conversationId,
      projectId,
      ownerId: ctx.userId,
      skipTriggerGate: true,
    });
  } catch (err) {
    // `runDistillation` re-throws db_error after capturing it in the
    // outcome (preserving auto-listener log surface). Catch here so
    // the manual handler still gets to surface a card.
    return {
      kind: "error",
      card: {
        title: "Distiller failed",
        body: `Unexpected error: ${(err as Error).message}`,
        variant: "error",
      },
    };
  }

  // ── Map outcome → card ─────────────────────────────────────────
  if (outcome.kind === "success") {
    return {
      kind: "success",
      card: {
        title: "Lesson captured",
        body: `${outcome.lesson.title} (slug: ${outcome.lesson.slug})`,
        variant: "success",
      },
      ref: { kind: "lesson", slug: outcome.lesson.slug },
    };
  }

  if (outcome.kind === "decline") {
    switch (outcome.reason) {
      case "empty_conversation":
        return {
          kind: "decline",
          card: {
            title: "Not enough context",
            body: "This conversation has no messages to distill.",
            variant: "info",
          },
        };
      case "llm_empty":
        return {
          kind: "decline",
          card: {
            title: "Distiller declined",
            body: "The model found no reusable insight in the recent messages. Nothing was captured.",
            variant: "info",
          },
        };
      case "llm_malformed":
        return {
          kind: "decline",
          card: {
            title: "Distiller declined",
            body: `The model's response couldn't be parsed: ${outcome.detail}`,
            variant: "warning",
          },
        };
      case "slug_collision":
        return {
          kind: "decline",
          card: {
            title: "Already captured",
            body: `A lesson with the slug "${outcome.existingSlug}" already exists. The previous capture is the authoritative one.`,
            variant: "info",
          },
        };
      case "trigger_gate_blocked":
        // Should be unreachable — manual handler always passes
        // skipTriggerGate=true. Surface as an error so the bug is
        // visible if it ever fires (rather than masked as decline).
        return {
          kind: "error",
          card: {
            title: "Distiller failed",
            body: "Internal error: trigger gate blocked a manual distill request. Please report this bug.",
            variant: "error",
          },
        };
    }
  }

  // outcome.kind === "error"
  if (outcome.reason === "llm_error") {
    return {
      kind: "error",
      card: {
        title: "Distiller failed",
        body: `LLM call failed: ${outcome.detail}`,
        variant: "error",
      },
    };
  }
  if (outcome.reason === "internal") {
    // Sentinel — runDistillation initialized `outcome` to this and
    // never overwrote it. Means a code path inside the lock returned
    // without setting it. Surface as a distinct error card so the
    // diagnostic detail is visible (and not mis-labelled as a DB
    // error).
    return {
      kind: "error",
      card: {
        title: "Distiller failed",
        body: `Internal error: ${outcome.detail}`,
        variant: "error",
      },
    };
  }
  // db_error — runDistillation re-throws after building the outcome,
  // so this branch is reached via the catch above. Keeping the
  // exhaustive map here for symmetry with the discriminant types.
  return {
    kind: "error",
    card: {
      title: "Distiller failed",
      body: `Database error: ${outcome.detail}`,
      variant: "error",
    },
  };
}

export const distillAction: EzAction = {
  name: ACTION_NAME,
  description: ACTION_DESCRIPTION,
  handler,
};
