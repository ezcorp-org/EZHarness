import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  deleteForConversation,
  readAttachmentBytes,
  writeAttachment,
} from "../chat/attachments/storage";
import { handlePreviewRequest } from "../runtime/preview/preview-proxy";
import { decideWebSocketUpgrade } from "../runtime/preview/preview-ws";
import {
  sandboxWorkspaceTarget,
  workspaceTargetReference,
  type SandboxWorkspaceBinding,
  type SandboxWorkspaceBackend,
} from "../runtime/workspaces/target";

const roots: string[] = [];
const previewId = "0123456789abcdefghjkmnpqrs";
const binding: SandboxWorkspaceBinding = {
  projectId: "project-1",
  workspaceId: "workspace-1",
  connectionId: "connection-1",
  providerId: "incus",
  generation: 7,
  presetId: "isolated-feature",
  releaseDigest: "a".repeat(64),
  presetDigest: "b".repeat(64),
  effectiveSettingsDigest: "c".repeat(64),
};

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ez-wave3-routing-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function toolBackend(extra: Partial<SandboxWorkspaceBackend> = {}): SandboxWorkspaceBackend {
  return {
    async execute() {
      return { content: [{ type: "text", text: "unused" }], details: {} };
    },
    ...extra,
  };
}

describe("sandbox attachment routing", () => {
  test("missing capability denies read, write, and delete before AMD filesystem access", async () => {
    const root = await tempRoot();
    const canaryDir = join(root, ".ezcorp", "attachments", "conversation", "message");
    const canaryPath = join(canaryDir, "amd-canary.txt");
    await mkdir(canaryDir, { recursive: true });
    await writeFile(canaryPath, "AMD_ATTACHMENT_CANARY");
    const target = sandboxWorkspaceTarget(binding, toolBackend());

    await expect(writeAttachment({
      workspaceTarget: target,
      conversationId: "conversation",
      messageId: "message",
      filename: "write.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("sandbox write"),
    })).rejects.toThrow("Local workspace fallback was denied");
    await expect(readAttachmentBytes(target, canaryPath))
      .rejects.toThrow("Local workspace fallback was denied");
    await expect(deleteForConversation({ workspaceTarget: target, conversationId: "conversation" }))
      .rejects.toThrow("Local workspace fallback was denied");

    expect(await readFile(canaryPath, "utf8")).toBe("AMD_ATTACHMENT_CANARY");
    await expect(access(join(canaryDir, "write.txt"))).rejects.toThrow();
  });

  test("capability receives the complete host-selected binding for every operation", async () => {
    const requests: unknown[] = [];
    const bytes = new Uint8Array([1, 2, 3]);
    const target = sandboxWorkspaceTarget(binding, toolBackend({
      attachments: {
        async write(request) {
          requests.push(request);
          return { storageKey: "opaque://attachment-1", sizeBytes: request.bytes.byteLength };
        },
        async read(request) {
          requests.push(request);
          return bytes;
        },
        async delete(request) {
          requests.push(request);
        },
      },
    }));

    const written = await writeAttachment({
      workspaceTarget: target,
      conversationId: "conversation",
      messageId: "message",
      filename: "a.png",
      mimeType: "image/png",
      bytes,
    });
    expect(written).toEqual({ storagePath: "opaque://attachment-1", sizeBytes: 3 });
    expect(await readAttachmentBytes(target, written.storagePath)).toEqual(bytes);
    await deleteForConversation({ workspaceTarget: target, conversationId: "conversation" });
    expect(requests).toHaveLength(3);
    for (const request of requests as Array<{ binding: SandboxWorkspaceBinding }>) {
      expect(request.binding).toEqual(binding);
    }
  });
});

