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

const { resolveDelegationConsentOr } = await import("../lib/server/workflow-access");

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
});

describe("resolveDelegationConsentOr", () => {
  test("a system-visible workflow resolves for a SERVICE owner and returns the entry", async () => {
    ctx.getCachedWorkflows.mockReturnValue([entry("ship-it", "system", null)]);

    // `ownerUserId` is null on the service arm — a service account has no
    // `users` row, which is the whole of its reach model.
    const result = resolveDelegationConsentOr("ship-it", "service", null);

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

    const result = resolveDelegationConsentOr("forked", "service", null);

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

    const result = resolveDelegationConsentOr("forked", "user", "u-someone");

    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    expect(result.entry.definition.name).toBe("forked");
  });

  test("a PRIVATE workflow the user does not own is refused 403 with the user-arm message", async () => {
    ctx.getCachedWorkflows.mockReturnValue([entry("secret", "private", "u-owner")]);

    const result = resolveDelegationConsentOr("secret", "user", "u-stranger");

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

    const result = resolveDelegationConsentOr("no-such-workflow", "user", "u-1");

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(404);
    const body = (await result.json()) as { error: string };
    expect(body.error).toContain("no-such-workflow");
    expect(body.error).toContain("visible to this principal");
  });

  test("an empty cache is a 404 rather than a throw", async () => {
    const result = resolveDelegationConsentOr("anything", "service", null);

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(404);
  });
});
