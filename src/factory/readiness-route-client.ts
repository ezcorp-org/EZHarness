/**
 * A shared host service's readiness route, read over the transport the
 * installation already holds for it (W4H-35, the hosted profile).
 *
 * In the hosted profile an installation pod cannot mount the files the shared
 * pool and supervisor write, so it reads the same records from their own
 * readiness routes: the pool's over the pool transport, the supervisor's over
 * the host launch transport. This client only fetches; the probe judges the
 * record with the same verifier the file reader uses, and any answer but a
 * 200 with a JSON body is a failure.
 */
import { createGatewayTransport, type GatewayTransportOptions } from "@ezcorp/factory-transport";
import { FACTORY_POOL_READINESS_PATH } from "./pool/service-routes";
import { FACTORY_HOST_READINESS_PATH } from "./runner/host-launch-service";
import type { FactoryReadinessSource } from "./service-probes";
import { factoryStartupPoolTransport, type FactoryStartupConfig } from "./startup-config";

/** A readiness record is a few hundred bytes; the routes publish at most 4 KiB. */
const READINESS_BYTES_LIMIT = 4_096;

export async function createFactoryReadinessRouteClient(options: GatewayTransportOptions, path: string): Promise<FactoryReadinessSource> {
  const transport = await createGatewayTransport(options);
  return Object.freeze({
    async read(signal: AbortSignal): Promise<unknown> {
      const response = await transport.request("GET", path, undefined, READINESS_BYTES_LIMIT, signal);
      if (response.statusCode !== 200) throw new Error(`readiness route ${path} answered ${response.statusCode}`);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
    },
  });
}

/**
 * Both shared hosts' sources for a hosted document: the pool's record over the
 * transport the installation's pool client uses, the supervisor's over its host
 * launch transport. A document with no host launch transport is refused here;
 * the startup parser already requires one beside `hostReadiness: network`.
 */
export async function factoryHostReadinessSources(config: Pick<FactoryStartupConfig, "pool" | "hostLaunch">): Promise<{ readonly pool: FactoryReadinessSource; readonly supervisor: FactoryReadinessSource }> {
  if (config.hostLaunch === undefined) throw new Error("factory_host_readiness_transport_missing");
  const pool = await createFactoryReadinessRouteClient(factoryStartupPoolTransport(config.pool), FACTORY_POOL_READINESS_PATH);
  const supervisor = await createFactoryReadinessRouteClient({ baseUrl: config.hostLaunch.baseUrl, serverName: config.hostLaunch.serverName, tls: config.hostLaunch.tls }, FACTORY_HOST_READINESS_PATH);
  return Object.freeze({ pool, supervisor });
}