describe("sandbox preview serving", () => {
  function deps(rowTarget = workspaceTargetReference(sandboxWorkspaceTarget(binding, null))) {
    const localTouches = { files: 0, loopback: 0 };
    return {
      localTouches,
      value: {
        verifyToken: async () => ({ previewId, userId: "user-1" }),
        getServable: async () => ({
          id: previewId,
          userId: "user-1",
          kind: "dynamic" as const,
          staticPath: "/amd/.ezcorp/sites/canary",
          targetPort: 4173,
          expiresAt: new Date(Date.now() + 60_000),
          workspaceTarget: rowTarget,
        }),
        readFile: async () => {
          localTouches.files++;
          return { body: "AMD", size: 3 };
        },
        proxyDynamic: async () => {
          localTouches.loopback++;
          return new Response("AMD");
        },
      },
    };
  }

  test("missing capability fails closed without AMD file or loopback access", async () => {
    const fixture = deps();
    const response = await handlePreviewRequest({
      previewId,
      requestPath: "/",
      cookieToken: "valid",
      request: new Request(`https://${previewId}.preview.example.test/`),
    }, fixture.value);

    expect(response.status).toBe(502);
    expect(fixture.localTouches).toEqual({ files: 0, loopback: 0 });
  });

  test("sandbox static row cannot read a stored AMD path", async () => {
    const fixture = deps();
    const response = await handlePreviewRequest({
      previewId,
      requestPath: "/",
      cookieToken: "valid",
      request: new Request(`https://${previewId}.preview.example.test/`),
    }, {
      ...fixture.value,
      getServable: async () => ({
        ...(await fixture.value.getServable()),
        kind: "static" as const,
        targetPort: null,
      }),
    });
    expect(response.status).toBe(502);
    expect(fixture.localTouches).toEqual({ files: 0, loopback: 0 });
  });

  test("a forged resolver binding is rejected before the preview capability runs", async () => {
    const fixture = deps();
    let serves = 0;
    const forged = sandboxWorkspaceTarget({ ...binding, generation: binding.generation + 1 }, toolBackend({
      previews: {
        async open() {},
        async serve() { serves++; return new Response("forged"); },
        async close() {},
      },
    }));
    const response = await handlePreviewRequest({
      previewId,
      requestPath: "/",
      cookieToken: "valid",
      request: new Request(`https://${previewId}.preview.example.test/`),
    }, { ...fixture.value, resolveWorkspaceTarget: () => forged });

    expect(response.status).toBe(502);
    expect(serves).toBe(0);
    expect(fixture.localTouches).toEqual({ files: 0, loopback: 0 });
  });

  test("expired sandbox preview is denied before backend or host access", async () => {
    const fixture = deps();
    let serves = 0;
    const target = sandboxWorkspaceTarget(binding, toolBackend({
      previews: {
        async open() {},
        async serve() { serves++; return new Response("sandbox"); },
        async close() {},
      },
    }));
    const response = await handlePreviewRequest({
      previewId,
      requestPath: "/",
      cookieToken: "valid",
      request: new Request(`https://${previewId}.preview.example.test/`),
    }, {
      ...fixture.value,
      getServable: async () => ({
        ...(await fixture.value.getServable()),
        expiresAt: new Date(Date.now() - 1),
      }),
      resolveWorkspaceTarget: () => target,
    });

    expect(response.status).toBe(502);
    expect(serves).toBe(0);
    expect(fixture.localTouches).toEqual({ files: 0, loopback: 0 });
  });

  test("matching capability receives identity, authorization, port, path, and expiry", async () => {
    const fixture = deps();
    const requests: unknown[] = [];
    const target = sandboxWorkspaceTarget(binding, toolBackend({
      previews: {
        async open() {},
        async serve(request) {
          requests.push(request);
          return new Response("sandbox preview", { headers: { "Content-Type": "text/plain" } });
        },
        async close() {},
      },
    }));
    const request = new Request(`https://${previewId}.preview.example.test/live?x=1`);
    const response = await handlePreviewRequest({
      previewId,
      requestPath: "/live",
      cookieToken: "valid",
      request,
    }, { ...fixture.value, resolveWorkspaceTarget: () => target });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("sandbox preview");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      binding,
      previewId,
      userId: "user-1",
      targetPort: 4173,
      requestPath: "/live",
    });
    expect((requests[0] as { request: Request }).request.url).toBe(request.url);
    expect(fixture.localTouches).toEqual({ files: 0, loopback: 0 });
  });

  test("provider serve failure returns 502 without host file or loopback fallback", async () => {
    const fixture = deps();
    let serves = 0;
    const target = sandboxWorkspaceTarget(binding, toolBackend({
      previews: {
        async open() {},
        async serve() { serves++; throw new Error("guest connection lost"); },
        async close() {},
      },
    }));
    const response = await handlePreviewRequest({
      previewId, requestPath: "/live", cookieToken: "valid",
      request: new Request(`https://${previewId}.preview.example.test/live`),
    }, { ...fixture.value, resolveWorkspaceTarget: () => target });

    expect(response.status).toBe(502);
    expect(serves).toBe(1);
    expect(fixture.localTouches).toEqual({ files: 0, loopback: 0 });
  });

  test("sandbox provider receives a sanitized POST with its body intact", async () => {
    const fixture = deps();
    let providerRequest: Request | undefined;
    const target = sandboxWorkspaceTarget(binding, toolBackend({
      previews: {
        async open() {},
        async serve({ request }) {
          providerRequest = request;
          return new Response("ok");
        },
        async close() {},
      },
    }));
    const request = new Request(`https://${previewId}.preview.example.test/form`, {
      method: "POST",
      headers: {
        host: `${previewId}.preview.example.test`,
        cookie: "__ezpreview=secret-token; app_session=secret-session",
        authorization: "Bearer secret-key",
        "proxy-authorization": "Basic secret-proxy",
        "x-ezcorp-internal": "secret-internal",
        "x-ez-debug": "secret-debug",
        "x-forwarded-secret": "secret-forwarded",
        "x-real-ip": "secret-ip",
        "content-type": "text/plain",
      },
      body: "form payload",
    });
    const response = await handlePreviewRequest({
      previewId,
      requestPath: "/form",
      cookieToken: "valid",
      request,
    }, { ...fixture.value, resolveWorkspaceTarget: () => target });

    expect(response.status).toBe(200);
    expect(providerRequest?.method).toBe("POST");
    expect(await providerRequest?.text()).toBe("form payload");
    expect(providerRequest?.headers.get("content-type")).toBe("text/plain");
    for (const name of [
      "host", "cookie", "authorization", "proxy-authorization",
      "x-ezcorp-internal", "x-ez-debug", "x-forwarded-secret", "x-real-ip",
    ]) {
      expect(providerRequest?.headers.has(name)).toBe(false);
    }
    expect(request.headers.get("authorization")).toBe("Bearer secret-key");
    expect(fixture.localTouches).toEqual({ files: 0, loopback: 0 });
  });

  test("sandbox provider receives no headers when every inbound header is forbidden", async () => {
    const fixture = deps();
    const received: Request[] = [];
    const target = sandboxWorkspaceTarget(binding, toolBackend({
      previews: {
        async open() {},
        async serve({ request }) { received.push(request); return new Response("ok"); },
        async close() {},
      },
    }));
    const request = new Request(`https://${previewId}.preview.example.test/`, {
      headers: {
        cookie: "__ezpreview=secret-token",
        authorization: "Bearer secret-key",
        "x-ezcorp-internal": "secret-internal",
      },
    });
    const response = await handlePreviewRequest({
      previewId,
      requestPath: "/",
      cookieToken: "valid",
      request,
    }, { ...fixture.value, resolveWorkspaceTarget: () => target });

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect([...received[0]!.headers.keys()]).toEqual([]);
    expect(request.headers.get("authorization")).toBe("Bearer secret-key");
  });

  test("sandbox websocket reconnect cannot fall through to host loopback", async () => {
    const target = sandboxWorkspaceTarget(binding, null);
    const decision = await decideWebSocketUpgrade({
      previewId,
      requestPath: "/hmr",
      cookieToken: "valid",
      origin: `https://${previewId}.preview.example.test`,
      appHost: "example.test",
    }, {
      isValidPreviewId: () => true,
      verifyToken: async () => ({ previewId, userId: "user-1" }),
      getServable: async () => ({
        id: previewId,
        userId: "user-1",
        kind: "dynamic",
        staticPath: null,
        targetPort: 4173,
        workspaceTarget: workspaceTargetReference(target),
      }),
    });

    expect(decision).toEqual({
      accept: false,
      reason: "sandbox websocket transport unavailable",
    });
  });
});
