import { basename, dirname } from "node:path";
import { FactoryEncryptionError, type FactoryDataKeyWrapBinding, type FactoryDataKeyWrapper } from "./encryption";
import { privateDirectory, readPrivateBounded } from "./private-files.ts";

/**
 * C06's two KMS wrapping adapters (W15). Each wraps the installation data key
 * under a key that never leaves its service; the data key itself never changes,
 * so rotation adds a wrap and leaves every encrypted object untouched.
 *
 * - `FactoryCloudKmsWrapper` is the hosted profile: a cloud KMS whose client
 *   exposes `encrypt` and `decrypt` with the AWS KMS request and response
 *   shapes. The AWS SDK v3 `KMS` aggregated client satisfies it structurally;
 *   the deployment supplies the client and its workload identity, so this
 *   module holds no cloud credential.
 * - `FactoryTransitKmsWrapper` is the self-hosted external KMS: the HashiCorp
 *   Vault (or OpenBao) transit engine over its HTTP API, authenticated with a
 *   token read from a private file outside every grantable root.
 *
 * Both bind the wrap to the installation and wrap version: the cloud adapter
 * through the KMS encryption context, the transit adapter by sealing the
 * binding inside the plaintext it asks the service to encrypt, and checking it
 * on the way back.
 */

const DATA_KEY_BYTES = 32;
const TRANSIT_PREFIX = "transit:";

export interface FactoryCloudKmsClient {
  encrypt(input: { readonly KeyId: string; readonly Plaintext: Uint8Array; readonly EncryptionContext: Record<string, string> }): Promise<{ readonly CiphertextBlob?: Uint8Array; readonly KeyId?: string }>;
  decrypt(input: { readonly CiphertextBlob: Uint8Array; readonly KeyId: string; readonly EncryptionContext: Record<string, string> }): Promise<{ readonly Plaintext?: Uint8Array; readonly KeyId?: string }>;
}

function context(binding: FactoryDataKeyWrapBinding): Record<string, string> {
  return { "ezcorp:installation": binding.installationId, "ezcorp:wrap-version": String(binding.wrapVersion), "ezcorp:purpose": "factory-data-key" };
}

function dataKey(value: Uint8Array | undefined): Uint8Array {
  if (!value || value.byteLength !== DATA_KEY_BYTES) throw new FactoryEncryptionError("factory_key_invalid");
  return value;
}

/** Hosted: a cloud KMS key. Wrap ids are the KMS key ids; a wrap under another key id is not this wrapper's. */
export class FactoryCloudKmsWrapper implements FactoryDataKeyWrapper {
  constructor(private readonly options: { readonly keyId: string; readonly retainedKeyIds?: readonly string[]; readonly client: FactoryCloudKmsClient }) {
    if (!options.keyId) throw new FactoryEncryptionError("factory_key_invalid");
  }

  async currentKeyId(): Promise<string> { return this.options.keyId; }

  async wrap(value: Uint8Array, keyId: string, binding: FactoryDataKeyWrapBinding): Promise<Uint8Array> {
    if (keyId !== this.options.keyId) throw new FactoryEncryptionError("factory_key_conflict");
    const result = await this.options.client.encrypt({ KeyId: keyId, Plaintext: dataKey(value), EncryptionContext: context(binding) });
    if (!result.CiphertextBlob || result.CiphertextBlob.byteLength === 0) throw new FactoryEncryptionError("factory_key_invalid");
    return result.CiphertextBlob;
  }

  async unwrap(wrapped: Uint8Array, keyId: string, binding: FactoryDataKeyWrapBinding): Promise<Uint8Array | undefined> {
    if (keyId !== this.options.keyId && !(this.options.retainedKeyIds ?? []).includes(keyId)) return undefined;
    const result = await this.options.client.decrypt({ CiphertextBlob: wrapped, KeyId: keyId, EncryptionContext: context(binding) });
    return dataKey(result.Plaintext);
  }
}

