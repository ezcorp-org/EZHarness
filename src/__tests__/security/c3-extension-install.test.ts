import { afterAll, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import { ADMIN_USER, MEMBER_USER, createMockEvent, mockServerAlias } from "../helpers/mock-request";
import { redactExtensionSecrets } from "../../extensions/mcp-secret-redaction";

mockServerAlias();
const effects = mock(() => { throw new Error("Legacy request reached an execution or grant writer"); });
const installer = () => ({ installFromLocal: effects, installFromGitHub: effects, activateExtension: effects });
mock.module("../../extensions/installer", installer);
mock.module("$server/extensions/installer", installer);
const queries = () => ({ updateExtension: effects, createExtension: effects, getExtension: effects, listExtensions: effects, getExtensionByName: effects, redactExtensionSecrets });
mock.module("../../db/queries/extensions", queries);
mock.module("$server/db/queries/extensions", queries);
const audit = () => ({ insertAuditEntry: effects });
mock.module("../../db/queries/audit-log", audit);
mock.module("$server/db/queries/audit-log", audit);
const scopes = () => ({ requireScope: () => null });
mock.module("$lib/server/security/api-keys", scopes);
mock.module("../../../web/src/lib/server/security/api-keys", scopes);
const { POST } = await import("../../../web/src/routes/api/extensions/+server");
afterAll(() => restoreModuleMocks());

test("neither role can install, execute or grant authority through the retired endpoint", async () => {
  for (const user of [ADMIN_USER, MEMBER_USER]) {
    for (const id of ["installation"]) {
      for (const body of [{ source: "local", path: "/tmp/attacker-extension", permissions: { shell: true, filesystem: ["/"], network: true }, enabled: true }, { source: "github", repo: "attacker/extension", permissions: { shell: true }, enabled: true }, { source: "local", path: "/tmp/extension" }]) {
        const event = createMockEvent({ method: "POST", url: "http://localhost/api/extensions/" + id, params: { id }, user, body });
        const response = await POST(event as never);
        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({ code: "extension_v4_required", controlUrl: "/api/extensions/control", openUrl: "/extensions/author" });
      }
    }
  }
  expect(effects).not.toHaveBeenCalled();
});

test("unauthenticated requests remain denied before the retirement response", async () => {
  const event = createMockEvent({ method: "POST", url: "http://localhost/api/extensions/installation", params: { id: "installation" }, body: {} });
  let response: Response;
  try { response = await POST(event as never); }
  catch (error) { if (!(error instanceof Response)) throw error; response = error; }
  expect(response.status).toBe(401);
  expect(effects).not.toHaveBeenCalled();
});
