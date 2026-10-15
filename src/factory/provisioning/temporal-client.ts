/**
 * The real Temporal side of step 3: namespace administration with the
 * operator's control identity, and the access probe a namespace credential is
 * verified with. Both go through the fleet's Temporal gateway, so every call
 * here passes the same certificate-and-token check a tenant's orchestrator does.
 *
 * The Temporal client is the Node orchestrator package's own dependency; the
 * root workspace does not install it. It is resolved from that package rather
 * than duplicated, so the provisioner speaks the exact client version the
 * orchestrator runs.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { FACTORY_TEMPORAL_CONTROL_SUBJECT, factoryTemporalToken, type FactoryTemporalAccessProbe, type FactoryTemporalAuthorityPaths, type FactoryTemporalNamespaceAdmin } from "./temporal";
import { readFactoryPrivatePath } from "./secret-files";
import { factoryTemporalLocalArchiveUris, factoryTemporalNamespaceArguments, factoryTemporalRegisterRequest } from "./temporal-namespace";
import { FactoryProvisioningError } from "./steps";

interface TemporalConnection {
  readonly workflowService: {
    registerNamespace(request: Record<string, unknown>): Promise<unknown>;
    describeNamespace(request: { namespace: string }): Promise<{ namespaceInfo?: { description?: string | null } | null }>;
  };
  close(): Promise<void>;
}
interface TemporalClientModule { readonly Connection: { connect(options: Record<string, unknown>): Promise<TemporalConnection> } }

export interface FactoryTemporalEndpoint {
  readonly address: string;
  readonly serverName: string;
  readonly caCertificatePath: string;
}

export interface FactoryTemporalControlIdentity {
  readonly certificatePath: string;
  readonly privateKeyPath: string;
}

const GRPC = Object.freeze({ notFound: 5, alreadyExists: 6, permissionDenied: 7, unauthenticated: 16 });

let loaded: Promise<TemporalClientModule> | undefined;
/** Load `@temporalio/client` from the orchestrator package that owns it. */
export function loadFactoryTemporalClient(repositoryRoot = resolve(import.meta.dir, "../../..")): Promise<TemporalClientModule> {
  loaded ??= (async () => {
    const require = createRequire(resolve(repositoryRoot, "packages/@ezcorp/factory-orchestrator/package.json"));
    return await import(require.resolve("@temporalio/client")) as TemporalClientModule;
  })();
  return loaded;
}

async function bytes(path: string): Promise<Buffer> { return Buffer.from(await readFactoryPrivatePath(path)); }

async function connect(endpoint: FactoryTemporalEndpoint, identity: { readonly certificatePath: string; readonly privateKeyPath: string }, token: string, client: TemporalClientModule): Promise<TemporalConnection> {
  return client.Connection.connect({
    address: endpoint.address,
    tls: { serverNameOverride: endpoint.serverName, serverRootCACertificate: await bytes(endpoint.caCertificatePath), clientCertPair: { crt: await bytes(identity.certificatePath), key: await bytes(identity.privateKeyPath) } },
    metadata: { authorization: `Bearer ${token.trim()}` },
    connectTimeout: 10_000,
  });
}

function code(error: unknown): number | undefined {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === "number" ? value : undefined;
}

/** Namespace administration with the operator's control identity. */
export function factoryTemporalNamespaceAdmin(endpoint: FactoryTemporalEndpoint, control: FactoryTemporalControlIdentity, authority: FactoryTemporalAuthorityPaths, client: () => Promise<TemporalClientModule> = () => loadFactoryTemporalClient()): FactoryTemporalNamespaceAdmin {
  const session = async <Result>(work: (connection: TemporalConnection) => Promise<Result>): Promise<Result> => {
    const keyPem = new TextDecoder().decode(await readFactoryPrivatePath(authority.tokenKeyPath));
    const token = factoryTemporalToken(FACTORY_TEMPORAL_CONTROL_SUBJECT, ["admin:temporal-system"], keyPem, authority.tokenKeyId, Math.floor(Date.now() / 1_000), 300);
    const connection = await connect(endpoint, control, token, await client());
    try { return await work(connection); } finally { await connection.close(); }
  };
  return {
    register: (namespace, ownerMarker) => session(async (connection) => {
      const archive = factoryTemporalLocalArchiveUris(namespace);
      const request = factoryTemporalRegisterRequest(factoryTemporalNamespaceArguments(namespace, archive.history, archive.visibility), ownerMarker);
      try { await connection.workflowService.registerNamespace({ ...request }); }
      catch (error) { if (code(error) !== GRPC.alreadyExists) throw new FactoryProvisioningError("temporal_register_failed", `Namespace ${namespace} could not be registered.`); }
    }),
    owner: (namespace) => session(async (connection) => {
      try { return (await connection.workflowService.describeNamespace({ namespace })).namespaceInfo?.description ?? ""; }
      catch (error) {
        if (code(error) === GRPC.notFound) return undefined;
        throw new FactoryProvisioningError("temporal_describe_failed", `Namespace ${namespace} could not be described (code ${code(error) ?? "unknown"}).`);
      }
    }),
  };
}

/** Whether one namespace credential can describe one namespace through the gateway. */
export function factoryTemporalAccessProbe(endpoint: FactoryTemporalEndpoint, client: () => Promise<TemporalClientModule> = () => loadFactoryTemporalClient()): FactoryTemporalAccessProbe {
  return {
    async describe(namespace, credential) {
      const token = new TextDecoder().decode(await readFactoryPrivatePath(credential.tokenPath));
      let connection: TemporalConnection;
      try { connection = await connect({ ...endpoint, caCertificatePath: credential.caCertificatePath }, credential, token, await client()); }
      catch { return false; }
      try { await connection.workflowService.describeNamespace({ namespace }); return true; }
      catch (error) {
        if (([GRPC.permissionDenied, GRPC.unauthenticated, GRPC.notFound] as readonly number[]).includes(code(error) ?? -1)) return false;
        throw new FactoryProvisioningError("temporal_probe_failed", `The namespace probe failed with code ${code(error) ?? "unknown"}.`);
      } finally { await connection.close(); }
    },
  };
}
