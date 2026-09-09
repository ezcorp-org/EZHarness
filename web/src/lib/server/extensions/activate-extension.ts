import type { Extension } from "$server/db/schema";

export type ActivateExtensionResult = { ok: true; extension: Extension } | { ok: false; status: 410; message: string };

export async function activateExtension(_id: string, _options: unknown, _actorId: string | null): Promise<ActivateExtensionResult> {
  return { ok: false, status: 410, message: "Use /api/extensions/control with an approved release; review at /extensions/author" };
}
