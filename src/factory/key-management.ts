import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { FactoryEncryptionError, factoryMasterKeyWrapper, readOperatorMasterKey, StaticMasterKeyProvider, type FactoryDataKeyWrapBinding, type FactoryDataKeyWrapper } from "./encryption.ts";
import { readPrivatePath } from "./private-files.ts";
import { isPlainRecord } from "./plain-values.ts";
import { exactKeys, httpsUrl, wellFormed } from "./startup-values.ts";

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
  private readonly options: { readonly keyId: string; readonly retainedKeyIds?: readonly string[]; readonly client: FactoryCloudKmsClient };
  constructor(options: { readonly keyId: string; readonly retainedKeyIds?: readonly string[]; readonly client: FactoryCloudKmsClient }) {
    this.options = options;
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
  private readonly options: FactoryTransitKmsOptions;
  constructor(options: FactoryTransitKmsOptions) {
    this.options = options;
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
    return new TextDecoder("utf-8", { fatal: true }).decode(await readPrivatePath(this.options.tokenPath, 4_096)).trim();
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

/**
 * The data-key wrapping service an installation selects: the operator's own
 * master key file, a hosted cloud KMS key, or a self-hosted transit engine.
 * One unit selects it for every process that opens the data key: the product
 * process (restore key check) and the Node orchestration process (payload
 * codec). Every secret is by REFERENCE, read through the private bounded
 * reader; no secret value is logged or returned.
 */
export type FactoryKeyManagement =
  | { readonly kind: "operator-master-key" }
  | {
      readonly kind: "cloud-kms";
      /** The KMS key id or ARN new wraps use. */
      readonly keyId: string;
      readonly region: string;
      /** A private JSON file with `accessKeyId` and `secretAccessKey`. */
      readonly credentialsPath: string;
      readonly endpoint?: string;
    }
  | {
      readonly kind: "transit";
      /** A Vault or OpenBao server. */
      readonly endpoint: string;
      readonly keyName: string;
      /** A private file holding the transit token, read for every call. */
      readonly tokenPath: string;
      readonly mount?: string;
      /** The server's CA certificate, when it is not publicly trusted. */
      readonly caPath?: string;
    };

/** The operator key file references, used when no service is selected or the operator key is. */
export interface FactoryOperatorKeyReference {
  readonly masterKeyFilePath: string;
  readonly masterKeyId: string;
  readonly grantableRoots: readonly string[];
}

/** One data-key wrapping service, by kind, with only that kind's fields. */
export function wellFormedFactoryKeyManagement(value: unknown): value is FactoryKeyManagement {
  if (!isPlainRecord(value)) return false;
  if (value.kind === "operator-master-key") return exactKeys(value, ["kind"]);
  if (value.kind === "cloud-kms") {
    const required = ["kind", "keyId", "region", "credentialsPath"];
    if (!exactKeys(value, required) && !exactKeys(value, [...required, "endpoint"])) return false;
    return wellFormed("statement", value.keyId) && wellFormed("identity", value.region) && wellFormed("path", value.credentialsPath)
      && (value.endpoint === undefined || httpsUrl(value.endpoint));
  }
  if (value.kind === "transit") {
    const optional = ["mount", "caPath"].filter((key) => Object.hasOwn(value, key));
    if (!exactKeys(value, ["kind", "endpoint", "keyName", "tokenPath", ...optional])) return false;
    return httpsUrl(value.endpoint) && wellFormed("identity", value.keyName) && wellFormed("path", value.tokenPath)
      && (value.mount === undefined || wellFormed("identity", value.mount)) && (value.caPath === undefined || wellFormed("path", value.caPath));
  }
  return false;
}

const MAX_SECRET_FILE_BYTES = 16 * 1024;

export interface FactoryCloudKmsClientOptions {
  readonly region: string;
  readonly endpoint?: string;
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string };
}

export interface FactoryKeyCompositionDependencies {
  /** Builds the cloud KMS client. The AWS SDK client is the production default. */
  readonly cloudKmsClient?: (options: FactoryCloudKmsClientOptions) => FactoryCloudKmsClient;
  /** The transit engine's HTTP client. `fetch` is the production default. */
  readonly fetch?: typeof fetch;
}

/** The AWS SDK KMS client, narrowed to the two calls the wrapper makes. */
export function factoryAwsKmsClient(options: FactoryCloudKmsClientOptions): FactoryCloudKmsClient {
  const client = new KMSClient({ region: options.region, ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }), credentials: { ...options.credentials }, maxAttempts: 2 });
  return {
    encrypt: input => client.send(new EncryptCommand({ ...input })),
    decrypt: input => client.send(new DecryptCommand({ ...input })),
  };
}

async function readSecretText(path: string): Promise<string> {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(await readPrivatePath(path, MAX_SECRET_FILE_BYTES)); }
  catch (cause) { throw new FactoryEncryptionError("factory_key_unsafe", { cause }); }
}

async function readKmsCredentials(path: string): Promise<FactoryCloudKmsClientOptions["credentials"]> {
  let parsed: { accessKeyId?: unknown; secretAccessKey?: unknown };
  try { parsed = JSON.parse(await readSecretText(path)) as typeof parsed; }
  catch (cause) { throw new FactoryEncryptionError("factory_key_invalid", { cause }); }
  const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
  if (!text(parsed?.accessKeyId) || !text(parsed.secretAccessKey)) throw new FactoryEncryptionError("factory_key_invalid");
  return { accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey };
}

/** The wrapper for the selected service; with none selected, the operator master key file. */
export async function composeFactoryDataKeyWrapper(operatorKey: FactoryOperatorKeyReference, selected: FactoryKeyManagement = { kind: "operator-master-key" }, dependencies: FactoryKeyCompositionDependencies = {}): Promise<FactoryDataKeyWrapper> {
  switch (selected.kind) {
    case "operator-master-key":
      return factoryMasterKeyWrapper(new StaticMasterKeyProvider(await readOperatorMasterKey(operatorKey.masterKeyFilePath, operatorKey.masterKeyId, operatorKey.grantableRoots)));
    case "cloud-kms": {
      const credentials = await readKmsCredentials(selected.credentialsPath);
      const client = (dependencies.cloudKmsClient ?? factoryAwsKmsClient)({ region: selected.region, ...(selected.endpoint === undefined ? {} : { endpoint: selected.endpoint }), credentials });
      return new FactoryCloudKmsWrapper({ keyId: selected.keyId, client });
    }
    case "transit":
      return new FactoryTransitKmsWrapper({
        endpoint: selected.endpoint, keyName: selected.keyName, tokenPath: selected.tokenPath,
        ...(selected.mount === undefined ? {} : { mount: selected.mount }),
        ...(selected.caPath === undefined ? {} : { tls: { ca: await readSecretText(selected.caPath) } }),
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      });
  }
}
