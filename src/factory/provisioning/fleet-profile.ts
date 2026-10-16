/**
 * What differs between the two deployment profiles, and only that (C12: "the
 * two profiles share one code path"). The seven steps, the ledger, the fleet
 * host and the upgrade waves are composed once in `fleet.ts`; this module
 * supplies the profile's own parts: where step 5 runs a bundle, where the
 * fleet host runs its pool and supervisor, how a service sees the fleet's
 * shared infrastructure, and how the trusted ingress is served and reloaded.
 *
 *   - `compose`: rootless Podman Compose on the host, loopback addresses, the
 *     platform's own nginx, the supervisor as a host systemd unit.
 *   - `kubernetes` (W4H-35): the cluster named by the operator's kubeconfig,
 *     the pods' own view of the fleet's services, the pool and supervisor in
 *     the system namespace, and the same nginx there as the trusted ingress.
 */
import { resolve } from "node:path";
import {
  FactoryComposeHostTarget,
  FactoryComposeTarget,
  factoryComposeProject,
  factoryComposeUpgradeDeployer,
  type FactoryCommandExecutor,
  type FactoryComposeCommand,
} from "./compose-profile";
import type { FactoryDeploymentHandle, FactoryDeploymentNetwork, FactoryDeploymentTarget, FactoryInstallationBundle } from "./deployment";
import type { FactoryFleetSettings } from "./fleet";
import type { FactoryUpgradeDeployer } from "./fleet-upgrade";
import { factoryFleetHostIdentity, type FactoryFleetHostRuntime } from "./host";
import type { FactoryIngressReloader } from "./ingress";
import type { FactoryInstallationContext } from "./installation";
import { factoryKubernetesServiceUrl } from "./kubernetes-paths";
import type { FactoryKubernetesSettings } from "./kubernetes-profile";
import { FactoryKubernetesHostTarget, FactoryKubernetesIngressReloader, FactoryKubernetesTarget } from "./kubernetes-target";
import { factoryPlatformServices, factoryPodmanIngressReloader, type FactoryPlatformSettings } from "./platform";
import { factoryInstallationPorts } from "./ports";

/** A deployment target the operator's `stop` and `up` can also drive. */
export interface FactoryProfileTarget extends FactoryDeploymentTarget {
  stop(handle: FactoryDeploymentHandle): Promise<void>;
  start(bundle: FactoryInstallationBundle): Promise<void>;
}

export interface FactoryFleetProfileOptions {
  readonly execute: FactoryCommandExecutor;
  readonly compose: FactoryComposeCommand;
  readonly uid: number;
  readonly gid: number;
  /** The platform's ingress root (`platform.ts`): the files the ingress serves. */
  readonly ingressRoot: string;
}

export interface FactoryFleetProfile {
  readonly target: FactoryProfileTarget;
  readonly hostTarget: FactoryFleetHostRuntime;
  /** Present for the hosted profile: the fleet host renders the supervisor DaemonSet's documents. */
  readonly hosted?: { readonly systemNamespace: string };
  /** How a service sees the fleet's shared infrastructure. */
  readonly network: Omit<FactoryDeploymentNetwork, "publicOrigin" | "portBase" | "temporalServerName">;
  readonly platform: Pick<FactoryPlatformSettings, "ingressAddress" | "ingressPort" | "hostedIngress">;
  readonly ingress: {
    readonly listenAddress: string;
    readonly listenPort: number;
    readonly reloader: FactoryIngressReloader;
    readonly upstreamPort: (installation: FactoryInstallationContext) => number;
    readonly upstreamHost?: (installation: FactoryInstallationContext) => string;
  };
  readonly upgrades: FactoryUpgradeDeployer<FactoryInstallationBundle>;
}

/** The hosted profile's renderer settings, from the fleet's `kubernetes` block. */
export function factoryFleetKubernetesSettings(settings: FactoryFleetSettings): FactoryKubernetesSettings {
  const kubernetes = settings.kubernetes!;
  return Object.freeze({
    fleetId: settings.fleetId, systemNamespace: kubernetes.systemNamespace, egressCidrs: kubernetes.egressCidrs, egressPorts: kubernetes.egressPorts,
    runAsUser: kubernetes.runAsUser, runtimeSocketPath: kubernetes.runtimeSocketPath, nodeSelector: kubernetes.nodeSelector,
  });
}

