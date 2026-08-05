/**
 * The Hub's approvals tab — the second answer surface.
 *
 * ## It answers through the chokepoint, and only through it
 *
 * Ported invariant 7: every surface (REST, this Hub action, the chat card)
 * calls `answerApproval`, and everything that decision involves —
 * authorization, the consent guard, the CAS, the resume — is non-exported
 * below it. This provider therefore contains NO consent logic of its own,
 * and its test proves that by CALL COUNT on a spy rather than by reading
 * the code: a surface that re-implemented the rules, however correctly,
 * would leave the guard's call count untouched.
 *
 * The reference extension this replaces had exactly two answer paths and
 * the second could sidestep the rules entirely — a bypass nobody noticed
 * because each path looked correct in isolation.
 *
 * ## Why this surface cannot answer an item-consent approval
 *
 * A page action's payload admits only flat string/number/boolean values —
 * the validator rejects nested arrays wholesale — so a ticked item list
 * cannot ride in one. Rather than offer a button that sends NO items (the
 * guard refuses it, so the user gets an error they cannot act on) or ALL
 * of them (consent laundering, the precise thing `requireItemConsent`
 * exists to prevent), those rows render a pointer to the inbox, which can
 * express the decision.
 *
 * It also cannot pass `consentAll`. Standing consent is asserted where the
 * standing grant lives, not by a tab button on a user's behalf.
 */
import {
  registerHubPageProvider,
  HubPageActionError,
  type HubPageProvider,
} from "./hub-pages";
import type { HubPageTree, PageNode } from "../extensions/page-schema";
import { listPendingWorkflowApprovalsForUser } from "../db/queries/workflow-approvals";
import { answerApproval } from "./workflow-answer-approval";
import { resolveApprovalActor } from "./workflow-approval-actor";
import { workflowRefusalStatus } from "./workflow-refusal-status";

export const WORKFLOW_APPROVALS_HUB_PAGE_ID = "workflow-approvals";
export const WORKFLOW_APPROVALS_ANSWER_ACTION = "answer";

/**
 * Renders only the caller's OWN pending approvals — never the admin-wide
 * set. `HubPageContext` carries a `userId` and nothing else, and a tab that
 * inferred admin reach from some other source would be deriving an
 * authorization decision in a render path. The admin view belongs on a
 * surface that is actually gated as one.
 */
async function renderApprovalsPage(userId: string): Promise<HubPageTree> {
  const pending = await listPendingWorkflowApprovalsForUser(userId);
  if (pending.length === 0) {
    return {
      title: "Approvals",
      nodes: [{ type: "status", label: "Nothing is waiting on you", state: "idle" }],
    };
  }

  const nodes: PageNode[] = [
    {
      type: "status",
      label: `${pending.length} decision${pending.length === 1 ? "" : "s"} waiting`,
      state: "warning",
    },
  ];
  for (const item of pending) {
    nodes.push({
      type: "markdown",
      // The workflow and step are what make a row recognisable; the prompt
      // is the question itself.
      content: `**${item.workflowName} → ${item.approval.stepName}** — ${item.approval.prompt}`,
    });

    if (item.approval.requireItemConsent) {
      // Deliberately NOT answerable from here. A page action's payload
      // admits only flat string/number/boolean values (nested arrays are
      // rejected wholesale by the validator), so this tab cannot carry the
      // ticked item ids — and an "approve" button that silently sent none,
      // or worse sent all of them, is exactly the consent-laundering
      // `requireItemConsent` exists to prevent. Point at the surface that
      // can express the decision instead of offering a lossy one.
      nodes.push({
        type: "markdown",
        content:
          "_Per-item consent required — answer this one in the approvals inbox " +
          "(`/workflows/approvals`), where each item can be ticked individually._",
      });
      continue;
    }

    for (const choice of item.approval.choices) {
      nodes.push({
        type: "button",
        label: choice,
        action: {
          event: WORKFLOW_APPROVALS_ANSWER_ACTION,
          payload: { approvalId: item.approval.id, choice },
        },
      });
    }
  }
  return { title: "Approvals", nodes };
}

export function createWorkflowApprovalsHubPageProvider(): HubPageProvider {
  return {
    id: WORKFLOW_APPROVALS_HUB_PAGE_ID,
    title: "Approvals",
    render: (ctx) => renderApprovalsPage(ctx.userId),
    // The consent boundary, on this surface. `answer` reaches
    // `answerApproval`, and a run parks on an approval precisely so that a
    // PERSON decides — so no API key may drive it, whatever its scope or
    // role. Closing only the REST answer route would have moved R-4 here:
    // the Hub actions route is `chat`-scoped and harness-controllable, so a
    // leaked key could have answered through this action instead.
    // RENDER is deliberately NOT restricted — reading your own inbox is not
    // deciding anything, matching `GET /api/workflows/approvals` being
    // `read`-scoped rather than session-only.
    sessionOnlyActions: [WORKFLOW_APPROVALS_ANSWER_ACTION],
    actions: {
      [WORKFLOW_APPROVALS_ANSWER_ACTION]: async (ctx, payload) => {
        const approvalId = typeof payload?.approvalId === "string" ? payload.approvalId : "";
        const choice = typeof payload?.choice === "string" ? payload.choice : "";
        if (!approvalId || !choice) {
          throw new HubPageActionError(400, "approvalId and choice are required");
        }
        // No `itemIds`, ever — not even if a crafted request supplies
        // them. This surface does not render item checkboxes, so any list
        // arriving here was not ticked by the human, and forwarding it
        // would be asserting consent nobody gave. An item-consent approval
        // targeted through this action therefore reaches the guard with no
        // selection and is refused, which is the fail-closed outcome.
        // `isAdmin: false`, STATED rather than omitted. `HubPageContext`
        // carries a userId and nothing else, so this surface genuinely
        // cannot know a role and answers strictly as the run's owner —
        // which is a decision, and now reads as one. Under the old
        // optional flag the same intent was expressed by leaving a field
        // out, where "deliberately not an admin" and "nobody filled this
        // in" were the same absent value.
        //
        // The kind is resolved through the same rule the REST route uses,
        // because `renderApprovalsPage` above now LISTS a delegated run's
        // parked decision (the inbox disjunct) and a tab that shows a row
        // its own button cannot answer is worse than one that hides it.
        // The resolver authorizes nothing: `answerApproval` re-proves
        // every fact it returns.
        const result = await answerApproval(
          approvalId,
          { choice },
          await resolveApprovalActor(approvalId, { userId: ctx.userId, isAdmin: false }),
        );
        if (!result.ok) {
          throw new HubPageActionError(workflowRefusalStatus(result.code), result.message);
        }
        // Re-render so the tab drops the answered row immediately.
        return renderApprovalsPage(ctx.userId);
      },
    },
  };
}

export function registerWorkflowApprovalsHubPage(): void {
  registerHubPageProvider(createWorkflowApprovalsHubPageProvider());
}
