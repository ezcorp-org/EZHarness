import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { FactoryEncryptionError, factoryMasterKeyWrapper, readOperatorMasterKey, StaticMasterKeyProvider, type FactoryDataKeyWrapper } from "./encryption.ts";
import { FactoryCloudKmsWrapper, FactoryTransitKmsWrapper, type FactoryCloudKmsClient } from "./key-management.ts";
import { isPlainRecord } from "./plain-values.ts";
import { readPrivatePath } from "./private-files.ts";
import { exactKeys, httpsUrl, wellFormed } from "./startup-values.ts";

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
