/**
 * The provenance badge, which exists because the raw `visibility` tier is
 * a misleading label.
 *
 * `system` collapses three rows a user must be able to tell apart: an
 * install-shipped file, an ownerless legacy row, and one somebody here
 * created and still owns. Rendering the tier verbatim told every reader
 * "ships with EZCorp" about all three — including the workflow they had
 * made themselves thirty seconds earlier, since a create defaults to
 * `system` and stamps its author.
 */
import { describe, test, expect } from "bun:test";
import {
  workflowProvenanceBadge,
  type WorkflowProvenanceInput,
} from "../lib/workflow-provenance";

/** A DB row a member created and owns — the create route's default shape. */
const OWNED_SYSTEM: WorkflowProvenanceInput = {
  visibility: "system",
  userId: "u-owner",
  source: "db",
};

describe("the three faces of `system`", () => {
  test("a member's own default-visibility row is `instance-wide`, never `system`", () => {
    const badge = workflowProvenanceBadge(OWNED_SYSTEM);
    expect(badge.label).toBe("instance-wide");
    // The word the user was previously shown, and the whole complaint.
    expect(badge.label).not.toBe("system");
    // It says both halves: who may RUN it and who may CHANGE it.
    expect(badge.title).toContain("anyone on this instance");
    expect(badge.title).toContain("owner");
  });

  test("an install-shipped asset is `built-in`, on either non-db source", () => {
    for (const source of ["yaml", "extension"]) {
      const badge = workflowProvenanceBadge({ ...OWNED_SYSTEM, source, userId: null });
      expect(badge.label).toBe("built-in");
      expect(badge.title).toContain("Ships with EZCorp");
    }
  });

  test("an ownerless DB row is `unowned` — admin-only, and not shipped with anything", () => {
    // The row the C6 migration produced, and the row `ON DELETE SET NULL`
    // mints when an owner is deleted. Calling it `built-in` would be a
    // lie (nobody shipped it) and calling it `instance-wide` would imply
    // an owner who could fix it.
    const badge = workflowProvenanceBadge({ visibility: "system", userId: null, source: "db" });
    expect(badge.label).toBe("unowned");
    expect(badge.title).toContain("no owner");
    expect(badge.title).toContain("admin");
  });

  test("the three `system` rows produce three DIFFERENT labels", () => {
    // The point of the whole module, asserted as the set rather than
    // one case at a time: three rows that share a tier must not share a
    // badge, or the badge has told the user nothing.
    const labels = [
      workflowProvenanceBadge(OWNED_SYSTEM).label,
      workflowProvenanceBadge({ ...OWNED_SYSTEM, userId: null }).label,
      workflowProvenanceBadge({ ...OWNED_SYSTEM, source: "yaml", userId: null }).label,
    ];
    expect(new Set(labels).size).toBe(3);
  });

  test("`built-in` and `unowned` are distinguishable without hovering", () => {
    // A tooltip nobody opens is not a distinction. The two rows a user
    // cannot act on carry their own colour; the ordinary one stays
    // neutral so the accent means something.
    const builtIn = workflowProvenanceBadge({ ...OWNED_SYSTEM, source: "yaml", userId: null });
    const unowned = workflowProvenanceBadge({ ...OWNED_SYSTEM, userId: null });
    const owned = workflowProvenanceBadge(OWNED_SYSTEM);
    expect(builtIn.className).not.toBe(owned.className);
    expect(unowned.className).not.toBe(owned.className);
    expect(builtIn.className).not.toBe(unowned.className);
  });
});

describe("the other tiers keep their own names", () => {
  test("`project` and `private` are unchanged by ownership or source", () => {
    // Only `system` was ambiguous. A change that re-labelled these would
    // be churn on words that already say what they mean.
    for (const userId of ["u-owner", null]) {
      expect(workflowProvenanceBadge({ visibility: "project", userId, source: "db" }).label).toBe(
        "project",
      );
      expect(workflowProvenanceBadge({ visibility: "private", userId, source: "db" }).label).toBe(
        "private",
      );
    }
  });

  test("each tier explains who may run it and who may change it", () => {
    expect(workflowProvenanceBadge({ visibility: "private" }).title).toContain("admin");
    expect(workflowProvenanceBadge({ visibility: "project" }).title).toContain("creator");
  });
});

describe("what the badge must never say", () => {
  test("no label or title ever contains a user id", () => {
    // `userId` is read for `!== null` and nothing else. A provenance pill
    // that named the owner would be a directory of who works here,
    // rendered to every viewer of every workflow.
    const secret = "u-jane-doe-0000";
    for (const input of [
      { visibility: "system", userId: secret, source: "db" },
      { visibility: "project", userId: secret, source: "db" },
      { visibility: "private", userId: secret, source: "db" },
      { visibility: "system", userId: secret, source: "yaml" },
    ]) {
      const badge = workflowProvenanceBadge(input);
      expect(JSON.stringify(badge)).not.toContain(secret);
    }
  });

  test("a payload missing every field still renders a badge, never a blank pill", () => {
    // The wire shape is additive, so an older server (or a fixture) can
    // omit all three. `system` is the server's own create default, so
    // falling into that family is the honest guess — and with no owner
    // recorded, `unowned` is the fail-closed member of it.
    const badge = workflowProvenanceBadge({});
    expect(badge.label).toBe("unowned");
    expect(badge.label.length).toBeGreaterThan(0);
    expect(badge.title.length).toBeGreaterThan(0);
    expect(badge.className.length).toBeGreaterThan(0);
  });

  test("an unrecognised tier falls into the `system` family rather than rendering itself", () => {
    // A tier this build does not know must not be echoed into the UI as
    // an unexplained word — the server is the only thing that can add
    // one, and until this module learns it, the fail-closed reading is
    // the family whose default it shares.
    const badge = workflowProvenanceBadge({ visibility: "team", userId: "u-owner", source: "db" });
    expect(badge.label).toBe("instance-wide");
    expect(badge.label).not.toBe("team");
  });
});
