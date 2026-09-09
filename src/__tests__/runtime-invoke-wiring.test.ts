import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

let wiredIds: string[] = [];
const lookups: string[] = [];
let messageReads = 0;
mock.module("../db/queries/conversation-extensions", () => ({ getConversationExtensionIds: async (conversationId: string) => { lookups.push(conversationId); return wiredIds; } }));
mock.module("../db/queries/conversations", () => ({
  getConversation: async (id: string) => ({ id, projectId: "project" }),
  getMessages: async () => { messageReads++; return []; },
}));
const { handlePiInvoke } = await import("../extensions/tool-executor/invoke");
const { registerFireCallProvenance, releaseCallProvenance } = await import("../extensions/call-provenance");
afterAll(restoreModuleMocks);
beforeEach(() => { wiredIds = []; lookups.length = 0; messageReads = 0; });

test.each([true, false])("event runtime invoke consults host wiring before reading messages (wired=%s)", async wired => {
  wiredIds = wired ? ["calling-extension"] : ["other-extension"];
  const token = registerFireCallProvenance({ actorExtensionId: "calling-extension", onBehalfOf: "owner", conversationId: "conversation", runId: null, parentCallId: null, kind: "event", ownerless: false });
  try {
    const host = {
      registry: { getGrantedPermissions: () => ({ grantedAt: {} }), getManifest: () => ({ name: "example" }) },
      eventDriven: true, currentConversationId: undefined, currentUserId: undefined,
      executeToolCall: async () => { throw new Error("Unexpected cross-extension dispatch"); },
    } as unknown as Parameters<typeof handlePiInvoke>[0];
    const response = await handlePiInvoke(host, "calling-extension", { jsonrpc: "2.0", id: "invoke", method: "ezcorp/invoke", params: { tool: "runtime.conversations.getMessages", arguments: { conversationId: "conversation" }, _meta: { ezCallId: token } } });
    expect(lookups).toEqual(["conversation"]);
    expect(messageReads).toBe(wired ? 1 : 0);
    if (wired) expect(response.result).toEqual({ projectId: "project", messages: [] });
    else expect(response.error).toMatchObject({ code: -32604 });
  } finally {
    releaseCallProvenance(token);
  }
});
