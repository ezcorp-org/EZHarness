/**
 * The host public keys a host's signature is verified against: the product's stop verifier and the host's own
 * tombstones use this one set (the retained trust policy: while a retired key stays configured, what it signed still
 * verifies). No database behind it, so the supervisor process can load it (C05).
 */
import { createPublicKey, type KeyLike } from "node:crypto";
import { basename, dirname, resolve as resolvePath } from "node:path";
import type { FactoryJournalHostKey } from "./journal-validation";
import { assertFactoryIdentity } from "./factory-identity";
import { privateDirectory, readPrivateBounded } from "./private-files";
import { FactoryTaskStopError } from "./task-stop-error";

export interface FactoryStopHostKey {
  readonly hostId: string;
  readonly hostKeyId: string;
  readonly publicKey: string | Buffer | KeyLike;
}

/** Loads the configured supervisor certificates once, rejecting duplicates and bad material. */
export function factoryStopHostKeyMap(hostKeys: readonly FactoryStopHostKey[]): ReadonlyMap<string, FactoryJournalHostKey> {
  const entries = hostKeys.map(key => {
    assertFactoryIdentity(key.hostId, key.hostKeyId);
    try { return [key.hostKeyId, Object.freeze({ hostId: key.hostId, publicKey: typeof key.publicKey === "string" || Buffer.isBuffer(key.publicKey) ? createPublicKey(key.publicKey) : key.publicKey })] as const; }
    catch { throw new FactoryTaskStopError("factory_task_stop_key_invalid"); }
  });
  if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new FactoryTaskStopError("factory_task_stop_key_invalid");
  return new Map(entries);
}

/** A host public key file. Not a secret, read through the same bounded reader. */
const MAX_HOST_PUBLIC_KEY_BYTES = 16 * 1024;

export class FactoryStopCompositionError extends Error {
  constructor(readonly code: "factory_stop_host_keys_missing" | "factory_stop_transport_missing", message: string) {
    super(message);
    this.name = "FactoryStopCompositionError";
  }
}

/**
 * The host public keys a physical-stop receipt is verified against.
 *
 * By reference in the document and by value only here, for the length of one
 * composition. `FactoryTaskStops` takes the PEM text and calls
 * `createPublicKey` itself, so this reads bytes and decides nothing: a key that
 * is not a key fails there, by name, rather than being silently skipped and
 * leaving a host whose receipts can never verify.
 */
export async function loadFactoryStopHostKeys(
  configured: readonly { readonly hostId: string; readonly hostKeyId: string; readonly publicKeyPath: string }[],
): Promise<readonly FactoryStopHostKey[]> {
  if (configured.length === 0) {
    throw new FactoryStopCompositionError("factory_stop_host_keys_missing",
      "Settling a stop needs at least one configured host public key.");
  }
  const keys = await Promise.all(configured.map(async (entry) => {
    const absolute = resolvePath(entry.publicKeyPath);
    const directory = await privateDirectory(dirname(absolute));
    let bytes: Uint8Array;
    try {
      bytes = await readPrivateBounded(directory, basename(absolute), MAX_HOST_PUBLIC_KEY_BYTES);
    } finally {
      await directory.close();
    }
    return Object.freeze({ hostId: entry.hostId, hostKeyId: entry.hostKeyId, publicKey: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
  }));
  return Object.freeze(keys);
}
