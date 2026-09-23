import { createHmac, timingSafeEqual } from "node:crypto";
import type { FactoryEventCursor } from "@ezcorp/factory-sdk";
import type { FactoryRunKey } from "./records";

/** Errors the console read models raise. The web boundary maps each code to one status. */
export type FactoryConsoleErrorCode =
  | "factory_cursor_invalid"
  | "factory_cursor_expired"
  | "factory_page_invalid"
  | "factory_package_not_found"
  | "factory_package_admin_required"
  | "factory_purge_confirmation"
  | "factory_artifact_not_found"
  | "factory_ticket_invalid"
  | "factory_ticket_expired"
  | "factory_material_query_invalid"
  | "factory_material_not_found";

export class FactoryConsoleError extends Error {
  constructor(readonly code: FactoryConsoleErrorCode) { super(code); this.name = "FactoryConsoleError"; }
}

/** One cursor lives this long. A client that holds an older one takes a new snapshot. */
export const FACTORY_CURSOR_TTL_MS = 15 * 60_000;
const MINIMUM_KEY_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,1400}\.[A-Za-z0-9_-]{43}$/;

/**
 * Signs short JSON claims for one named purpose. The purpose is bound into the
 * MAC, so a token minted for one use (an event cursor) never verifies as
 * another (an artifact ticket).
 */
export class FactoryConsoleSigner {
  constructor(private readonly key: Uint8Array) {
    if (key.byteLength < MINIMUM_KEY_BYTES) throw new FactoryConsoleError("factory_cursor_invalid");
  }

  sign(purpose: string, claims: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${body}.${this.mac(purpose, body)}`;
  }

  /** Returns the claims of a well-formed token this key signed for `purpose`, or null. */
  open(purpose: string, token: string): Record<string, unknown> | null {
    if (!TOKEN_PATTERN.test(token)) return null;
    const [body, mac] = token.split(".") as [string, string];
    if (!timingSafeEqual(Buffer.from(this.mac(purpose, body)), Buffer.from(mac))) return null;
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  }

  private mac(purpose: string, body: string): string { return createHmac("sha256", this.key).update(`${purpose}\0${body}`).digest("base64url"); }
}

interface SignedPosition { readonly v: 1; readonly t: string; readonly p: string; readonly r: string; readonly s: number; readonly e: number }
const CURSOR_PURPOSE = "factory-event-cursor.v1";

/**
 * Signs and verifies one run's stream position. A token names its tenant,
 * project, and run, so it cannot resume a different stream, and it expires, so
 * a client cannot hold a position past the window the server promises.
 */
export class FactoryEventCursors {
  constructor(private readonly signer: FactoryConsoleSigner, private readonly now: () => number = Date.now, private readonly ttlMs = FACTORY_CURSOR_TTL_MS) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new FactoryConsoleError("factory_cursor_invalid");
  }

  issue(tenantId: string, key: FactoryRunKey, sequence: number): FactoryEventCursor {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new FactoryConsoleError("factory_cursor_invalid");
    const expiresAtMs = this.now() + this.ttlMs;
    const token = this.signer.sign(CURSOR_PURPOSE, { v: 1, t: tenantId, p: key.projectId, r: key.runId, s: sequence, e: expiresAtMs } satisfies SignedPosition);
    return { token, sequence, expiresAtMs };
  }

  /** Returns the signed sequence, or refuses a foreign, forged, or expired token. */
  verify(tenantId: string, key: FactoryRunKey, token: string): number {
    const position = this.signer.open(CURSOR_PURPOSE, token) as SignedPosition | null;
    if (position?.v !== 1 || position.t !== tenantId || position.p !== key.projectId || position.r !== key.runId) throw new FactoryConsoleError("factory_cursor_invalid");
    if (!Number.isSafeInteger(position.s) || position.s < 0 || !Number.isSafeInteger(position.e)) throw new FactoryConsoleError("factory_cursor_invalid");
    if (position.e <= this.now()) throw new FactoryConsoleError("factory_cursor_expired");
    return position.s;
  }
}
