import { createHash } from "node:crypto";
import { canonicalJson, workspaceText } from "@ezcorp/extension-contract";
import { browserBuild, filesDigest, type BrowserBuild } from "@ezcorp/extension-runner";
import { getUserById } from "$server/db/queries/users";
import { getExtensionByName } from "$server/db/queries/extensions";
import { getConversation } from "$server/db/queries/conversations";
import { getProjectMembership } from "$server/db/queries/project-members";
import { canWireExtension } from "$server/auth/extension-wire-authz";
import { getReleaseRuntime, releaseBinding, resolveActiveRelease } from "$server/extensions/release-process";

const bundles = new Map<string, { html: string; spec: BrowserBuild }>();

export async function authorizeExtensionBrowser(name: string, userId: string, conversationId?: string, expectedBinding?: string) {
  const user = await getUserById(userId);
  const extension = await getExtensionByName(name);
  if (user?.status !== "active" || !extension?.enabled) throw new Error("Extension preview is unavailable");
  const active = await resolveActiveRelease(extension.id, getReleaseRuntime());
  const conversation = conversationId ? await getConversation(conversationId) : null;
  if (conversationId && (!conversation || conversation.userId !== user.id)) throw new Error("Select an owned conversation");
  const scope = active.installation.scope;
  if (scope !== "global" && (!scope.startsWith("project:") || !scope.slice(8))) throw new Error("Extension preview scope is unavailable");
  const projectId = scope.startsWith("project:") ? scope.slice(8) : conversation?.projectId;
  if (scope.startsWith("project:") && conversation && conversation.projectId !== projectId) throw new Error("Select a conversation in the extension project");
  if (projectId && user.role !== "admin" && !await getProjectMembership(user.id, projectId)) throw new Error("Project membership is required");
  if (!await canWireExtension(extension, { user: { id: user.id, role: user.role }, projectId: projectId ?? null })) throw new Error("Extension preview is unavailable");
  const releaseKey = releaseBinding(active);
  const binding = createHash("sha256").update(releaseKey).digest("hex");
  if (expectedBinding !== undefined && binding !== expectedBinding) throw new Error("Extension preview changed; reload before continuing");
  return { user, extension, active, conversation, binding, releaseKey };
}

export async function extensionBrowserBundle(artifactDigest: string): Promise<{ html: string; spec: BrowserBuild }> {
  const cached = bundles.get(artifactDigest);
  if (cached) { bundles.delete(artifactDigest); bundles.set(artifactDigest, cached); return cached; }
  const files = await (await getReleaseRuntime().runner()).collectArtifacts(artifactDigest);
  if (filesDigest(files) !== artifactDigest) throw new Error("Extension browser artifact digest mismatch");
  const spec = browserBuild(files);
  if (!spec || files[".runner/browser.json"] !== canonicalJson(spec)) throw new Error("Extension has no verified browser bundle");
  const html = workspaceText(files[".runner/browser.html"], ".runner/browser.html");
  if (Buffer.byteLength(html) > 12 * 1024 ** 2) throw new Error("Extension browser bundle exceeds its limit");
  const bundle = { html, spec };
  if (bundles.size >= 8) bundles.delete(bundles.keys().next().value!);
  bundles.set(artifactDigest, bundle);
  return bundle;
}
