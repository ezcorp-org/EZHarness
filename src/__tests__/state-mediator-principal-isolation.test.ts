import { expect, test } from "bun:test";
import { EventBus } from "../runtime/events";
import { shouldDeliverEvent } from "../runtime/sse-conversation-filter";
import { ExtensionStateMediator } from "../extensions/state-mediator";
import { registerCallProvenance, releaseCallProvenance } from "../extensions/call-provenance";
import type { AgentEvents } from "../types";

test("panel output carries only host-resolved principal and never broadcasts to other users", async () => {
  const bus = new EventBus<AgentEvents>();
  const events: AgentEvents["ext:state"][] = [];
  bus.on("ext:state", event => events.push(event));
  const mediator = new ExtensionStateMediator(bus, () => ({ name: "private-panel", panel: {} }));
  const token = registerCallProvenance({ onBehalfOf: "alice", actorExtensionId: "extension", conversationId: null, runId: null, parentCallId: null, kind: "render", ownerless: false });
  try {
    mediator.handleNotification("extension", { jsonrpc: "2.0", method: "ezcorp/state", params: { userId: "bob", secret: "alice-private", _meta: { ezCallId: token } } });
    expect(events).toHaveLength(1);
    expect(events[0]!.userId).toBe("alice");
    expect(JSON.stringify(events)).not.toContain(token);
    expect(await shouldDeliverEvent("ext:state", events[0], { userId: "alice" }, async () => null)).toBe(true);
    expect(await shouldDeliverEvent("ext:state", events[0], { userId: "bob" }, async () => null)).toBe(false);
    mediator.handleNotification("other-extension", { jsonrpc: "2.0", method: "ezcorp/state", params: { _meta: { ezCallId: token }, state: { private: true } } });
    expect(events).toHaveLength(1);
  } finally { releaseCallProvenance(token); }
  for (const meta of [undefined, null, [], {}, { ezCallId: 3 }, { ezCallId: token }]) {
    mediator.handleNotification("extension", { jsonrpc: "2.0", method: "ezcorp/state", params: { _meta: meta, state: { private: true } } });
  }
  expect(events).toHaveLength(1);
  for (const payload of [null, {}, { userId: "" }, { userId: 1 }]) expect(await shouldDeliverEvent("ext:state", payload, { userId: "alice" }, async () => null)).toBe(false);
});
