export const GUEST_HELPER_VERSION = "0.1.0";
export const GUEST_HELPER_PATH = "/usr/local/libexec/ezharness-helper";
export const GUEST_HELPER_SHA256 = "804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75";
export const GUEST_HELPER_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const GUEST_HELPER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type GuestAction =
  | "hello" | "file.stat" | "file.list" | "file.readRange" | "file.writeAtomic" | "file.remove"
  | "process.start" | "process.inspect" | "process.readOutput" | "process.cancel";

export type GuestRequest = {
  version: typeof GUEST_HELPER_VERSION;
  action: GuestAction;
  sandboxId: string;
  user: string;
  [key: string]: unknown;
};

export type GuestErrorKind = "invalid" | "not_found" | "revision_conflict" | "unsupported"
  | "permission" | "resource_exhausted" | "internal";

export class GuestProtocolError extends Error {
  constructor(readonly kind: GuestErrorKind, message: string) {
    super(message);
    this.name = "GuestProtocolError";
  }
}

const errorKinds = new Set<GuestErrorKind>([
  "invalid", "not_found", "revision_conflict", "unsupported", "permission", "resource_exhausted", "internal",
]);

export function guestHelperSha256(): string {
  return GUEST_HELPER_SHA256;
}

export function encodeGuestRequest(request: { action: GuestAction; sandboxId: string; user: string; [key: string]: unknown }): Buffer {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(request.sandboxId) ||
      typeof request.user !== "string" || request.user.length === 0) {
    throw new GuestProtocolError("invalid", "Invalid guest identity");
  }
  const encoded = Buffer.from(JSON.stringify({ ...request, version: GUEST_HELPER_VERSION }) + "\n");
  if (encoded.length > GUEST_HELPER_MAX_REQUEST_BYTES) {
    throw new GuestProtocolError("resource_exhausted", "Guest request exceeds limit");
  }
  return encoded;
}

export function decodeGuestResponse(raw: Uint8Array): Record<string, unknown> {
  if (raw.byteLength > GUEST_HELPER_MAX_RESPONSE_BYTES) {
    throw new GuestProtocolError("resource_exhausted", "Guest response exceeds limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    throw new GuestProtocolError("internal", "Guest helper returned invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GuestProtocolError("internal", "Guest helper returned invalid response");
  }
  const reply = value as Record<string, unknown>;
  if (reply.version !== GUEST_HELPER_VERSION) {
    throw new GuestProtocolError("unsupported", "Guest helper version mismatch");
  }
  if (reply.ok === false) {
    const error = reply.error;
    if (!error || typeof error !== "object" || Array.isArray(error)) {
      throw new GuestProtocolError("internal", "Guest helper returned invalid error");
    }
    const detail = error as Record<string, unknown>;
    if (!errorKinds.has(detail.kind as GuestErrorKind) || typeof detail.message !== "string") {
      throw new GuestProtocolError("internal", "Guest helper returned invalid error");
    }
    throw new GuestProtocolError(detail.kind as GuestErrorKind, detail.message.slice(0, 256));
  }
  if (reply.ok !== true) {
    throw new GuestProtocolError("internal", "Guest helper returned invalid response");
  }
  return reply;
}
