/**
 * What a workflow's provenance badge SAYS, framework-free.
 *
 * ## Why the visibility tier alone is not a badge
 *
 * The editor used to render `workflow.visibility` verbatim, so a row read
 * `system` — a word every user parses as "ships with EZCorp, don't
 * touch". That was true when `system` was admin-only to edit. It is not
 * true now: `POST /api/workflows` DEFAULTS a new row to `system` and
 * stamps its creator, and the ladder's `edit` rung asks ownership before
 * the tier, so an ordinary member's very first workflow is a `system`
 * row they own and can rewrite. Labelling it "system" tells the reader
 * the opposite of what it is.
 *
 * ## Three states, because the tier really does mean three things
 *
 * `system` collapses three genuinely different rows, and they are
 * exactly the three answers the `edit` rung gives for that tier — so the
 * badge is not decoration, it is the ladder's own verdict in a word:
 *
 * | row                                  | edit verdict           | badge          |
 * |---|---|---|
 * | YAML / extension asset (`source !== "db"`) | `not-editable-source` | `built-in`     |
 * | DB row, `system`, no owner           | `requires-admin`       | `unowned`      |
 * | DB row, `system`, owned              | owner or admin         | `instance-wide`|
 *
 * `project` and `private` keep their own names: those words already say
 * what they mean and nothing about them changed.
 *
 * ## What this never does
 *
 * **It never renders a user id.** "Someone here made this" is the useful
 * distinction; WHICH someone is not the badge's business, is not
 * something every viewer is entitled to, and would turn a provenance
 * pill into a directory. The `userId` argument is read for `!== null`
 * and is never returned in any field.
 */

/** Everything the badge needs off a serialized workflow. All optional —
 *  the wire shape is additive and older payloads simply lack them. */
export interface WorkflowProvenanceInput {
  visibility?: string | null;
  /** `null` for an ownerless row: legacy, orphaned, or a file on disk. */
  userId?: string | null;
  /** `"db" | "yaml" | "extension"` — server-derived, never client-set. */
  source?: string | null;
}

export interface WorkflowProvenanceBadge {
  /** The pill text. Short, lowercase, and never a user id. */
  label: string;
  /** Hover + assistive text: who may run it, and who may change it. */
  title: string;
  /** Tailwind classes, so `built-in` is distinguishable at a glance and
   *  not only on hover. */
  className: string;
}

/** The default pill treatment — muted, no claim of its own. */
const NEUTRAL = "bg-[var(--color-surface-tertiary)] text-[var(--color-text-muted)]";

/**
 * The badge for one workflow.
 *
 * Total over the input: an unknown or absent `visibility` falls through
 * to the `system` family, matching the server's own default (`system` is
 * what `createWorkflow` applies when none is given), so a payload from an
 * older server never renders a blank pill.
 */
export function workflowProvenanceBadge(
  workflow: WorkflowProvenanceInput,
): WorkflowProvenanceBadge {
  if (workflow.visibility === "private") {
    return {
      label: "private",
      title: "Only you and an admin can see, run or change this workflow.",
      className: NEUTRAL,
    };
  }
  if (workflow.visibility === "project") {
    return {
      label: "project",
      title:
        "Anyone signed in to this instance can run it. Only its creator or an admin can change it.",
      className: NEUTRAL,
    };
  }

  // The `system` family. A file on disk first: it ships with the
  // install and there is nothing to write, whoever is asking.
  if (workflow.source === "yaml" || workflow.source === "extension") {
    return {
      label: "built-in",
      title:
        "Ships with EZCorp or with an installed extension. It is a file on disk, so it cannot be edited here — duplicate it to get a copy of your own.",
      className: "bg-teal-500/15 text-teal-300",
    };
  }
  if (workflow.userId == null) {
    return {
      label: "unowned",
      title:
        "Runnable by anyone on this instance, with no owner on record. Only an admin can change it.",
      className: "bg-amber-500/15 text-amber-300",
    };
  }
  return {
    label: "instance-wide",
    title:
      "Made here, and runnable by anyone on this instance. Only its owner or an admin can change it.",
    className: NEUTRAL,
  };
}
