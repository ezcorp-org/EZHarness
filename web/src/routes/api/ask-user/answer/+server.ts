import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { getBus } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { acceptAskUserAnswer } from "$server/runtime/ask-user-answer";
import { LifecycleError } from "$server/extensions/v4/types";

// Boundary validation. `toolCallId` matches the host-minted invocation
// id; `answer` is the option label or free-text the user submitted.
// Strict so unknown fields fail loud.
const askUserAnswerSchema = z
  .object({
    toolCallId: z.string().min(1).max(256),
    answer: z.string().min(1).max(64 * 1024),
  })
  .strict();

/**
 * Accept an owner-bound answer into the durable event queue before emitting
 * the host UI event. Equal retries reuse the receipt; changed answers conflict.
 * Unknown collapsed questions remain a no-op. Pending question processes are
 * still transient and are not resumed by the receipt after a server restart.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const raw = await request.json().catch(() => null);
  const parsed = askUserAnswerSchema.safeParse(raw);
  if (!parsed.success) {
    return errorJson(400, "Invalid body");
  }
  const { toolCallId, answer } = parsed.data;

  try {
    await acceptAskUserAnswer(user.id, toolCallId, answer, getBus());
  } catch (cause) {
    if (!(cause instanceof LifecycleError)) throw cause;
    if (cause.code === "event_not_found") return errorJson(404, "Not found");
    if (cause.code === "event_conflict") return errorJson(409, "This question already has a different answer.");
    if (cause.code === "invalid_answer") return errorJson(400, "Invalid body");
    if (cause.code === "event_admission_full") return errorJson(503, "Event admission capacity is full. Try again after maintenance cleanup.");
    throw cause;
  }

  return json({ ok: true });
};
