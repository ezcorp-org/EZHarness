/**
 * The job → consent handoff, bound end to end.
 *
 * ## Why this file exists at all
 *
 * The handoff crosses a boundary that TypeScript cannot see across. An
 * extension cannot import from `web/`, so the query-string contract is
 * WRITTEN TWICE: once as `delegationConsentHref` in
 * `extensions/ez-factory/lib/page.ts`, and once as `GRANT_PARAMS` /
 * `resolveGrantPrefill` in `web/src/lib/workflow-delegations-logic.ts`.
 * Each side has its own unit tests and both pass with the two halves
 * spelling a parameter differently — the link would open the right page,
 * fill in nothing, and the whole feature would be a link to a blank form.
 *
 * This is the one place both halves are in the same process. It feeds the
 * builder's real output into the resolver's real implementation, so a
 * rename on either side fails here.
 *
 * ## And the property that must hold across it
 *
 * The link carries NO authority. Everything it names is re-selected
 * against lists the consent page loaded from the server, and a link naming
 * something those lists do not contain is refused with a sentence rather
 * than written into the form. The tests below assert that from both ends:
 * ez-factory's own link resolves clean, and a link that merely LOOKS like
 * ez-factory's does not.
 */
import { describe, expect, test } from "bun:test";

import {
  DELEGATIONS_HREF,
  EXTENSION_NAME,
  delegationConsentHref,
} from "../../extensions/ez-factory/lib/page";
import type { FactoryJob } from "../../extensions/ez-factory/lib/jobs";
import {
  GRANT_PARAMS,
  resolveGrantPrefill,
} from "../../web/src/lib/workflow-delegations-logic";

const NOW = "2026-08-01T12:00:00.000Z";

function scheduledJob(over: Partial<FactoryJob> = {}): FactoryJob {
  return {
    id: "job-nightly-docs",
    name: "Nightly docs",
    description: "",
    workflow: "docs-factory",
    input: {},
    trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" },
    enabled: true,
    runAs: { kind: "user", id: "u1" },
    consentHash: null,
    createdBy: "u1",
    createdAt: NOW,
    updatedBy: "u1",
    updatedAt: NOW,
    ...over,
  };
}

/** What the delegations page would have loaded for a normal install: the
 *  install row for ez-factory (granted `allowDelegated`) and the three
 *  workflows it ships, under the names the host resolves them by. */
const INSTALLED = {
  extensions: [{ id: "ext-row-7f3c", name: EXTENSION_NAME }],
  workflowNames: [
    `${EXTENSION_NAME}:docs-factory`,
    `${EXTENSION_NAME}:etl-factory`,
    `${EXTENSION_NAME}:draft-and-verify`,
  ],
  current: { extensionId: "", workflowName: "", jobRef: "", triggerKind: "cron" },
};

/** The consent page's own read of a link, exactly as the route does it. */
function resolveHref(href: string, sources = INSTALLED) {
  return resolveGrantPrefill(new URL(href, "https://ezcorp.invalid").searchParams, sources);
}

