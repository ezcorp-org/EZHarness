import { json } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import { importExtensionSource, type ExtensionSourceInput } from "$server/extensions/source-import";
import { extensionControlError } from "$lib/server/extensions/control-errors";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const user = requireSessionAuth(locals);
    if (user instanceof Response) return user;
    if (user.role !== "admin") return json({ code: "forbidden", message: "Administrator session required" }, { status: 403 });
    if (!request.body) return json({ code: "invalid_input" }, { status: 400 });
    const reader = request.body.getReader();
    let text = "";
    let bytes = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16_384) { await reader.cancel(); return json({ code: "body_limit" }, { status: 413 }); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(text); } catch { return json({ code: "invalid_input" }, { status: 400 }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ code: "invalid_input" }, { status: 400 });
    const source = body as Record<string, unknown>;
    const valid = source.kind === "bundled" ? typeof source.name === "string"
      : source.kind === "marketplace" ? typeof source.versionId === "string"
      : source.kind === "local" ? typeof source.path === "string"
      : source.kind === "github" && typeof source.repository === "string" && (source.ref === undefined || typeof source.ref === "string") && (source.directory === undefined || typeof source.directory === "string") && (source.projectId === undefined || typeof source.projectId === "string");
    if (!valid) return json({ code: "invalid_input", message: "Provide a bundled, marketplace, local, or GitHub source" }, { status: 400 });
    return json(await importExtensionSource({ principalId: user.id, scope: "global", kind: "human" }, source as ExtensionSourceInput));
  } catch (error) { return extensionControlError(error); }
};
