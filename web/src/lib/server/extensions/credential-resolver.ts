import { configureCredentialResolver, type CredentialScope } from "$server/extensions/credential-broker";
import { getUserById } from "$server/db/queries/users";
import { getConversation } from "$server/db/queries/conversations";
import { checkProjectRole } from "$server/auth/middleware";
import { getSecret } from "$server/extensions/secrets-store";
import { resolveOpenAIAccessToken, resolveOpenAIApiKey } from "../security/openai-extension-creds";

export async function resolveExtensionCredential(name: string, scope: CredentialScope): Promise<string | null> {
  const user = await getUserById(scope.userId);
  if (user?.status !== "active") return null;
  if (name === "OPENAI_API_KEY") return resolveOpenAIApiKey();
  if (name === "OPENAI_ACCESS_TOKEN") return resolveOpenAIAccessToken();
  if (name !== "GITHUB_TOKEN" || !scope.conversationId) return null;
  const conversation = await getConversation(scope.conversationId);
  if (conversation?.userId !== user.id || !conversation.projectId) return null;
  if (await checkProjectRole({ user }, conversation.projectId, "member") instanceof Response) return null;
  return getSecret("github-projects", conversation.projectId, "apiToken");
}

export async function readExtensionCredential(name: string, scope: CredentialScope): Promise<string | null> {
  const user = await getUserById(scope.userId);
  if (user?.status !== "active" || user.role !== "admin") return null;
  const value = await resolveExtensionCredential(name, scope);
  const current = await getUserById(scope.userId);
  return current?.status === "active" && current.role === "admin" ? value : null;
}

export function initializeExtensionCredentials(): void { configureCredentialResolver(resolveExtensionCredential, readExtensionCredential); }
