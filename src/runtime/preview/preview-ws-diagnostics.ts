import { logger } from "../../logger";

export type PreviewWsDenialStage = "gate" | "target" | "connect" | "protocol" | "recheck" | "upgrade"
  | "transport.authorize" | "transport.authority" | "transport.revalidate" | "transport.session"
  | "transport.instance" | "transport.exec" | "transport.channels" | "transport.handshake";

const log = logger.child("preview.ws");
let windowStarted = 0;
let warnings = 0;

/** Fixed stage only. This logs no request, identity, token, challenge, or exception. */
export function notePreviewWsDenial(stage: PreviewWsDenialStage): void {
  const now = Date.now();
  if (now - windowStarted >= 60_000) { windowStarted = now; warnings = 0; }
  if (warnings++ < 16) log.warn("Preview WebSocket denied", { stage });
}
