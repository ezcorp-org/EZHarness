import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { makeFactoryTestFleetSettings, makeFactoryTestInstallation } from "../../__tests__/helpers/factory-private-root";
import { FactoryComposeHostTarget, FactoryComposeTarget, type FactoryCommandExecutor } from "./compose-profile";
import type { FactoryInstallationBundle } from "./deployment";
import type { FactoryFleetSettings } from "./fleet";
import { factoryFleetHostSettings, factoryFleetKubernetesSettings, factoryFleetProfile } from "./fleet-profile";
import { factoryFleetHostIdentity } from "./host";
import { FactoryKubernetesHostTarget, FactoryKubernetesIngressReloader, FactoryKubernetesTarget } from "./kubernetes-target";
import { factoryPlatformServices } from "./platform";
import { factoryInstallationPorts } from "./ports";

const REPOSITORY = join(import.meta.dir, "..", "..", "..");
const KUBERNETES = {
  kubectl: "/nix/store/kubectl/bin/kubectl", kubeconfigPath: "/srv/operator/kubeconfig", systemNamespace: "ezcorp-factory-fleet-a", monitoring: { namespace: "monitoring" },
  runAsUser: 10_001, runtimeSocketPath: "/run/podman/podman.sock", runnerRoot: "/srv/ezcorp-runner", nodeCidrs: ["10.89.1.0/24"], nodeSelector: { "kubernetes.io/os": "linux" }, ingress: { listenPort: 8443, nodePort: 30443 },
  egressCidrs: ["10.89.0.0/24"], egressPorts: [5432, 8333, 32001],
  services: { databaseHost: "10.89.0.2", databasePort: 5432, ordinaryEndpoint: "http://10.89.0.3:8333", archiveEndpoint: "http://10.89.0.4:8333", temporalAddress: "10.89.0.5:7233", temporalHttpEndpoint: "https://10.89.0.5:7244" },
};
const base = makeFactoryTestFleetSettings();
const compose: FactoryFleetSettings = { ...base, release: { ...base.release, directory: REPOSITORY } };
const hosted: FactoryFleetSettings = { ...compose, profile: "kubernetes", kubernetes: KUBERNETES };
const execute: FactoryCommandExecutor = async () => ({ code: 0, stdout: "", stderr: "" });
const options = { execute, compose: { argv: ["docker", "compose"], env: {} }, uid: 1001, gid: 1001, ingressRoot: "/srv/operator/platform/ingress" };
const installation = makeFactoryTestInstallation("/srv/factory");

describe("factoryFleetProfile", () => {
  test("compose: the host's Compose targets, loopback addresses, the platform's own ingress, and services named by Compose service", async () => {
    const profile = await factoryFleetProfile(compose, options);
    expect(profile.target).toBeInstanceOf(FactoryComposeTarget);
    expect(profile.hostTarget).toBeInstanceOf(FactoryComposeHostTarget);
    expect(profile.hosted).toBeUndefined();
    expect(profile.network).toEqual({
      databaseHost: base.database.serviceHost, databasePort: base.database.servicePort,
      ordinaryEndpoint: base.storage.ordinary.endpoint, archiveEndpoint: base.storage.archive.endpoint,
      temporalAddress: `127.0.0.1:${base.temporal.port}`, temporalHttpEndpoint: `https://127.0.0.1:${base.temporal.httpPort}`,
    });
    expect(profile.platform).toEqual({ ingressAddress: base.ingress.address, ingressPort: base.ingress.port });
    expect([profile.ingress.listenAddress, profile.ingress.listenPort, profile.ingress.upstreamHost]).toEqual([base.ingress.address, base.ingress.port, undefined]);
    expect(profile.ingress.upstreamPort(installation)).toBe(factoryInstallationPorts("tenant-01", base.installations.portBase).harness);
    const recreate = spyOn(profile.target as FactoryComposeTarget, "recreate").mockResolvedValue(undefined);
    await profile.upgrades.component({} as FactoryInstallationBundle, "orchestrator");
    expect(recreate).toHaveBeenCalledWith({}, ["orchestrator"]);
  });

  test("kubernetes: the cluster's targets, the pods' own addresses, host services by name, and the in-cluster ingress over the harness service", async () => {
    const profile = await factoryFleetProfile(hosted, options);
    expect(profile.target).toBeInstanceOf(FactoryKubernetesTarget);
    expect(profile.hostTarget).toBeInstanceOf(FactoryKubernetesHostTarget);
    expect(profile.hosted).toEqual({ systemNamespace: "ezcorp-factory-fleet-a", runnerRoot: "/srv/ezcorp-runner", monitored: true });
    const ports = factoryFleetHostIdentity("fleet-a", base.installations.portBase).ports;
    expect(profile.network).toEqual({
      ...KUBERNETES.services,
      hostAddresses: { pool: `https://factory-pool.ezcorp-factory-fleet-a.svc.cluster.local:${ports.pool}`, supervisor: `https://factory-supervisor.ezcorp-factory-fleet-a.svc.cluster.local:${ports.supervisor}` },
    });
    expect(profile.platform).toEqual({ ingressAddress: "0.0.0.0", ingressPort: 8443, hostedIngress: true });
    expect(profile.ingress.reloader).toBeInstanceOf(FactoryKubernetesIngressReloader);
    expect([profile.ingress.listenAddress, profile.ingress.listenPort, profile.ingress.upstreamPort(installation)]).toEqual(["0.0.0.0", 8443, 80]);
    expect(profile.ingress.upstreamHost!(installation)).toBe(`harness.ezcorp-factory-${installation.fleetId}-tenant-01.svc.cluster.local`);
    // One pod holds the three processes: a component's move re-applies the bundle, and ready is the target's.
    const apply = spyOn(profile.target as FactoryKubernetesTarget, "apply").mockResolvedValue({});
    const ready = spyOn(profile.target as FactoryKubernetesTarget, "ready").mockResolvedValue(undefined);
    await profile.upgrades.component({} as FactoryInstallationBundle, "harness");
    await profile.upgrades.ready({} as FactoryInstallationBundle);
    expect([apply.mock.calls.length, ready.mock.calls.length]).toEqual([1, 1]);
  });

  test("the hosted ingress runs the Compose platform's nginx pin", async () => {
    const reloader = (await factoryFleetProfile(hosted, options)).ingress.reloader as unknown as { options: { image: string } };
    expect(reloader.options.image).toBe((await factoryPlatformServices(REPOSITORY)).ingressImage);
  });
});

