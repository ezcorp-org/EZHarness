/**
 * C3 phase 4 — the pure consent-time policy.
 *
 * The load-bearing property here is amended spec §6.1, and it is stated
 * as a PAIR everywhere it appears: the refusal is worthless without the
 * matching success, because a deny-everyone bug passes every "it refuses"
 * test ever written. In particular the headline row —
 * *a `user`-kind delegation for a `project`-visible forked workflow must
 * SUCCEED; only the `service` kind is refused* — is asserted directly.
 */
import { test, expect, describe } from "bun:test";
import {
  DELEGATION_CONSENT_DENIALS,
  authorizeDelegationConsent,
  buildConsentHashSources,
  delegationPrincipal,
  delegationVersionIdentity,
  delegationWorkflowResolver,
  mayManageDelegation,
  resolveDelegationVersionPin,
} from "../runtime/workflow-delegation-consent";
import { workflowDefinitionHash } from "../runtime/workflow-definition-hash";
import { NO_PROJECT_MEMBERSHIPS, type CachedWorkflow } from "../runtime/workflow-scope";
import type { WorkflowDefinition, WorkflowVisibility } from "../types";

const OWNER = "user-owner";
const STRANGER = "user-stranger";

function definition(name: string, child?: string): WorkflowDefinition {
  return {
    name,
    description: "",
    steps:
      child === undefined
        ? [{ name: "s1", agent: "writer", input: {} }]
        : [{ name: "s1", kind: "workflow", workflow: child, input: {} }],
  } as unknown as WorkflowDefinition;
}

function entry(
  name: string,
  visibility: WorkflowVisibility,
  userId: string | null = OWNER,
  child?: string,
): CachedWorkflow {
  return {
    definition: definition(name, child),
    source: "db",
    id: `id-${name}`,
    projectId: null,
    userId,
    visibility,
    forkedFrom: null,
  };
}

// ── delegationPrincipal — the keyed lookup, both arms ───────────────

describe("delegationPrincipal", () => {
  test("a user delegation carries the owner's user id", () => {
    expect(delegationPrincipal("user", OWNER)).toEqual({
      userId: OWNER,
      role: "member",
      projectMemberships: NO_PROJECT_MEMBERSHIPS,
    });
  });

  test("a service delegation carries NO user id, discarding the account id", () => {
    // The account id is a real id — it just is not a USER identity, and
    // the ladder's project-less `project` rung tests exactly
    // `caller.userId !== null`.
    expect(delegationPrincipal("service", "svc-1")).toEqual({
      userId: null,
      role: "member",
      projectMemberships: NO_PROJECT_MEMBERSHIPS,
    });
  });

  test("neither arm carries admin, whoever the owner is", () => {
    // An unattended cron tick must not run with admin reach just because
    // an admin consented to it.
    expect(delegationPrincipal("user", OWNER).role).toBe("member");
    expect(delegationPrincipal("service", "svc-1").role).toBe("member");
  });

  test("neither arm carries PROJECT MEMBERSHIPS, whoever the owner is", () => {
    // The same ruling as the role clamp above, on the axis
    // `project_members` added: a delegation is consented to once, so a
    // principal carrying LIVE memberships would widen that consent every
    // time the owner joined a project. Empty is the fail-closed set, and
    // it is what stops an unattended tick reaching a project-scoped row.
    for (const kind of ["user", "service"] as const) {
      expect(delegationPrincipal(kind, OWNER).projectMemberships).toEqual([]);
    }
  });
});

// ── §6.1 — the consent-time refusal, ALWAYS paired with its success ──

