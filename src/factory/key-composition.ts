import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { FactoryEncryptionError, factoryMasterKeyWrapper, InstallationDataKey, readOperatorMasterKey, StaticMasterKeyProvider, type FactoryDataKeyWrapper } from "./encryption";
import { readFactoryKeyWrapFile } from "./file-key-wraps";
import { FactoryCloudKmsWrapper, FactoryTransitKmsWrapper, type FactoryCloudKmsClient } from "./key-management";
import { readPrivateFileBounded } from "./private-files";
import type { FactoryStartupConfig } from "./startup-config";

/**
 * The data-key wrapping service the startup document selects (C06, W15).
 *
 * `keyManagement` names one of three services; absent, the operator master key
 * in `keys` is the service. Every secret is read by reference through the
 * private bounded reader: the operator key file, the cloud KMS credential
 * file, or the transit token file. No secret value is logged or returned.
 */

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
  try { return new TextDecoder("utf-8", { fatal: true }).decode(await readPrivateFileBounded(path, MAX_SECRET_FILE_BYTES)); }
  catch { throw new FactoryEncryptionError("factory_key_unsafe"); }
}

async function readKmsCredentials(path: string): Promise<FactoryCloudKmsClientOptions["credentials"]> {
  let parsed: { accessKeyId?: unknown; secretAccessKey?: unknown };
  try { parsed = JSON.parse(await readSecretText(path)) as typeof parsed; }
  catch { throw new FactoryEncryptionError("factory_key_invalid"); }
  const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
  if (!text(parsed?.accessKeyId) || !text(parsed.secretAccessKey)) throw new FactoryEncryptionError("factory_key_invalid");
  return { accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey };
}

/** The wrapper for the service the startup document selects. */
export async function composeFactoryDataKeyWrapper(config: Pick<FactoryStartupConfig, "keys" | "keyManagement">, dependencies: FactoryKeyCompositionDependencies = {}): Promise<FactoryDataKeyWrapper> {
  const selected = config.keyManagement ?? { kind: "operator-master-key" as const };
  switch (selected.kind) {
    case "operator-master-key":
      return factoryMasterKeyWrapper(new StaticMasterKeyProvider(await readOperatorMasterKey(config.keys.masterKeyFilePath, config.keys.masterKeyId, config.keys.grantableRoots)));
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

/**
 * Opens the installation data key from its private wrap file with the selected
 * service. The restore's key check calls this: a restored deployment must open
 * the same data key the checkpoint recorded before it serves anything.
 */
export async function loadFactoryInstallationDataKey(config: Pick<FactoryStartupConfig, "installationId" | "keys">, wrapper: FactoryDataKeyWrapper): Promise<InstallationDataKey> {
  const wraps = await readFactoryKeyWrapFile(config.keys.wrappedKeyFilePath, config.installationId, await wrapper.currentKeyId());
  return InstallationDataKey.loadExisting(config.installationId, wraps, wrapper);
}
