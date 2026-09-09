import { json } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import { ensureInitialized } from "$lib/server/context";
import { authorizeExtensionBrowser, extensionBrowserBundle } from "$lib/server/extension-browser";
import { extensionDocumentHeaders } from "$lib/server/extension-document";
import { readBoundedJson } from "$lib/server/security/bounded-json";
import { canonicalJson, sha256 } from "@ezcorp/extension-contract";
import { prepareBrowserInvocation, claimBrowserInvocation, cancelBrowserInvocation } from "$server/extensions/browser-invocation-control";
import { _invokeWithControl as invokeWithControl } from "../../../tool-invoke/+server";
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
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["binding", "conversationId", "method", "toolName", "input", "requestId", "installationId"].includes(key)) || typeof body.binding !== "string" || !/^[a-f0-9]{64}$/.test(body.binding) || typeof body.conversationId !== "string" || !body.conversationId || body.conversationId.length > 128 || !["check", "prepare", "tool.invoke", "cancel"].includes(String(body.method))) return json({ error: "Invalid preview request" }, { status: 400 });
    if (body.method === "cancel") {
      if (typeof body.requestId !== "string" || !UUID.test(body.requestId) || typeof body.installationId !== "string" || !body.installationId || body.installationId.length > 128 || body.toolName !== undefined || body.input !== undefined) return json({ error: "Invalid cancellation request" }, { status: 400 });
      return json(await cancelBrowserInvocation({ principalId: user.id, installationId: body.installationId, releaseBinding: body.binding, conversationId: body.conversationId }, body.requestId), { headers: { "Cache-Control": "private, no-store" } });
    }
    const authority = await authorizeExtensionBrowser(event.params.name, user.id, body.conversationId, body.binding);
    if (body.method === "check") return json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
    const bundle = await extensionBrowserBundle(authority.active.release.artifactDigest);
    if (typeof body.toolName !== "string" || !bundle.spec.tools.includes(body.toolName) || !body.input || typeof body.input !== "object" || Array.isArray(body.input)) return json({ error: "Tool is not exposed to this preview" }, { status: 403 });
    const identity = { principalId: user.id, installationId: authority.extension.id, releaseBinding: authority.binding, conversationId: authority.conversation!.id };
    const payloadDigest = await sha256(canonicalJson({ toolName: body.toolName, input: body.input }));
    if (body.method === "prepare") {
      if (body.requestId !== undefined || body.installationId !== undefined) return json({ error: "Request identifiers are host-issued" }, { status: 400 });
      return json({ ...await prepareBrowserInvocation({ ...identity, payloadDigest, deadline: Date.now() + 60000 }), installationId: identity.installationId }, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (typeof body.requestId !== "string" || !UUID.test(body.requestId) || body.installationId !== undefined) return json({ error: "A prepared request is required" }, { status: 400 });
    const claim = await claimBrowserInvocation(identity, body.requestId, payloadDigest);
    try {
      const request = new Request(new URL("/api/tool-invoke", event.url), { method: "POST", headers: { "Content-Type": "application/json" }, signal: claim.signal, body: JSON.stringify({ extensionName: authority.extension.name, toolName: body.toolName, input: body.input, conversationId: authority.conversation!.id, invocationId: body.requestId, expectedReleaseBinding: authority.binding }) });
      const response = await invokeWithControl({ ...event, request, params: {}, route: { id: "/api/tool-invoke" } }, { signal: claim.signal, invocationGuard: claim.assertActive });
      const result = await response.clone().json();
      await claim.finish(response.ok && result?.success === true ? "succeeded" : "failed");
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    } finally { await claim.dispose(); }
  } catch { return json({ error: "Preview authority changed or request was invalid" }, { status: 403, headers: { "Cache-Control": "private, no-store" } }); }
};