describe("authorizeDelegationConsent — the owner-kind × visibility matrix", () => {
  test("system: BOTH kinds are allowed", () => {
    const entries = [entry("w", "system")];
    expect(authorizeDelegationConsent(entries, "w", "service", "svc-1").ok).toBe(true);
    expect(authorizeDelegationConsent(entries, "w", "user", OWNER).ok).toBe(true);
  });

  test("project (what fork stamps): a USER delegation SUCCEEDS", () => {
    // The half that a deny-everyone bug would break. C3's headline use
    // case is delegating a fork, and fork stamps `visibility: "project"`.
    const result = authorizeDelegationConsent([entry("fork", "project")], "fork", "user", OWNER);
    expect(result.ok).toBe(true);
  });

  test("project: a user delegation succeeds even for a NON-owner", () => {
    // Pinning today's reach honestly: `project` admits every
    // authenticated principal, not just the row's owner. Nobody should
    // later read this ladder as narrower than it is.
    const result = authorizeDelegationConsent(
      [entry("fork", "project", OWNER)],
      "fork",
      "user",
      STRANGER,
    );
    expect(result.ok).toBe(true);
  });

  test("project: a SERVICE delegation is refused, naming reason and remedy", () => {
    const result = authorizeDelegationConsent([entry("fork", "project")], "fork", "service", "s1");
    expect(result).toEqual({
      ok: false,
      code: DELEGATION_CONSENT_DENIALS.OWNER_CANNOT_RUN,
      message:
        'A service account can only run system-visible workflows, and "fork" is not one. ' +
        'Choose "run as me", or ask an admin to make the workflow system-visible.',
    });
  });

  test("private: the owner's user delegation SUCCEEDS, a stranger's is refused", () => {
    const entries = [entry("secret", "private", OWNER)];
    expect(authorizeDelegationConsent(entries, "secret", "user", OWNER).ok).toBe(true);
    const denied = authorizeDelegationConsent(entries, "secret", "user", STRANGER);
    expect(denied).toMatchObject({
      ok: false,
      code: DELEGATION_CONSENT_DENIALS.OWNER_CANNOT_RUN,
    });
  });

  test("private: a service delegation is refused", () => {
    const result = authorizeDelegationConsent(
      [entry("secret", "private")],
      "secret",
      "service",
      "s1",
    );
    expect(result).toMatchObject({ ok: false, code: DELEGATION_CONSENT_DENIALS.OWNER_CANNOT_RUN });
  });

  test("an unknown name is NOT_FOUND, distinct from an unauthorized one", () => {
    const result = authorizeDelegationConsent([entry("w", "system")], "nope", "user", OWNER);
    expect(result).toEqual({
      ok: false,
      code: DELEGATION_CONSENT_DENIALS.NOT_FOUND,
      message: 'No workflow named "nope" is visible to this principal.',
    });
  });

  test("the two consent-time codes are distinct from the reserved fire-time one", () => {
    // The re-tiering case (a `system` workflow later made `project`) is
    // phase 6's, and folding it into the consent-time code would make the
    // two indistinguishable in `disabled_reason` — the one place a user
    // reads why their job stopped.
    const codes = [
      DELEGATION_CONSENT_DENIALS.OWNER_CANNOT_RUN,
      DELEGATION_CONSENT_DENIALS.OWNER_LOST_ACCESS,
      DELEGATION_CONSENT_DENIALS.NOT_FOUND,
      DELEGATION_CONSENT_DENIALS.VERSION_DIVERGENCE,
      DELEGATION_CONSENT_DENIALS.NOT_CONSENTER,
    ];
    expect(new Set(codes).size).toBe(codes.length);
    expect(DELEGATION_CONSENT_DENIALS.OWNER_LOST_ACCESS).toBe(
      "DELEGATION_OWNER_LOST_WORKFLOW_ACCESS",
    );
  });

  test("the refusal message differs per owner kind", () => {
    const svc = authorizeDelegationConsent([entry("w", "private")], "w", "service", "s1");
    const usr = authorizeDelegationConsent([entry("w", "private")], "w", "user", STRANGER);
    expect(svc.ok).toBe(false);
    expect(usr.ok).toBe(false);
    const both = [svc, usr].map((r) => (r.ok ? "" : r.message));
    expect(both[0]).not.toBe(both[1]);
  });
});

// ── the OWNER's resolver — per-kind closure divergence ──────────────