export interface FactoryTransitKmsOptions {
  /** The Vault or OpenBao base URL, for example `https://vault.internal:8200`. */
  readonly endpoint: string;
  /** The transit mount, `transit` by default. */
  readonly mount?: string;
  readonly keyName: string;
  /** A private file holding the transit token. It is read for every call, so a rotated token takes effect at once. */
  readonly tokenPath: string;
  readonly tls?: { readonly cert?: string; readonly key?: string; readonly ca?: string };
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Self-hosted external KMS: the transit engine. The service keeps every key
 * version it has issued, so a wrap made before a transit key rotation still
 * opens, and a wrap id records the transit key's name so a retained wrap under
 * another key is recognized as not this wrapper's.
 */
export class FactoryTransitKmsWrapper implements FactoryDataKeyWrapper {
  private readonly keyId: string;
  private readonly mount: string;
  constructor(private readonly options: FactoryTransitKmsOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.keyName) || !/^[A-Za-z0-9][A-Za-z0-9_/-]{0,127}$/.test(options.mount ?? "transit")) throw new FactoryEncryptionError("factory_key_invalid");
    this.mount = options.mount ?? "transit";
    this.keyId = `${TRANSIT_PREFIX}${this.mount}/${options.keyName}`;
  }

  async currentKeyId(): Promise<string> { return this.keyId; }

  async wrap(value: Uint8Array, keyId: string, binding: FactoryDataKeyWrapBinding): Promise<Uint8Array> {
    if (keyId !== this.keyId) throw new FactoryEncryptionError("factory_key_conflict");
    const sealed = JSON.stringify({ ...binding, key: Buffer.from(dataKey(value)).toString("base64") });
    const reply = await this.call("encrypt", { plaintext: Buffer.from(sealed).toString("base64") });
    const ciphertext = reply.ciphertext;
    if (typeof ciphertext !== "string" || !/^vault:v\d+:/.test(ciphertext)) throw new FactoryEncryptionError("factory_key_invalid");
    return new TextEncoder().encode(ciphertext);
  }

  async unwrap(wrapped: Uint8Array, keyId: string, binding: FactoryDataKeyWrapBinding): Promise<Uint8Array | undefined> {
    if (keyId !== this.keyId) return undefined;
    const reply = await this.call("decrypt", { ciphertext: new TextDecoder("utf-8", { fatal: true }).decode(wrapped) });
    let sealed: { installationId?: unknown; wrapVersion?: unknown; key?: unknown };
    try { sealed = JSON.parse(Buffer.from(String(reply.plaintext), "base64").toString("utf8")); }
    catch { throw new FactoryEncryptionError("factory_decryption_failed"); }
    if (sealed.installationId !== binding.installationId || sealed.wrapVersion !== binding.wrapVersion || typeof sealed.key !== "string") throw new FactoryEncryptionError("factory_decryption_failed");
    return dataKey(Buffer.from(sealed.key, "base64"));
  }

  private async token(): Promise<string> {
    const directory = await privateDirectory(dirname(this.options.tokenPath));
    try { return new TextDecoder("utf-8", { fatal: true }).decode(await readPrivateBounded(directory, basename(this.options.tokenPath), 4_096)).trim(); }
    finally { await directory.close(); }
  }

  private async call(operation: "encrypt" | "decrypt", body: Record<string, string>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(new URL(`/v1/${this.mount}/${operation}/${this.options.keyName}`, this.options.endpoint), {
        method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
        headers: { "content-type": "application/json", "x-vault-token": await this.token() },
        ...(this.options.tls ? { tls: this.options.tls } : {}),
      } as RequestInit);
    } catch { throw new FactoryEncryptionError("factory_key_missing"); }
    const parsed = await response.json().catch(() => null) as { data?: Record<string, unknown> } | null;
    if (!response.ok || !parsed?.data) throw new FactoryEncryptionError(response.status === 400 ? "factory_decryption_failed" : "factory_key_missing");
    return parsed.data;
  }
}
