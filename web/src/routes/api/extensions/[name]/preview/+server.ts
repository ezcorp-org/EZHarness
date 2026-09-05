import { json } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import { ensureInitialized } from "$lib/server/context";
import { authorizeExtensionBrowser, extensionBrowserBundle } from "$lib/server/extension-browser";
import { extensionDocumentHeaders } from "$lib/server/extension-document";
import { readBoundedJson } from "$lib/server/security/bounded-json";
import { POST as invokeTool } from "../../../tool-invoke/+server";
import type { RequestHandler } from "./$types";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export const GET: RequestHandler = async ({ params, locals, url }) => {
  const user = requireSessionAuth(locals);
  if (user instanceof Response) return user;
  try {
    await ensureInitialized();
    const nonce = url.searchParams.get("nonce") ?? "";
    const conversationId = url.searchParams.get("conversationId") ?? "";
    const binding = url.searchParams.get("binding") ?? "";
    if (!UUID.test(nonce) || !conversationId || !/^[a-f0-9]{64}$/.test(binding)) return new Response("Invalid preview context", { status: 400 });
    const authority = await authorizeExtensionBrowser(params.name, user.id, conversationId, binding);
    const bundle = await extensionBrowserBundle(authority.active.release.artifactDigest);
    await authorizeExtensionBrowser(params.name, user.id, conversationId, binding);
    const bootstrap = `<script>Object.defineProperty(window,'__EZCORP_CANVAS_NONCE__',{value:${JSON.stringify(nonce)}});</script>`;
    return new Response(bootstrap + bundle.html, { headers: extensionDocumentHeaders() });
  } catch { return new Response("Extension preview is unavailable", { status: 404, headers: { "Cache-Control": "private, no-store" } }); }
};

export const POST: RequestHandler = async event => {
  const user = requireSessionAuth(event.locals);
  if (user instanceof Response) return user;
  if (event.request.headers.get("origin") !== event.url.origin) return json({ error: "Same-origin session required" }, { status: 403 });
  try {
    await ensureInitialized();
    const body = await readBoundedJson(event.request, 256 * 1024) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["binding", "conversationId", "method", "toolName", "input"].includes(key)) || typeof body.binding !== "string" || !/^[a-f0-9]{64}$/.test(body.binding) || typeof body.conversationId !== "string" || !body.conversationId || !["check", "tool.invoke"].includes(String(body.method))) return json({ error: "Invalid preview request" }, { status: 400 });
    const authority = await authorizeExtensionBrowser(event.params.name, user.id, body.conversationId, body.binding);
    if (body.method === "check") return json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
    const bundle = await extensionBrowserBundle(authority.active.release.artifactDigest);
    if (typeof body.toolName !== "string" || !bundle.spec.tools.includes(body.toolName) || !body.input || typeof body.input !== "object" || Array.isArray(body.input)) return json({ error: "Tool is not exposed to this preview" }, { status: 403 });
    const request = new Request(new URL("/api/tool-invoke", event.url), { method: "POST", headers: { "Content-Type": "application/json" }, signal: event.request.signal, body: JSON.stringify({ extensionName: authority.extension.name, toolName: body.toolName, input: body.input, conversationId: authority.conversation!.id, invocationId: crypto.randomUUID(), expectedReleaseBinding: authority.binding }) });
    const response = await invokeTool({ ...event, request, params: {}, route: { id: "/api/tool-invoke" } });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch { return json({ error: "Preview authority changed or request was invalid" }, { status: 403, headers: { "Cache-Control": "private, no-store" } }); }
};
