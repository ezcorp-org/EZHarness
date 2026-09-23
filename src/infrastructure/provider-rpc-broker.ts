import { createHash, X509Certificate } from "node:crypto";
import { ContractError, type JsonValue } from "@ezcorp/extension-contract";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import { HostIncusProbeTransport, type HostConnectionResolver } from "./incus-transport/transport";
import type { IncusConnectionConfig } from "../../extensions/incus-sandbox/config";
import { IncusTransportError, type IncusTransportRequest } from "../../extensions/incus-sandbox/transport";

export const INCUS_PROVIDER_TRANSPORT_RPC = "ezcorp/provider.incus.transport";
export const INCUS_PROVIDER_PREFLIGHT_METHOD = "incus/preflight";

interface Connection extends Awaited<ReturnType<HostConnectionResolver["resolveForHost"]>> {
  id: string;
  revision: number;
  configuration: { kind: "incus"; profile: string; helperVersion: string; guestUser: string };
}

export interface ProviderConnectionResolver extends HostConnectionResolver {
  resolveForHost(scope: { connectionId: string; providerInstallationId: string; providerReleaseId: string; revision: number }): Promise<Connection>;
  getMetadata(id: string): Promise<Pick<Connection, "id" | "revision"> & { providerInstallationId: string; providerReleaseId: string; revokedAt: Date | null } | null>;
}

export interface PreparedIncusProbe {
  readonly installationId: string;
  readonly releaseId: string;
  readonly releaseDigest: string;
  readonly generation: number;
  readonly connectionId: string;
  readonly revision: number;
  readonly config: IncusConnectionConfig;
}

function fingerprint(pem: string): string {
  try { return createHash("sha256").update(new X509Certificate(pem).raw).digest("hex"); }
  catch { throw new ContractError("INVALID_PROVIDER_CONFIG", "Incus server identity is invalid"); }
}

/** Only ReleaseProcess calls this broker. No generic extension capability exposes it. */
export class ProviderRpcBroker {
  constructor(
    private readonly connections: ProviderConnectionResolver,
    private readonly transportFactory: (scope: PreparedIncusProbe, signal?: AbortSignal) => HostIncusProbeTransport =
      (scope, signal) => new HostIncusProbeTransport(connections, {
        providerInstallationId: scope.installationId,
        providerReleaseId: scope.releaseId,
        revision: scope.revision,
        signal,
      }),
  ) {}

  async prepare(snapshot: ActiveExtensionRelease, connectionId: string): Promise<PreparedIncusProbe> {
    if (!snapshot.release.manifest.sandboxProviders?.some((provider) => provider.id === "incus" && provider.kind === "sandbox")
      || !snapshot.release.manifest.methods?.some((method) => method.name === INCUS_PROVIDER_PREFLIGHT_METHOD)) {
      throw new ContractError("UNDECLARED_CONTRIBUTION", "Incus provider preflight is not declared");
    }
    const metadata = await this.connections.getMetadata(connectionId);
    if (!metadata || metadata.revokedAt || metadata.providerInstallationId !== snapshot.installation.id
      || metadata.providerReleaseId !== snapshot.release.id) {
      throw new ContractError("INVALID_PROVIDER_CONFIG", "Incus provider connection is unavailable");
    }
    let connection: Connection;
    try {
      connection = await this.connections.resolveForHost({
        connectionId, providerInstallationId: snapshot.installation.id,
        providerReleaseId: snapshot.release.id, revision: metadata.revision,
      });
    } catch {
      throw new ContractError("INVALID_PROVIDER_CONFIG", "Incus provider connection is unavailable");
    }
    if (connection.configuration.kind !== "incus") {
      throw new ContractError("INVALID_PROVIDER_CONFIG", "Incus provider connection has the wrong kind");
    }
    return Object.freeze({
      installationId: snapshot.installation.id,
      releaseId: snapshot.release.id,
      releaseDigest: snapshot.release.releaseDigest,
      generation: snapshot.installation.generation,
      connectionId,
      revision: metadata.revision,
      config: Object.freeze({
        connectionId,
        serverCertificateSha256: fingerprint(connection.serverCertificatePem),
        project: connection.project,
        profile: connection.configuration.profile,
        helperVersion: connection.configuration.helperVersion,
        guestUser: connection.configuration.guestUser,
      }),
    });
  }

  async request(scope: PreparedIncusProbe, input: Record<string, unknown>, deadline: number, signal?: AbortSignal): Promise<JsonValue> {
    try { return { ok: true, result: await this.probe(scope, input, deadline, signal) } as JsonValue; }
    catch (error) {
      if (error instanceof IncusTransportError) {
        return { ok: false, error: { kind: error.kind, effect: error.effect,
          ...(error.operationId ? { operationId: error.operationId } : {}) } } as JsonValue;
      }
      throw error;
    }
  }

  private async probe(scope: PreparedIncusProbe, input: Record<string, unknown>, deadline: number, signal?: AbortSignal): Promise<JsonValue> {
    if (signal?.aborted) throw new IncusTransportError("deadline", "Incus probe was cancelled");
    if (Object.keys(input).length !== 1 || !input.command || typeof input.command !== "object" || Array.isArray(input.command)) {
      throw new ContractError("INVALID_REQUEST", "Invalid Incus provider request");
    }
    const command = input.command as unknown as IncusTransportRequest;
    if (command.action !== "probe") throw new IncusTransportError("unsupported", "Incus transport action is unavailable");
    if (!command.pins || typeof command.pins !== "object" || Array.isArray(command.pins)
      || !command.tags || typeof command.tags !== "object" || Array.isArray(command.tags)) {
      throw new IncusTransportError("invalid", "Invalid Incus provider request");
    }
    if (command.connectionId !== scope.connectionId
      || command.pins?.connectionId !== scope.connectionId
      || command.pins?.serverCertificateSha256 !== scope.config.serverCertificateSha256
      || command.pins?.project !== scope.config.project || command.pins?.profile !== scope.config.profile
      || command.pins?.helperVersion !== scope.config.helperVersion || command.pins?.guestUser !== scope.config.guestUser) {
      throw new IncusTransportError("permission", "Incus provider request is outside its approved connection");
    }
    const result = await this.transportFactory(scope, signal).request({ ...command, deadlineMs: Math.min(command.deadlineMs, deadline) });
    return result as unknown as JsonValue;
  }
}
