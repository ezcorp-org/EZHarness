import { beforeEach, vi } from "vitest";
import { makeRequestEvent } from "./server-route-test-utils";

const approval = vi.hoisted(() => vi.fn());
vi.mock("$server/extensions/extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => ({ approve: approval }) }));
export { approval };
export function approvalEvent(body: unknown, authMethod = "session", installationId = "installation") {
  return makeRequestEvent("http://localhost/api/extensions/releases/installation/approve", {
    locals: { user: { id: "user", name: "User", email: "user@example.com", role: "admin", status: "active" }, authMethod, apiKeyScopes: ["admin", "extensions"] },
    params: { installationId }, request: { method: "POST", body: JSON.stringify(body) },
  });
}
export function setupApprovalRoute() {
  beforeEach(() => { approval.mockReset(); approval.mockResolvedValue({ status: "approved" }); });
}
