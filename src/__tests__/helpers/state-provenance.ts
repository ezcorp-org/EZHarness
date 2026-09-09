import { registerCallProvenance, releaseCallProvenance } from "../../extensions/call-provenance";
import type { ExtensionStateMediator } from "../../extensions/state-mediator";

export function withStateProvenance(mediator: ExtensionStateMediator): ExtensionStateMediator {
  const handle = mediator.handleNotification.bind(mediator);
  mediator.handleNotification = (extensionId, notification) => {
    const token = registerCallProvenance({ onBehalfOf: "state-owner", conversationId: null, runId: null, parentCallId: null, actorExtensionId: extensionId, kind: "render", ownerless: false });
    try {
      const params = notification.params;
      handle(extensionId, { ...notification, ...(params && typeof params === "object" && !Array.isArray(params) ? { params: { ...params, _meta: { ezCallId: token } } } : {}) });
    } finally { releaseCallProvenance(token); }
  };
  return mediator;
}