describe("ez-factory's link resolves on core's consent page", () => {
  test("every field the builder emits is accepted, and nothing is refused", () => {
    const href = delegationConsentHref(scheduledJob());
    expect(href).not.toBeNull();
    const resolved = resolveHref(href as string);
    expect(resolved).not.toBeNull();
    expect(resolved?.rejected).toEqual([]);
    // All four — the point of the handoff is that a human retypes none of
    // them, least of all the job reference.
    expect(resolved?.applied).toEqual(["Extension", "Workflow", "Job reference", "Trigger"]);
    expect(resolved?.draft).toEqual({
      // Resolved by NAME to the install ROW ID, because a Hub page render
      // is never told the row id — pages are addressed `ext:<name>:<page>`.
      extensionId: "ext-row-7f3c",
      workflowName: `${EXTENSION_NAME}:docs-factory`,
      jobRef: "job-nightly-docs",
      triggerKind: "cron",
    });
  });

  test("the job reference survives the round trip BYTE FOR BYTE", () => {
    // This is the entire feature. A `job_ref` that differs by one
    // character produces `DELEGATION_NOT_FOUND` at the first fire, audited
    // without a `delegation_id` on a page that says it cannot show that
    // denial — so the only symptom is an unattended job that never runs.
    const id = "job-a_b-0123456789abcdef";
    const href = delegationConsentHref(scheduledJob({ id })) as string;
    expect(resolveHref(href)?.draft.jobRef).toBe(id);
  });

  test("all three shipped templates resolve", () => {
    for (const workflow of ["docs-factory", "etl-factory", "draft-and-verify"] as const) {
      const href = delegationConsentHref(scheduledJob({ workflow })) as string;
      const resolved = resolveHref(href);
      expect(resolved?.rejected).toEqual([]);
      expect(resolved?.draft.workflowName).toBe(`${EXTENSION_NAME}:${workflow}`);
    }
  });

  test("both sides spell the four parameters the same way", () => {
    const href = delegationConsentHref(scheduledJob()) as string;
    const keys = [...new URL(href, "https://ezcorp.invalid").searchParams.keys()].sort();
    expect(keys).toEqual(Object.values(GRANT_PARAMS).sort());
  });

  test("the builder points at the route the page actually lives on", () => {
    expect(DELEGATIONS_HREF).toBe("/workflows/delegations");
  });
});

describe("the link carries no authority — the page re-selects everything", () => {
  test("a link naming an extension the admin did NOT approve is refused", () => {
    // `extensions` here is what `/api/extensions` answered, already
    // filtered to installs GRANTED `workflows.allowDelegated`. An
    // extension absent from it is one an administrator declined, and a URL
    // must not be able to put it in the form regardless of how the link
    // was authored.
    const href = delegationConsentHref(scheduledJob()) as string;
    const resolved = resolveHref(href, { ...INSTALLED, extensions: [] });
    expect(resolved?.draft.extensionId).toBe("");
    expect(resolved?.rejected.join(" ")).toContain(EXTENSION_NAME);
  });

  test("a link naming a workflow this session cannot see is refused", () => {
    const href = delegationConsentHref(scheduledJob()) as string;
    const resolved = resolveHref(href, { ...INSTALLED, workflowNames: [] });
    expect(resolved?.draft.workflowName).toBe("");
    expect(resolved?.rejected.join(" ")).toContain("docs-factory");
  });

  test("a HAND-CRAFTED link cannot smuggle a workflow past the picker", () => {
    // The attack the shape invites: a URL that looks like ez-factory's own
    // and swaps the workflow for something the reader is not expecting.
    // It cannot select a name the workflow picker does not offer, so the
    // most a crafted link achieves is selecting something the person could
    // already have selected by hand — with the values on screen and the
    // banner naming the link as their source.
    const crafted =
      `${DELEGATIONS_HREF}?${GRANT_PARAMS.extensionId}=${EXTENSION_NAME}` +
      `&${GRANT_PARAMS.jobRef}=job-nightly-docs` +
      `&${GRANT_PARAMS.workflowName}=admin%3Arotate-all-secrets` +
      `&${GRANT_PARAMS.triggerKind}=cron`;
    const resolved = resolveHref(crafted);
    expect(resolved?.draft.workflowName).toBe("");
    expect(resolved?.applied).not.toContain("Workflow");
    expect(resolved?.rejected.join(" ")).toContain("admin:rotate-all-secrets");
  });

  test("a crafted link cannot mint anything: the result is form state, not a grant", () => {
    // The shape of the return value IS the guarantee — there is no branch
    // in which `resolveGrantPrefill` produces a delegation, a request, or
    // a token. Both spend bounds are absent from it entirely, and the
    // route requires both, so the person types them or nothing happens.
    const href = delegationConsentHref(scheduledJob()) as string;
    const resolved = resolveHref(href);
    expect(Object.keys(resolved?.draft ?? {}).sort()).toEqual([
      "extensionId",
      "jobRef",
      "triggerKind",
      "workflowName",
    ]);
    expect(resolved?.draft).not.toHaveProperty("maxTokensPerRun");
    expect(resolved?.draft).not.toHaveProperty("maxRunsPerDay");
    expect(resolved?.draft).not.toHaveProperty("ownerKind");
  });
});
