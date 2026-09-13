import { test, expect } from "../fixtures/hydration.js";
import type { APIRequestContext } from "@playwright/test";
import { referenceCodeV1, type FactoryApiResponse, type FactoryDefinition } from "../../../packages/@ezcorp/factory-sdk/src/index";

function mutation(
  request: APIRequestContext,
  method: "post" | "put" | "delete",
  path: string,
  revision: number,
  idempotencyKey: string,
  data?: unknown,
) {
  return request[method](path, {
    headers: { "If-Match": String(revision), "Idempotency-Key": idempotencyKey },
    ...(data === undefined ? {} : { data }),
  });
}

test.describe("factory authoring authority", () => {
  test("create, race, publish, and revoke authoring through real HTTP and storage", async ({ request }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const projectResponse = await request.post("/api/projects", {
      data: { name: `Factory E2E ${suffix}`, path: `/tmp/ezharness-factory-${suffix}` },
    });
    expect(projectResponse.status(), await projectResponse.text()).toBe(201);
    const project = (await projectResponse.json()) as { id: string };
    const base = `/api/factories/projects/${project.id}`;

    const meResponse = await request.get("/api/auth/me");
    expect(meResponse.status(), await meResponse.text()).toBe(200);
    const userId = ((await meResponse.json()) as { user: { id: string } }).user.id;

    const factoryId = `e2e-factory-${suffix}`;
    const source: FactoryDefinition = { ...structuredClone(referenceCodeV1), id: factoryId };
    const create = await mutation(request, "post", `${base}/definitions`, 0, `create-${suffix}`, { source });
    expect(create.status(), await create.text()).toBe(200);
    const created = (await create.json()) as Extract<FactoryApiResponse, { kind: "draft.summary" }>;
    expect(created.resource).toMatchObject({ factoryId, revision: 1, archived: false });

    const writes = await Promise.all([
      mutation(request, "put", `${base}/definitions/${factoryId}`, 1, `race-a-${suffix}`, { source: { ...source, presentation: { label: "Race A" } } }),
      mutation(request, "put", `${base}/definitions/${factoryId}`, 1, `race-b-${suffix}`, { source: { ...source, presentation: { label: "Race B" } } }),
    ]);
    expect(writes.map(response => response.status()).sort()).toEqual([200, 412]);

    const currentResponse = await request.get(`${base}/definitions/${factoryId}`);
    expect(currentResponse.status(), await currentResponse.text()).toBe(200);
    const current = (await currentResponse.json()) as Extract<FactoryApiResponse, { kind: "draft.details" }>;
    expect(current.resource.revision).toBe(2);
    expect(["Race A", "Race B"]).toContain((current.resource.source.presentation as { label?: string } | undefined)?.label);

    const publish = await mutation(request, "post", `${base}/definitions/${factoryId}/versions`, 2, `publish-${suffix}`, { version: source.version });
    expect(publish.status(), await publish.text()).toBe(200);
    expect((await publish.json()) as FactoryApiResponse).toMatchObject({ kind: "version.summary", resource: { factoryId, version: source.version, draftRevision: 2 } });

    const grantsResponse = await request.get(`${base}/grants?principalKind=user&action=factory.author`);
    expect(grantsResponse.status(), await grantsResponse.text()).toBe(200);
    const grantPage = (await grantsResponse.json()) as Extract<FactoryApiResponse, { kind: "grant.page" }>;
    const grant = grantPage.page.items.find(item => item.principalId === userId);
    expect(grant, "project bootstrap must grant its owner factory.author").toBeDefined();

    const grantPath = `${base}/grants/user/${userId}/factory.author`;
    const revoke = await mutation(request, "delete", grantPath, grant!.revision, `revoke-${suffix}`);
    expect(revoke.status(), await revoke.text()).toBe(200);
    const revoked = (await revoke.json()) as Extract<FactoryApiResponse, { kind: "grant.resource" }>;
    expect(revoked.resource).toMatchObject({ revision: grant!.revision + 1, revoked: true });

    try {
      const refusedSource = { ...source, id: `${factoryId}-refused` };
      const refused = await mutation(request, "post", `${base}/definitions`, 0, `refused-${suffix}`, { source: refusedSource });
      expect(refused.status(), await refused.text()).toBe(403);
    } finally {
      const restore = await mutation(request, "put", grantPath, revoked.resource.revision, `restore-${suffix}`, { expiresAtMs: null });
      expect(restore.status(), await restore.text()).toBe(200);
    }
  });
});