test("factoryFleetKubernetesSettings is the renderer's view of the fleet's kubernetes block", () => {
  expect(factoryFleetKubernetesSettings(hosted)).toEqual({
    fleetId: "fleet-a", systemNamespace: KUBERNETES.systemNamespace, egressCidrs: KUBERNETES.egressCidrs, egressPorts: KUBERNETES.egressPorts,
    runAsUser: KUBERNETES.runAsUser, runtimeSocketPath: KUBERNETES.runtimeSocketPath, runnerRoot: KUBERNETES.runnerRoot, nodeCidrs: KUBERNETES.nodeCidrs, nodeSelector: KUBERNETES.nodeSelector,
    monitoringNamespace: KUBERNETES.monitoring.namespace,
  });
});

// C12 "Kubernetes deployment target" (W4H-35, D-C): monitoring is optional; without it the renderer gets no monitoring namespace and
// the hosted supervisor is not monitored.
test("without kubernetes.monitoring, the renderer gets no monitoring namespace and the hosted host is not monitored", () => {
  const { monitoring: _monitoring, ...unmonitored } = hosted.kubernetes!;
  const fleet = { ...hosted, kubernetes: unmonitored };
  expect("monitoringNamespace" in factoryFleetKubernetesSettings(fleet)).toBe(false);
  expect(factoryFleetKubernetesSettings(hosted).monitoringNamespace).toBe("monitoring");
});

test("factoryFleetKubernetesSettings carries the supervisor's runtime groups only when the fleet names them (W4H-35 run 12)", () => {
  const withGroups = { ...hosted, kubernetes: { ...hosted.kubernetes!, runtimeGroups: [985] } };
  expect(factoryFleetKubernetesSettings(withGroups).runtimeGroups).toEqual([985]);
  expect("runtimeGroups" in factoryFleetKubernetesSettings(hosted)).toBe(false);
});

test("the fleet host's pool dials the database as the profile's services see it: loopback for Compose, the pods' own address hosted (W4H-35 C3)", async () => {
  const composeHost = factoryFleetHostSettings(compose, await factoryFleetProfile(compose, options));
  expect(composeHost.database).toEqual({ host: base.database.serviceHost, port: base.database.servicePort });
  expect(composeHost.hosted).toBeUndefined();
  const hostedHost = factoryFleetHostSettings(hosted, await factoryFleetProfile(hosted, options));
  expect(hostedHost.database).toEqual({ host: KUBERNETES.services.databaseHost, port: KUBERNETES.services.databasePort });
  expect(hostedHost.hosted).toEqual({ systemNamespace: KUBERNETES.systemNamespace, runnerRoot: KUBERNETES.runnerRoot, monitored: true });
  expect(hostedHost).toMatchObject({ fleetId: "fleet-a", secretsRoot: base.roots.secrets, operatorRoot: base.roots.operator, runtimeRoot: base.roots.runtime, portBase: base.installations.portBase, resources: base.resources });
  expect(hostedHost.build).toEqual({ image: base.image.reference, revision: base.image.revision, release: REPOSITORY });
});
