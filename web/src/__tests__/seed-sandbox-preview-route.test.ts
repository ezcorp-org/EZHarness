import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { closeTestDb, mockDbConnection, mockRealSettings, setupTestDb } from "../../../src/__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../../src/__tests__/helpers/mock-cleanup";

mockDbConnection();
mockRealSettings();

const { POST, DELETE } = await import("../routes/api/__test/seed-sandbox-preview/+server");
const { getPreviewByIdRaw } = await import("../../../src/db/queries/preview-sessions");
const { createUser } = await import("../../../src/db/queries/users");
const { getProject } = await import("../../../src/db/queries/projects");
const { resolveQualificationPreviewTarget } = await import("../../../src/runtime/preview/preview-target");
const owner = { id: "sandbox-preview-owner", email: "sandbox-preview-owner@example.test", name: "Owner", role: "member" } as const;
const other = { id: "sandbox-preview-other", email: "sandbox-preview-other@example.test", name: "Other", role: "member" } as const;
const saved = {
  real: process.env.PI_E2E_REAL,
  allow: process.env.EZCORP_ALLOW_TEST_SURFACE,
  node: process.env.NODE_ENV,
};

function event(request: Request, user: typeof owner | typeof other | null = owner): Parameters<typeof POST>[0] {
  return { request, locals: user ? { user } : {} } as Parameters<typeof POST>[0];
}

function deleteRequest(previewId: unknown): Request {
  return new Request("http://localhost/api/__test/seed-sandbox-preview", {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ previewId }),
  });
}

