import { sql } from "drizzle-orm";
import { getDb } from "../db/connection";
import { releaseRows } from "../db/queries/extension-releases";
import { getExtensionProjectBinding } from "./project-binding";
import type { AuthorizeContext } from "./permission-engine";
import type { CapabilitySet } from "./capability-types";

export interface ProjectOperationConsent { bindingId: string; projectId: string; proposalId?: string }

export async function hasProjectOperationConsent(context: AuthorizeContext, needed: CapabilitySet): Promise<boolean> {
  const consent = context.projectConsent;
  if (!consent || !context.userId) return false;
  const gitRead = ["project.gitHead", "project.commitSubjects", "project.origin"].includes(context.toolName ?? "");
  const pullRequest = context.toolName === "project.pullRequest" || context.toolName === "project.pullRequest.write";
  if ((!gitRead && !pullRequest) || needed.some(capability => capability.kind !== "shell" && !(pullRequest && capability.kind === "network" && capability.value === "api.github.com"))) return false;
  try {
    const binding = await getExtensionProjectBinding(context.extensionId);
    if (!binding || binding.id !== consent.bindingId || binding.projectId !== consent.projectId || binding.ownerId !== context.userId) return false;
    const { getUserById } = await import("../db/queries/users");
    const { checkProjectRole } = await import("../auth/middleware");
    const user = await getUserById(context.userId);
    if (user?.status !== "active" || await checkProjectRole({ user }, binding.projectId, "member") instanceof Response) return false;
    if (context.conversationId) {
      const { getConversation } = await import("../db/queries/conversations");
      const conversation = await getConversation(context.conversationId);
      if (!conversation || conversation.userId !== context.userId || conversation.projectId !== binding.projectId) return false;
    }
    if (context.toolName === "project.pullRequest.write") {
      if (!consent.proposalId) return false;
      const row = releaseRows<{ payload: string }>(await getDb().execute(sql`SELECT payload FROM extension_project_decisions WHERE id = ${consent.proposalId} AND installation_id = ${context.extensionId} AND state = 'executing'`))[0];
      if (!row) return false;
      const proposal = JSON.parse(row.payload);
      if (proposal.ownerId !== context.userId || proposal.decidedBy !== context.userId || proposal.bindingId !== binding.id || proposal.projectId !== binding.projectId || !["finalize", "close"].includes(proposal.decision) || typeof proposal.createdAt !== "number" || Date.now() - proposal.createdAt > 86400000) return false;
    }
    return true;
  } catch { return false; }
}