function composeProfile(settings: FactoryFleetSettings, options: FactoryFleetProfileOptions): FactoryFleetProfile {
  const release = settings.release.directory;
  const storagePorts = [settings.storage.ordinary.endpoint, settings.storage.archive.endpoint].map((endpoint) => Number(new URL(endpoint).port));
  const target = new FactoryComposeTarget({
    compose: options.compose, templatePath: resolve(release, "deploy/factory/compose/installation.yml"), execute: options.execute,
    databasePort: settings.database.servicePort, storagePorts, temporalPort: settings.temporal.port, temporalHttpPort: settings.temporal.httpPort, uid: options.uid, gid: options.gid,
  });
  const profile: FactoryFleetProfile = {
    target,
    hostTarget: new FactoryComposeHostTarget({
      compose: options.compose, templatePath: resolve(release, "deploy/factory/compose/host.yml"), execute: options.execute,
      supervisor: { bun: settings.release.bun, releaseDirectory: release, path: settings.release.path },
      databasePort: settings.database.servicePort, uid: options.uid, gid: options.gid,
    }),
    network: {
      databaseHost: settings.database.serviceHost, databasePort: settings.database.servicePort,
      ordinaryEndpoint: settings.storage.ordinary.endpoint, archiveEndpoint: settings.storage.archive.endpoint,
      temporalAddress: `127.0.0.1:${settings.temporal.port}`, temporalHttpEndpoint: `https://127.0.0.1:${settings.temporal.httpPort}`,
    },
    platform: { ingressAddress: settings.ingress.address, ingressPort: settings.ingress.port },
    ingress: {
      listenAddress: settings.ingress.address, listenPort: settings.ingress.port,
      reloader: factoryPodmanIngressReloader(settings.fleetId, options.execute),
      upstreamPort: (installation) => factoryInstallationPorts(installation.tenantId, settings.installations.portBase).harness,
    },
    upgrades: factoryComposeUpgradeDeployer(target),
  };
  return Object.freeze(profile);
}

async function kubernetesProfile(settings: FactoryFleetSettings, options: FactoryFleetProfileOptions): Promise<FactoryFleetProfile> {
  const kubernetes = settings.kubernetes!;
  const cluster = { execute: options.execute, kubectl: kubernetes.kubectl, kubeconfigPath: kubernetes.kubeconfigPath };
  const rendered = factoryFleetKubernetesSettings(settings);
  const target = new FactoryKubernetesTarget({ ...cluster, settings: rendered });
  const ports = factoryFleetHostIdentity(settings.fleetId, settings.installations.portBase).ports;
  const { ingressImage } = await factoryPlatformServices(settings.release.directory);
  const profile: FactoryFleetProfile = {
    target,
    hostTarget: new FactoryKubernetesHostTarget({ ...cluster, settings: rendered }),
    hosted: { systemNamespace: kubernetes.systemNamespace },
    network: {
      ...kubernetes.services,
      hostAddresses: { pool: factoryKubernetesServiceUrl("factory-pool", kubernetes.systemNamespace, ports.pool), supervisor: factoryKubernetesServiceUrl("factory-supervisor", kubernetes.systemNamespace, ports.supervisor) },
    },
    platform: { ingressAddress: "0.0.0.0", ingressPort: kubernetes.ingress.listenPort, hostedIngress: true },
    ingress: {
      listenAddress: "0.0.0.0", listenPort: kubernetes.ingress.listenPort,
      reloader: new FactoryKubernetesIngressReloader({ ...cluster, settings: rendered, root: options.ingressRoot, image: ingressImage, listenPort: kubernetes.ingress.listenPort, nodePort: kubernetes.ingress.nodePort }),
      // The installation's harness Service listens on 80 (`kubernetes-profile.ts`).
      upstreamPort: () => 80,
      upstreamHost: (installation) => `harness.${factoryComposeProject(installation)}.svc.cluster.local`,
    },
    // One pod holds the three processes, so a component's new image rolls the pod; the wave still moves them in C12 order.
    upgrades: { component: async (bundle) => { await target.apply(bundle); }, ready: (bundle) => target.ready(bundle) },
  };
  return Object.freeze(profile);
}

export async function factoryFleetProfile(settings: FactoryFleetSettings, options: FactoryFleetProfileOptions): Promise<FactoryFleetProfile> {
  return settings.profile === "kubernetes" ? kubernetesProfile(settings, options) : composeProfile(settings, options);
}
