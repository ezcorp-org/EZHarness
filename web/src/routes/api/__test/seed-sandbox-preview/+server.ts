/** Real-browser fixture for the production sandbox preview dispatch. The
 * three-condition test-surface gate keeps this route absent in production. */
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { createConversation } from "$server/db/queries/conversations";
import { createProject, deleteProject } from "$server/db/queries/projects";
import { createPreviewSession, getPreviewByIdRaw, revokePreview } from "$server/db/queries/preview-sessions";
import { getDb } from "$server/db/connection";
import { previewSessions } from "$server/db/schema";
import { mintOneTimeCode } from "$server/runtime/preview/preview-token";
import { registerQualificationPreviewTarget } from "$server/runtime/preview/preview-target";
import { sameSandboxWorkspaceBinding, sandboxWorkspaceTarget,
  type SandboxPreviewBackend, type SandboxPreviewSocket, type SandboxWorkspaceBinding,
  type SandboxWorkspaceTarget } from "$server/runtime/workspaces/target";
import { isTestSurfaceEnabled } from "$server/test-surface";
import type { RequestHandler } from "./$types";

const PORT = 5173;
const MAX_FIXTURES = 4;
const HTML = `<!doctype html><title>Sandbox preview proof</title><h1>Sandbox preview browser proof</h1>
<p id="ws-state">connecting</p><script>
const socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/hmr", "vite-hmr");
socket.addEventListener("open", () => socket.send("browser-proof"));
socket.addEventListener("message", event => document.getElementById("ws-state").textContent = event.data);
socket.addEventListener("close", () => document.getElementById("ws-state").textContent = "closed");
</script>`;

type Fixture = { userId: string; projectId: string; target: SandboxWorkspaceTarget; expiresAt: Date; dispose(): void };
const fixtures = new Map<string, Fixture>();

async function cleanupFixture(id: string, fixture: Fixture): Promise<void> {
  await revokePreview(id, fixture.userId, new Date(), fixture.target);
  await getDb().delete(previewSessions).where(eq(previewSessions.id, id));
  await deleteProject(fixture.projectId);
  fixture.dispose();
  fixtures.delete(id);
}

async function sweepExpiredFixtures(): Promise<void> {
  for (const [id, fixture] of fixtures) {
    if (fixture.expiresAt.getTime() > Date.now()) continue;
    await cleanupFixture(id, fixture);
  }
}

function fixtureBackend(binding: Readonly<SandboxWorkspaceBinding>, userId: string): SandboxPreviewBackend {
  const sockets = new Set<{ close(): Promise<void> }>();
  let previewId = "";
  let claimedId = "";
  const current = (id: string, other: Readonly<SandboxWorkspaceBinding>, port: number | null) =>
    id === previewId && port === PORT && sameSandboxWorkspaceBinding(binding, other);
  return {
    async open(request) {
      if (previewId || request.userId !== userId || request.targetPort !== PORT
        || !sameSandboxWorkspaceBinding(binding, request.binding) || request.expiresAt.getTime() <= Date.now()) {
        throw new Error("Sandbox browser fixture changed");
      }
      previewId = request.previewId;
      claimedId = request.previewId;
    },
    async serve(request) {
      if (!current(request.previewId, request.binding, request.targetPort) || request.userId !== userId
        || request.expiresAt.getTime() <= Date.now() || request.request.method !== "GET"
        || (request.requestPath !== "/" && request.requestPath !== "/page")) {
        throw new Error("Sandbox browser fixture changed");
      }
      return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },
    async close(request) {
      if (request.previewId !== claimedId || request.targetPort !== PORT
        || !sameSandboxWorkspaceBinding(binding, request.binding) || request.userId !== userId) {
        throw new Error("Sandbox browser fixture changed");
      }
      if (!previewId) return;
      previewId = "";
      await Promise.all([...sockets].map(socket => socket.close()));
    },
    async connectWebSocket(request): Promise<SandboxPreviewSocket> {
      if (!current(request.previewId, request.binding, request.targetPort) || request.userId !== userId
        || request.requestPath !== "/hmr" || request.search !== "" || request.subprotocol !== "vite-hmr"
        || request.expiresAt.getTime() <= Date.now() || request.signal.aborted) {
        throw new Error("Sandbox browser fixture changed");
      }
      const pending: string[] = [];
      let wake: (() => void) | undefined;
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        sockets.delete(socket);
        wake?.();
      };
      const socket: SandboxPreviewSocket = {
        protocol: "vite-hmr",
        async send(frame) {
          if (closed || request.signal.aborted || request.expiresAt.getTime() <= Date.now()
            || frame !== "browser-proof") throw new Error("Sandbox browser fixture stream changed");
          pending.push("guest:browser-proof");
          wake?.();
        },
        messages: {
          async *[Symbol.asyncIterator]() {
            while (!closed && !request.signal.aborted) {
              if (pending.length) { yield pending.shift()!; continue; }
              await new Promise<void>(resolve => { wake = resolve; });
              wake = undefined;
            }
          },
        },
        close,
      };
      request.signal.addEventListener("abort", () => { void close(); }, { once: true });
      sockets.add(socket);
      return socket;
    },
  };
}

