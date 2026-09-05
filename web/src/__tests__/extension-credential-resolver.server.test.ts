import { beforeEach, expect, test, vi } from "vitest";

const ports = vi.hoisted(() => ({
  user: vi.fn(), conversation: vi.fn(), role: vi.fn(), secret: vi.fn(), apiKey: vi.fn(), accessToken: vi.fn(), configure: vi.fn(),
}));
vi.mock("$server/db/queries/users", () => ({ getUserById: ports.user }));
vi.mock("$server/db/queries/conversations", () => ({ getConversation: ports.conversation }));
vi.mock("$server/auth/middleware", () => ({ checkProjectRole: ports.role }));
vi.mock("$server/extensions/secrets-store", () => ({ getSecret: ports.secret }));
vi.mock("$server/extensions/credential-broker", () => ({ configureCredentialResolver: ports.configure }));
vi.mock("../lib/server/security/openai-extension-creds", () => ({ resolveOpenAIApiKey: ports.apiKey, resolveOpenAIAccessToken: ports.accessToken }));
import { initializeExtensionCredentials, readExtensionCredential, resolveExtensionCredential } from "../lib/server/extensions/credential-resolver";

const scope = { extensionId: "extension", userId: "caller", conversationId: "conversation" };
beforeEach(() => {
  vi.resetAllMocks();
  ports.user.mockResolvedValue({ id: "caller", status: "active" });
  ports.conversation.mockResolvedValue({ userId: "caller", projectId: "project" });
  ports.role.mockResolvedValue({});
  ports.secret.mockResolvedValue("project-secret");
  ports.apiKey.mockResolvedValue("provider-key");
  ports.accessToken.mockResolvedValue("provider-oauth");
});

test("registers the host-only resolver and reads only supported provider credentials", async () => {
  initializeExtensionCredentials();
  expect(ports.configure).toHaveBeenCalledWith(resolveExtensionCredential, readExtensionCredential);
  expect(await resolveExtensionCredential("OPENAI_API_KEY", scope)).toBe("provider-key");
  expect(await resolveExtensionCredential("OPENAI_ACCESS_TOKEN", scope)).toBe("provider-oauth");
  expect(await resolveExtensionCredential("DATABASE_URL", scope)).toBeNull();
  ports.user.mockResolvedValue({ id: "caller", status: "inactive" });
  expect(await resolveExtensionCredential("OPENAI_API_KEY", scope)).toBeNull();
  expect(ports.apiKey).toHaveBeenCalledTimes(1);
});

test("opaque provider use never grants raw extraction to ordinary users or project members", async () => {
  for (const name of ["OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN", "GITHUB_TOKEN"]) {
    expect(await resolveExtensionCredential(name, scope)).toBeTruthy();
    expect(await readExtensionCredential(name, scope)).toBeNull();
  }
  ports.user.mockResolvedValue({ id: "caller", status: "inactive", role: "admin" });
  expect(await readExtensionCredential("OPENAI_API_KEY", scope)).toBeNull();
  ports.user.mockResolvedValue({ id: "caller", status: "active", role: "admin" });
  expect(await readExtensionCredential("OPENAI_API_KEY", scope)).toBe("provider-key");
  expect(await readExtensionCredential("GITHUB_TOKEN", scope)).toBe("project-secret");
  ports.conversation.mockResolvedValue({ userId: "other", projectId: "project" });
  expect(await readExtensionCredential("GITHUB_TOKEN", scope)).toBeNull();
  expect(await readExtensionCredential("DATABASE_URL", scope)).toBeNull();
});

test("GitHub credentials require current conversation ownership and project membership", async () => {
  expect(await resolveExtensionCredential("GITHUB_TOKEN", scope)).toBe("project-secret");
  expect(ports.secret).toHaveBeenCalledWith("github-projects", "project", "apiToken");
  expect(await resolveExtensionCredential("GITHUB_TOKEN", { ...scope, conversationId: null })).toBeNull();
  ports.conversation.mockResolvedValue({ userId: "other", projectId: "project" });
  expect(await resolveExtensionCredential("GITHUB_TOKEN", scope)).toBeNull();
  ports.conversation.mockResolvedValue({ userId: "caller", projectId: null });
  expect(await resolveExtensionCredential("GITHUB_TOKEN", scope)).toBeNull();
  ports.conversation.mockResolvedValue({ userId: "caller", projectId: "project" });
  ports.role.mockResolvedValue(new Response(null, { status: 403 }));
  expect(await resolveExtensionCredential("GITHUB_TOKEN", scope)).toBeNull();
  expect(ports.secret).toHaveBeenCalledTimes(1);
});