describe("delegationWorkflowResolver", () => {
  const entries = [entry("root", "system", null, "child"), entry("child", "project")];

  test("a user principal reaches a project-visible child", () => {
    const resolve = delegationWorkflowResolver(entries, delegationPrincipal("user", OWNER));
    expect(resolve("child")?.name).toBe("child");
  });

  test("a service principal does NOT — the same graph resolves smaller", () => {
    const resolve = delegationWorkflowResolver(entries, delegationPrincipal("service", "s1"));
    expect(resolve("child")).toBeUndefined();
    // …and still reaches the system-visible root, so this is a narrowing
    // rather than a resolver that answers nothing.
    expect(resolve("root")?.name).toBe("root");
  });

  test("the two principals therefore produce DIFFERENT consent hashes", async () => {
    const { computeWorkflowConsentHash } = await import("../runtime/workflow-capability-hash");
    const lookups = {
      capabilitiesForTool: () => [],
      capabilitiesForAgent: () => [],
      identify: () => ({ kind: "unversioned" as const }),
    };
    const delegation = {
      extensionName: "ext",
      workflowName: "root",
      projectId: null,
      runAs: { kind: "user", id: OWNER },
      trigger: { kind: "cron", spec: { expr: "0 * * * *" } },
    };
    const asUser = computeWorkflowConsentHash(
      entries[0]!.definition,
      delegation,
      buildConsentHashSources(entries, delegationPrincipal("user", OWNER), lookups),
    );
    const asService = computeWorkflowConsentHash(
      entries[0]!.definition,
      delegation,
      buildConsentHashSources(entries, delegationPrincipal("service", "s1"), lookups),
    );
    expect(asUser.hash).not.toBe(asService.hash);
    // …and the difference is legible, not incidental: the service view
    // records the child as unresolved.
    expect(asService.material.unresolved).toEqual(["child"]);
    expect(asUser.material.unresolved).toEqual([]);
  });

  test("a denial and a missing name are indistinguishable to the resolver", () => {
    // Distinguishing them would leak the existence of a workflow the
    // principal may not see into the material a human is shown.
    const resolve = delegationWorkflowResolver(entries, delegationPrincipal("service", "s1"));
    expect(resolve("child")).toBe(resolve("no-such-workflow"));
  });
});

// ── Ruling 2: the pinned-version divergence ─────────────────────────

describe("resolveDelegationVersionPin", () => {
  const target = entry("w", "system");
  const matchingHash = workflowDefinitionHash(target.definition);

  test("no version row at all pins NULL — the documented unversioned path", () => {
    expect(resolveDelegationVersionPin(target, undefined, "w")).toEqual({
      ok: true,
      definitionVersionId: null,
    });
  });

  test("a version whose content matches is pinned", () => {
    expect(
      resolveDelegationVersionPin(target, { id: "v1", version: 1, stepsHash: matchingHash }, "w"),
    ).toEqual({ ok: true, definitionVersionId: "v1" });
  });

  test("a version whose content DIVERGED is refused, not silently pinned", () => {
    // This is the exact predicate `workflow-executor.ts:629` applies
    // before writing `definition_version_id` onto a run. If we pinned it
    // anyway, the delegation would claim a version the run declines to
    // record and the audit trail would disagree with the consent record.
    const result = resolveDelegationVersionPin(
      target,
      { id: "v1", version: 1, stepsHash: "not-the-content-hash" },
      "w",
    );
    expect(result).toEqual({
      ok: false,
      code: DELEGATION_CONSENT_DENIALS.VERSION_DIVERGENCE,
      message:
        'The saved snapshot of "w" does not match the definition that would run, ' +
        "so a run started from this delegation could not record which version it executed. " +
        "Save the workflow again, then re-consent.",
    });
  });

  test("the pin and the child identity read the same fact", () => {
    // One computation, two consequences. If these ever disagreed, a
    // delegation could pin a version while its own consent hash recorded
    // that same definition as having none.
    const diverged = { id: "v1", version: 1, stepsHash: "other" };
    expect(delegationVersionIdentity(target.definition, diverged)).toEqual({
      kind: "unversioned",
    });
    expect(resolveDelegationVersionPin(target, diverged, "w").ok).toBe(false);

    const matching = { id: "v1", version: 3, stepsHash: matchingHash };
    expect(delegationVersionIdentity(target.definition, matching)).toEqual({
      kind: "version",
      versionId: "v1",
      version: 3,
    });
    expect(resolveDelegationVersionPin(target, matching, "w")).toEqual({
      ok: true,
      definitionVersionId: "v1",
    });
  });

  test("an absent version yields the unversioned identity too", () => {
    expect(delegationVersionIdentity(target.definition, undefined)).toEqual({
      kind: "unversioned",
    });
  });
});

// ── who may manage a delegation ─────────────────────────────────────

describe("mayManageDelegation", () => {
  const row = { consentedByUserId: OWNER };

  test("the consenting human may", () => {
    expect(mayManageDelegation(row, { id: OWNER, role: "member" })).toBe(true);
  });

  test("an admin may, so a departed consenter's authority is still endable", () => {
    expect(mayManageDelegation(row, { id: STRANGER, role: "admin" })).toBe(true);
  });

  test("another member may not", () => {
    expect(mayManageDelegation(row, { id: STRANGER, role: "member" })).toBe(false);
  });
});