beforeAll(async () => {
  await setupTestDb();
  await createUser({ ...owner, passwordHash: "unused", status: "active" });
  await createUser({ ...other, passwordHash: "unused", status: "active" });
});
afterAll(async () => { await closeTestDb(); restoreModuleMocks(); });
beforeEach(() => {
  process.env.PI_E2E_REAL = "1";
  process.env.EZCORP_ALLOW_TEST_SURFACE = "1";
  delete process.env.NODE_ENV;
});
afterEach(() => {
  if (saved.real === undefined) delete process.env.PI_E2E_REAL; else process.env.PI_E2E_REAL = saved.real;
  if (saved.allow === undefined) delete process.env.EZCORP_ALLOW_TEST_SURFACE; else process.env.EZCORP_ALLOW_TEST_SURFACE = saved.allow;
  if (saved.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.node;
});

describe("sandbox browser preview fixture", () => {
  test("does not exist outside the explicit real E2E test surface", async () => {
    delete process.env.PI_E2E_REAL;
    expect((await POST(event(new Request("http://localhost")))).status).toBe(404);
    expect((await DELETE(event(deleteRequest("anything")))).status).toBe(404);
    process.env.PI_E2E_REAL = "1";
    process.env.NODE_ENV = "production";
    expect((await POST(event(new Request("http://localhost")))).status).toBe(404);
  });

  test("requires authentication and does not disclose another owner's fixture", async () => {
    await expect(POST(event(new Request("http://localhost"), null))).rejects.toMatchObject({ status: 401 });
    const seeded = await POST(event(new Request("http://localhost")));
    const { previewId } = await seeded.json() as { previewId: string };
    try {
      expect((await DELETE(event(deleteRequest(previewId), other))).status).toBe(404);
      expect((await getPreviewByIdRaw(previewId))?.status).toBe("active");
    } finally {
      await DELETE(event(deleteRequest(previewId)));
    }
  });

  test("stores a sandbox-only descriptor and removes the preview and project on cleanup", async () => {
    const seeded = await POST(event(new Request("http://localhost")));
    expect(seeded.status).toBe(200);
    const { previewId, code } = await seeded.json() as { previewId: string; code: string };
    expect(code.length).toBeGreaterThan(20);
    const row = await getPreviewByIdRaw(previewId);
    expect(row?.workspaceTarget).toMatchObject({ kind: "sandbox", binding: { providerId: "incus" } });
    expect(row?.targetPort).toBe(5173);
    expect(row?.staticPath).toBeNull();
    const projectId = row?.workspaceTarget.kind === "sandbox" ? row.workspaceTarget.binding.projectId : "";
    expect(await getProject(projectId)).toBeDefined();
    expect((await DELETE(event(deleteRequest(null)))).status).toBe(400);
    expect((await DELETE(event(deleteRequest(previewId)))).status).toBe(200);
    expect(await getPreviewByIdRaw(previewId)).toBeUndefined();
    expect(await getProject(projectId)).toBeUndefined();
  });

  test("fixed backend serves only the claimed page and closes an active socket on revoke", async () => {
    const seeded = await POST(event(new Request("http://localhost")));
    const { previewId } = await seeded.json() as { previewId: string };
    const row = (await getPreviewByIdRaw(previewId))!;
    const target = await resolveQualificationPreviewTarget(row);
    expect(target?.kind).toBe("sandbox");
    const binding = target!.binding;
    const backend = target!.backend!.previews!;
    await expect(target!.backend!.execute({} as never)).rejects.toThrow("cannot execute");
    await expect(backend.open({ binding, previewId, userId: owner.id,
      conversationId: row.conversationId!, targetPort: 5173, expiresAt: row.expiresAt })).rejects.toThrow("changed");
    await expect(backend.close({ binding, previewId, userId: other.id, targetPort: 5173 })).rejects.toThrow("changed");
    const serve = { binding, previewId, userId: owner.id, targetPort: 5173,
      requestPath: "/page", request: new Request("http://preview.localhost/page"), expiresAt: row.expiresAt };
    const served = await backend.serve(serve);
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("Sandbox preview browser proof");
    await expect(backend.serve({ ...serve, requestPath: "/other" })).rejects.toThrow("changed");
    await expect(backend.serve({ ...serve, userId: other.id })).rejects.toThrow("changed");

    const controller = new AbortController();
    const connect = { binding, previewId, userId: owner.id, targetPort: 5173,
      requestPath: "/hmr", search: "", expiresAt: row.expiresAt,
      signal: controller.signal, subprotocol: "vite-hmr" as const };
    await expect(backend.connectWebSocket!({ ...connect, subprotocol: "vite-ping" })).rejects.toThrow("changed");
    const socket = await backend.connectWebSocket!(connect);
    expect(socket.protocol).toBe("vite-hmr");
    const messages = socket.messages[Symbol.asyncIterator]();
    const message = messages.next();
    await socket.send("browser-proof");
    expect((await message).value).toBe("guest:browser-proof");
    await expect(socket.send("other")).rejects.toThrow("changed");
    const closed = messages.next();
    expect((await DELETE(event(deleteRequest(previewId)))).status).toBe(200);
    expect((await closed).done).toBe(true);
    await expect(socket.send("browser-proof")).rejects.toThrow("changed");
    expect(await resolveQualificationPreviewTarget(row)).toBeUndefined();
  });

  test("cleans its first database write if preview creation fails", async () => {
    const queries = await import("../../../src/db/queries/preview-sessions");
    const projects = await import("../../../src/db/queries/projects");
    const realCreate = projects.createProject;
    let createdProjectId = "";
    const created = spyOn(projects, "createProject").mockImplementationOnce(async data => {
      const project = await realCreate(data);
      createdProjectId = project.id;
      return project;
    });
    const failed = spyOn(queries, "createPreviewSession").mockRejectedValueOnce(new Error("injected preview insert failure"));
    try {
      await expect(POST(event(new Request("http://localhost")))).rejects.toThrow("injected preview insert failure");
      expect(failed).toHaveBeenCalledTimes(1);
      expect(await getProject(createdProjectId)).toBeUndefined();
    } finally {
      failed.mockRestore();
      created.mockRestore();
    }
  });

  test("cleans a registered fixture if code minting fails", async () => {
    const tokens = await import("../../../src/runtime/preview/preview-token");
    const failed = spyOn(tokens, "mintOneTimeCode").mockImplementationOnce(() => { throw new Error("injected code failure"); });
    try {
      await expect(POST(event(new Request("http://localhost")))).rejects.toThrow("injected code failure");
      expect(failed).toHaveBeenCalledTimes(1);
    } finally {
      failed.mockRestore();
    }
  });

  test("keeps at most four fixtures and reaps an expired one before admission", async () => {
    const ids: string[] = [];
    const originalTime = Date.now();
    try {
      for (let index = 0; index < 4; index++) {
        const response = await POST(event(new Request("http://localhost")));
        expect(response.status).toBe(200);
        ids.push(((await response.json()) as { previewId: string }).previewId);
      }
      expect((await POST(event(new Request("http://localhost")))).status).toBe(429);
      setSystemTime(new Date(originalTime + 6 * 60_000));
      const next = await POST(event(new Request("http://localhost")));
      expect(next.status).toBe(200);
      expect(await getPreviewByIdRaw(ids[0]!)).toBeUndefined();
      ids.push(((await next.json()) as { previewId: string }).previewId);
    } finally {
      setSystemTime();
      for (const previewId of ids) await DELETE(event(deleteRequest(previewId)));
    }
  });

  test("retains a failed cleanup for the same owner to retry", async () => {
    const seeded = await POST(event(new Request("http://localhost")));
    const { previewId } = await seeded.json() as { previewId: string };
    const projects = await import("../../../src/db/queries/projects");
    const failed = spyOn(projects, "deleteProject").mockRejectedValueOnce(new Error("injected project delete failure"));
    try {
      await expect(DELETE(event(deleteRequest(previewId)))).rejects.toThrow("injected project delete failure");
      expect(await getPreviewByIdRaw(previewId)).toBeUndefined();
    } finally {
      failed.mockRestore();
    }
    expect((await DELETE(event(deleteRequest(previewId), other))).status).toBe(404);
    expect((await DELETE(event(deleteRequest(previewId)))).status).toBe(200);
  });
});