export const POST: RequestHandler = async ({ locals }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");
  const user = requireAuth(locals);
  await sweepExpiredFixtures();
  if (fixtures.size >= MAX_FIXTURES) return errorJson(429, "Fixture limit reached");
  const nonce = crypto.randomUUID();
  const project = await createProject({ name: `Sandbox preview ${nonce.slice(0, 8)}`,
    path: join(tmpdir(), `ezcorp-sandbox-preview-${nonce}`) });
  let conversationId: string | undefined;
  let previewId: string | undefined;
  let target: SandboxWorkspaceTarget | undefined;
  try {
    const conversation = await createConversation(project.id, { title: "Sandbox browser preview", userId: user.id });
    conversationId = conversation.id;
    const binding: SandboxWorkspaceBinding = {
      projectId: project.id, workspaceId: `e2e-sandbox-${nonce}`, connectionId: `e2e-connection-${nonce}`,
      providerId: "incus", generation: 1, presetId: "e2e-preview", releaseDigest: "a".repeat(64),
      presetDigest: "b".repeat(64), effectiveSettingsDigest: "c".repeat(64),
    };
    const previews = fixtureBackend(binding, user.id);
    target = sandboxWorkspaceTarget(binding, {
      async execute() { throw new Error("Browser fixture cannot execute workspace tools"); }, previews,
    });
    const preview = await createPreviewSession({ userId: user.id, conversationId: conversation.id,
      kind: "dynamic", targetPort: PORT, ttlMs: 5 * 60_000, workspaceTarget: target });
    previewId = preview.id;
    const leaseKey = { previewId: preview.id, userId: user.id,
      conversationId: conversation.id, binding, targetPort: PORT };
    const dispose = registerQualificationPreviewTarget(leaseKey, async () => target);
    fixtures.set(preview.id, { userId: user.id, projectId: project.id, target, expiresAt: preview.expiresAt, dispose });
    return json({ previewId: preview.id, code: mintOneTimeCode({ previewId: preview.id, userId: user.id }) });
  } catch (error) {
    const fixture = previewId && fixtures.get(previewId);
    if (previewId && fixture) await cleanupFixture(previewId, fixture);
    else {
      if (previewId && target) await revokePreview(previewId, user.id, new Date(), target);
      if (conversationId) await getDb().delete(previewSessions).where(eq(previewSessions.conversationId, conversationId));
      await deleteProject(project.id);
    }
    throw error;
  }
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");
  const user = requireAuth(locals);
  const body = (await request.json().catch(() => ({}))) as { previewId?: unknown };
  if (typeof body.previewId !== "string") return errorJson(400, "`previewId` is required");
  const fixture = fixtures.get(body.previewId);
  if (!fixture || fixture.userId !== user.id) return errorJson(404, "Not found");
  const row = await getPreviewByIdRaw(body.previewId);
  if (row && row.userId !== user.id) return errorJson(404, "Not found");
  await cleanupFixture(body.previewId, fixture);
  return json({ ok: true });
};
