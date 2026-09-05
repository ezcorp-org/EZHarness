/**
 * `resolveDelegationConsentOr` — the C3 adapter in
 * `$lib/server/workflow-access`, tested against the REAL rule.
 *
 * Everything here is deliberately unmocked except the workflow cache:
 * `authorizeDelegationConsent`, `resolveWorkflowForCaller`, the ladder and
 * `errorJson` all run for real, because the two things this adapter can get
 * wrong are both invisible to a fake:
 *
 *  1. **Which principal the question is asked as.** This is the ONE entry
 *     point in the module that does not authorize the caller — it authorizes
 *     the principal the delegation will CARRY. A stubbed rule would answer
 *     for whichever caller the test invented and the §6.1 refusal — the one
 *     that stops a service-account delegation being minted for a
 *     `project`-visible fork — would pass while doing nothing.
 *  2. **Which status a refusal becomes.** `NOT_FOUND` is a 404 and every
 *     other denial is a 403, and the branch that picks between them is one
 *     `===` away from answering 403 to a name nobody can see.
 *
 * The consent ROUTE's own suite (`api-workflows-delegations.server.test.ts`)
 * mocks this module, which is right for a wiring test and is exactly why the
 * adapter needs its own file: mocked there, it is executed nowhere.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const ctx = vi.hoisted(() => ({ getCachedWorkflows: vi.fn(() => [] as unknown[]) }));
vi.mock("$lib/server/context", () => ctx);
const consent = vi.hoisted(() => ({ buildDelegationConsent: vi.fn() }));
vi.mock("$lib/server/delegation-consent", () => consent);
vi.mock("$server/extensions/registry", () => ({ ExtensionRegistry: { getInstance: () => ({ getManifest: () => ({ name: "sealed" }) }) } }));

const { resolveDelegationConsentOr } = await import("../lib/server/workflow-access");
const { POST: preview } = await import("../routes/api/workflows/delegations/preview/+server");
import { makeRequestEvent } from "./helpers/server-route-test-utils";
import { releaseRuntimeFixture } from "$server/__tests__/helpers/release-runtime";
import { releaseBinding } from "$server/extensions/release-process";
const authority = vi.hoisted(() => ({ active: true, member: true }));
vi.mock("$server/db/queries/users", () => ({ getUserById: async (id: string) => ({ id, status: authority.active ? "active" : "disabled", role: "member" }) }));
vi.mock("$server/db/queries/project-members", () => ({ getProjectMembership: async () => authority.member ? { role: "member" } : null, listProjectIdsForUser: async () => [] }));

/** A cache entry at an explicit tier and owner — the two axes the ladder
 *  reads. `source: "db"` because a delegation names a saved workflow. */
function entry(name: string, visibility: "system" | "project" | "private", userId: string | null) {
  return {
    definition: { name, description: "", steps: [] },
    source: "db",
    id: `id-${name}`,
    projectId: null,
    userId,
    visibility,
    forkedFrom: null,
  };
}

beforeEach(() => {
  ctx.getCachedWorkflows.mockReset().mockReturnValue([]);
  consent.buildDelegationConsent.mockReset().mockResolvedValue({ material: { graph: [] }, capabilitySet: [], consentHash: "hash", definitionVersionId: null });
  authority.active = true;
  authority.member = true;
});

test("HTTP consent preview rejects an extension cache entry without a live sealed binding before reading metadata", async () => {
  ctx.getCachedWorkflows.mockReturnValue([{ ...entry("sealed:private", "private", "u-owner"), source: "extension", id: null }]);
  const response = await preview(makeRequestEvent("http://localhost/api/workflows/delegations/preview", {
    locals: { user: { id: "u-owner", email: "owner@example.test", name: "Owner", role: "member" }, authMethod: "session" },
    request: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ extensionId: "installation", workflowName: "sealed:private", ownerKind: "user", triggerKind: "cron" }) },
  }));
  expect(response.status).toBe(404);
  expect(consent.buildDelegationConsent).not.toHaveBeenCalled();
});

