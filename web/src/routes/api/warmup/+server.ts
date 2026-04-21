import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireScope } from "$lib/server/security/api-keys";

/** Pre-warm expensive resources (embedding model) so they're ready when needed. */
export const POST: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  try {
    const { warmupEmbeddings, isEmbeddingReady } = await import("$server/memory/embeddings");
    if (!isEmbeddingReady()) {
      warmupEmbeddings();
    }
  } catch {
    // Non-fatal — warmup is best-effort
  }
  return json({ ok: true });
};