test("HTTP preview checks the live owner, scope, generation and release state before consent metadata", async () => {
  const fixture = releaseRuntimeFixture("installation", { schemaVersion: 4, name: "sealed", version: "1.0.0", description: "Fixture", author: { name: "Owner" }, permissions: {} }, { ownerId: "u-owner" });
  fixture.configure();
  const original = structuredClone(fixture.snapshot.installation);
  const cacheEntry = { ...entry("sealed:private", "private", "u-owner"), source: "extension", id: null, extensionRelease: { installationId: "installation", ownerId: "u-owner", scope: "global", binding: releaseBinding(fixture.snapshot) } };
  ctx.getCachedWorkflows.mockReturnValue([cacheEntry]);
  const request = (projectId?: string) => preview(makeRequestEvent("http://localhost/api/workflows/delegations/preview", {
    locals: { user: { id: "u-owner", email: "owner@example.test", name: "Owner", role: "member" }, authMethod: "session" },
    request: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ extensionId: "installation", workflowName: "sealed:private", ownerKind: "user", triggerKind: "cron", ...(projectId ? { projectId } : {}) }) },
  }));
  expect((await request()).status).toBe(200);
  expect(consent.buildDelegationConsent).toHaveBeenCalledTimes(1);
  for (const mutation of [{ enabled: false }, { uninstalled: true }, { acknowledgedGeneration: 0 }, { generation: 2 }, { ownerId: "different-owner" }, { scope: "project:another" }]) {
    fixture.snapshot.installation = { ...original, ...mutation };
    expect((await request()).status).toBe(404);
  }
  fixture.snapshot.installation = original;
  authority.active = false;
  expect((await request()).status).toBe(404);
  authority.active = true;
  fixture.snapshot.installation.scope = "project:owned";
  cacheEntry.extensionRelease.scope = "project:owned";
  cacheEntry.extensionRelease.binding = releaseBinding(fixture.snapshot);
  authority.member = false;
  expect((await request("owned")).status).toBe(404);
  expect(consent.buildDelegationConsent).toHaveBeenCalledTimes(1);
});

describe("resolveDelegationConsentOr", () => {
  test("a system-visible workflow resolves for a SERVICE owner and returns the entry", async () => {
    ctx.getCachedWorkflows.mockReturnValue([entry("ship-it", "system", null)]);

    // `ownerUserId` is null on the service arm — a service account has no
    // `users` row, which is the whole of its reach model.
    const result = await resolveDelegationConsentOr("ship-it", "service", null);

    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    expect(result.entry.definition.name).toBe("ship-it");
    expect(result.entry.visibility).toBe("system");
    // Read through the mocked cache and not from some other source.
    expect(ctx.getCachedWorkflows).toHaveBeenCalledTimes(1);
  });

  test("a PROJECT-visible workflow is refused 403 for a service owner, naming the remedy", async () => {
    // The §6.1 case, and C3's headline one: fork stamps `project`, a service
    // account reaches `system` only.
    ctx.getCachedWorkflows.mockReturnValue([entry("forked", "project", "u-owner")]);

    const result = await resolveDelegationConsentOr("forked", "service", null);

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(403);
    const body = (await result.json()) as { error: string };
    // The RULE's own message, carried through rather than replaced by a bare
    // status — it names the reason and both remedies.
    expect(body.error).toContain("system-visible");
    expect(body.error).toContain("run as me");
    expect(body.error).toContain("forked");
  });

  test("the SAME project workflow resolves when the owner arm is a user", async () => {
    // Same entry, same name, different principal — so the 403 above is a
    // property of the principal the delegation carries and not of the row.
    ctx.getCachedWorkflows.mockReturnValue([entry("forked", "project", "u-owner")]);

    const result = await resolveDelegationConsentOr("forked", "user", "u-someone");

    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    expect(result.entry.definition.name).toBe("forked");
  });

  test("a PRIVATE workflow the user does not own is refused 403 with the user-arm message", async () => {
    ctx.getCachedWorkflows.mockReturnValue([entry("secret", "private", "u-owner")]);

    const result = await resolveDelegationConsentOr("secret", "user", "u-stranger");

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    // 403 and not 404: the denial code is OWNER_CANNOT_RUN, which is the
    // arm of the status branch that is NOT `NOT_FOUND`.
    expect(result.status).toBe(403);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("cannot delegate");
    expect(body.error).not.toContain("system-visible");
  });

  test("an unknown name is 404, with the message the rule wrote", async () => {
    ctx.getCachedWorkflows.mockReturnValue([entry("ship-it", "system", null)]);

    const result = await resolveDelegationConsentOr("no-such-workflow", "user", "u-1");

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(404);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("no-such-workflow");
    expect(body.error).toContain("visible to this principal");
  });

  test("an empty cache is a 404 rather than a throw", async () => {
    const result = await resolveDelegationConsentOr("anything", "service", null);

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(404);
  });
});
