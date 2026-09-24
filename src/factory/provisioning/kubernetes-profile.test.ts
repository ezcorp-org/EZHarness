import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  makeFactoryPrivateRoot,
  makeFactoryTestDeploymentSettings,
  makeFactoryTestInstallation,
  removeFactoryPrivateRoot,
  writeFactoryTestDatabaseCredentials,
} from "../../__tests__/helpers/factory-private-root";
import { factoryComposeProject } from "./compose-profile";
import { FACTORY_CONTAINER_PATHS, FACTORY_CONTAINER_SERVICES, renderFactoryInstallationBundle, type FactoryInstallationBundle } from "./deployment";
import {
  factoryKubernetesManifestStream,
  factoryKubernetesNamespace,
  factoryKubernetesSecretName,
  renderFactoryKubernetesInstallation,
  renderFactoryKubernetesSystem,
  type FactoryKubernetesObject,
  type FactoryKubernetesSettings,
} from "./kubernetes-profile";

const SETTINGS: FactoryKubernetesSettings = {
  fleetId: "fleet-a", systemNamespace: "ezcorp-factory-system", ingressClassName: "nginx", ingressNamespace: "ingress-nginx",
  egressCidrs: ["10.0.0.0/24", "10.0.1.0/24"], egressPorts: [5432, 7233, 9000], runAsUser: 10_001,
  runtimeSocketPath: "/run/containerd/containerd.sock", nodeSelector: { "ezcorp.io/runner": "true" },
};

interface Container { name: string; image: string; command: string[]; env: { name: string; value: string }[]; securityContext: Record<string, unknown>; volumeMounts: { name: string; mountPath: string; subPath?: string; readOnly?: boolean }[] }
interface PodSpec { containers: Container[]; initContainers?: Container[]; volumes: Record<string, unknown>[]; hostNetwork?: boolean; securityContext?: Record<string, unknown>; automountServiceAccountToken?: boolean }

const kind = (objects: readonly FactoryKubernetesObject[], name: string) => objects.filter((object) => object.kind === name);
const podSpec = (workload: FactoryKubernetesObject) => (workload.spec as { template: { spec: PodSpec } }).template.spec;

let root: string;
let bundle: FactoryInstallationBundle;
let objects: readonly FactoryKubernetesObject[];
let system: readonly FactoryKubernetesObject[];

beforeAll(async () => {
  root = await makeFactoryPrivateRoot();
  const installation = makeFactoryTestInstallation(root);
  await writeFactoryTestDatabaseCredentials(installation);
  bundle = await renderFactoryInstallationBundle(installation, makeFactoryTestDeploymentSettings(join(root, "runtime")));
  objects = renderFactoryKubernetesInstallation(bundle, SETTINGS);
  system = renderFactoryKubernetesSystem(SETTINGS, bundle.image.reference, bundle.host.ports.pool);
});
afterAll(async () => { await removeFactoryPrivateRoot(root); });

describe("names", () => {
  test("the namespace is the Compose project name, so both profiles scope one installation alike", () => {
    expect(factoryKubernetesNamespace(bundle)).toBe(factoryComposeProject(bundle.installation));
    expect(factoryKubernetesNamespace(bundle)).toBe("ezcorp-factory-fleet-a-tenant-01");
    expect(factoryKubernetesSecretName("pool")).toBe("factory-pool-secrets");
  });
});

describe("renderFactoryKubernetesInstallation", () => {
  test("the tenant namespace enforces Pod Security restricted, and every namespaced object lives in it", () => {
    const [namespace] = kind(objects, "Namespace");
    const labels = (namespace!.metadata as { labels: Record<string, string> }).labels;
    expect(labels["pod-security.kubernetes.io/enforce"]).toBe("restricted");
    expect(labels["ezcorp.io/tenant"]).toBe("tenant-01");
    for (const object of objects.filter((entry) => entry.kind !== "Namespace")) {
      expect((object.metadata as { namespace: string }).namespace).toBe("ezcorp-factory-fleet-a-tenant-01");
    }
    expect(objects[0]!.kind).toBe("Namespace");
  });

  test("no tenant container is privileged; each runs as non-root, read-only, with every capability dropped", () => {
    const [deployment] = kind(objects, "Deployment");
    const spec = podSpec(deployment!);
    const containers = [...spec.containers, ...spec.initContainers!];
    expect(containers.map((container) => container.name).sort()).toEqual([...FACTORY_CONTAINER_SERVICES, "deliver-secrets"].sort());
    for (const container of containers) {
      expect(container.securityContext.privileged).toBeUndefined();
      expect(container.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 10_001, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } });
      expect(container.image).toBe(bundle.image.reference);
    }
    expect(spec.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 10_001 });
    expect(spec.automountServiceAccountToken).toBe(false);
  });

  test("no tenant pod uses the host: no hostPath volume and no host network", () => {
    const [deployment] = kind(objects, "Deployment");
    const spec = podSpec(deployment!);
    expect(spec.hostNetwork).toBeUndefined();
    expect(spec.volumes.filter((volume) => "hostPath" in volume)).toEqual([]);
    expect(JSON.stringify(objects)).not.toContain("hostPath");
    expect(JSON.stringify(objects)).not.toContain(SETTINGS.runtimeSocketPath);
  });

  test("Secret objects carry no data: they are created from the delivery files", () => {
    const secrets = kind(objects, "Secret");
    expect(secrets.map((secret) => (secret.metadata as { name: string }).name).sort()).toEqual(FACTORY_CONTAINER_SERVICES.map(factoryKubernetesSecretName).sort());
    for (const secret of [...secrets, ...kind(system, "Secret")]) {
      expect(secret.data).toBeUndefined();
      expect(secret.stringData).toBeUndefined();
    }
    // The shared pool's and the supervisor's material is the fleet host's: no tenant Secret for either.
    for (const shared of ["pool", "supervisor"]) expect(secrets.map((secret) => (secret.metadata as { name: string }).name)).not.toContain(factoryKubernetesSecretName(shared));
  });

  test("each container mounts only its own secrets emptyDir", () => {
    const [deployment] = kind(objects, "Deployment");
    const spec = podSpec(deployment!);
    const secretVolumes = new Set(FACTORY_CONTAINER_SERVICES.flatMap((service) => [`${service}-secrets`, `${service}-secret-source`]));
    for (const container of spec.containers) {
      const mounted = container.volumeMounts.filter((mount) => secretVolumes.has(mount.name));
      expect(mounted).toEqual([{ name: `${container.name}-secrets`, mountPath: FACTORY_CONTAINER_PATHS.secrets, readOnly: true }]);
    }
    for (const service of FACTORY_CONTAINER_SERVICES) {
      expect(spec.volumes).toContainEqual({ name: `${service}-secrets`, emptyDir: { medium: "Memory", sizeLimit: "4Mi" } });
      expect(spec.volumes).toContainEqual({ name: `${service}-secret-source`, secret: { secretName: factoryKubernetesSecretName(service), defaultMode: 0o400 } });
    }
    // Only the copier sees the Secret sources, read-only.
    const copier = spec.initContainers![0]!;
    expect(copier.volumeMounts.filter((mount) => mount.name.endsWith("-secret-source")).every((mount) => mount.readOnly === true)).toBe(true);
    expect(copier.command.join(" ")).toContain("umask 077 && cp -L /source/gateway/* /delivered/gateway/ && chmod 0600 /delivered/gateway/*");
    expect(copier.command.join(" ")).not.toContain("/source/pool/");
  });

  test("only the harness writes project data; the product reads readiness it does not write", () => {
    const [deployment] = kind(objects, "Deployment");
    const byName = Object.fromEntries(podSpec(deployment!).containers.map((container) => [container.name, container]));
    expect(byName.harness!.volumeMounts).toContainEqual({ name: "harness-data", mountPath: FACTORY_CONTAINER_PATHS.data });
    // The product's daemons write `.ezcorp` under /app, which the restricted pod's image cannot; it is the data volume's app-state.
    expect(byName.harness!.volumeMounts).toContainEqual({ name: "harness-data", mountPath: "/app/.ezcorp", subPath: "app-state" });
    for (const service of ["gateway", "orchestrator"]) expect(byName[service]!.volumeMounts.map((mount) => mount.name)).not.toContain("harness-data");
    const readiness = (service: string) => byName[service]!.volumeMounts.find((mount) => mount.name === "readiness")!.readOnly;
    expect([readiness("harness"), readiness("gateway"), readiness("orchestrator")]).toEqual([true, true, undefined]);
    expect(byName.pool).toBeUndefined();
  });

  test("each container gets only its own non-secret environment and runs its own process", () => {
    const [deployment] = kind(objects, "Deployment");
    const byName = Object.fromEntries(podSpec(deployment!).containers.map((container) => [container.name, container]));
    for (const service of FACTORY_CONTAINER_SERVICES) {
      const { EZCORP_INGRESS_PROOF_FILE: _proof, ...expected } = bundle.environment[service] as Record<string, string>;
      expect(Object.fromEntries(byName[service]!.env.map((entry) => [entry.name, entry.value]))).toEqual(expected);
    }
    expect(Object.keys(byName).sort()).toEqual(["gateway", "harness", "orchestrator"]);
    expect(byName.orchestrator!.command[0]).toBe("node");
    const probe = (service: string) => JSON.stringify((byName[service] as unknown as { readinessProbe: unknown }).readinessProbe);
    expect(probe("gateway")).toContain(`--tcp","127.0.0.1:${bundle.ports.gateway}`);
    expect(probe("orchestrator")).toContain("/run/ezcorp/readiness/orchestration/orchestration.json");
    const readiness = (name: string): unknown => (byName[name]!.volumeMounts as { name: string }[]).find((mount) => mount.name === "readiness");
    expect(readiness("orchestrator")).toEqual({ name: "readiness", mountPath: "/run/ezcorp/readiness/orchestration", subPath: "orchestration" });
    expect(readiness("harness")).toEqual({ name: "readiness", mountPath: "/run/ezcorp/readiness", readOnly: true });
    expect(probe("harness")).toContain("/api/ready");
    expect(byName.harness!.env.map((entry: { name: string }) => entry.name)).not.toContain("EZCORP_INGRESS_PROOF_FILE");
  });

  test("the ingress overwrites the installation header, and network policy admits only the ingress controller", () => {
    const [ingress] = kind(objects, "Ingress");
    const snippet = (ingress!.metadata as { annotations: Record<string, string> }).annotations["nginx.ingress.kubernetes.io/configuration-snippet"]!;
    expect(snippet).toBe('more_clear_input_headers "X-EZCorp-Installation"; proxy_set_header X-EZCorp-Installation "inst-tenant-01";');
    expect(JSON.stringify(ingress!.spec)).toContain('"host":"tenant-01.factory.example"');
    const policies = kind(objects, "NetworkPolicy");
    expect(policies.map((policy) => (policy.metadata as { name: string }).name)).toEqual(["default-deny", "installation"]);
    const policy = policies[1]!.spec as { ingress: unknown[]; egress: { to: unknown[]; ports: { port: number }[] }[] };
    expect(policy.ingress).toEqual([{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ingress-nginx" } } }], ports: [{ protocol: "TCP", port: bundle.ports.harness }] }]);
    expect(policy.egress[1]).toEqual({ to: [{ ipBlock: { cidr: "10.0.0.0/24" } }, { ipBlock: { cidr: "10.0.1.0/24" } }], ports: [5432, 7233, 9000].map((port) => ({ protocol: "TCP", port })) });
    // The fleet host's shared pool and supervisor, both in the system namespace.
    expect(policy.egress[2]).toEqual({ to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ezcorp-factory-system" } } }], ports: [{ protocol: "TCP", port: 41_002 }, { protocol: "TCP", port: 41_003 }] } as never);
  });

  test("the rendered list is frozen", () => {
    expect(Object.isFrozen(objects)).toBe(true);
    expect(Object.isFrozen(system)).toBe(true);
  });
});

describe("renderFactoryKubernetesSystem", () => {
  test("only the system DaemonSet is privileged, and it alone mounts the runtime socket", () => {
    const [namespace] = kind(system, "Namespace");
    expect((namespace!.metadata as { labels: Record<string, string> }).labels["pod-security.kubernetes.io/enforce"]).toBe("privileged");
    const [daemonSet] = kind(system, "DaemonSet");
    const spec = podSpec(daemonSet!);
    expect(spec.hostNetwork).toBe(true);
    expect(spec.containers.map((container) => container.securityContext.privileged)).toEqual([true]);
    expect(spec.volumes).toContainEqual({ name: "runtime-socket", hostPath: { path: SETTINGS.runtimeSocketPath, type: "Socket" } });
    expect(spec.containers[0]!.volumeMounts).toContainEqual({ name: "runtime-socket", mountPath: SETTINGS.runtimeSocketPath });
    expect((spec as unknown as { nodeSelector: unknown }).nodeSelector).toEqual(SETTINGS.nodeSelector);

    const everything = [...objects, ...system];
    const privileged = everything.filter((object) => JSON.stringify(object).includes('"privileged":true'));
    expect(privileged as unknown[]).toEqual([daemonSet]);
    const socketHolders = everything.filter((object) => JSON.stringify(object).includes(SETTINGS.runtimeSocketPath));
    expect(socketHolders as unknown[]).toEqual([daemonSet]);
  });

  test("the shared pool runs in the system namespace, restricted, from its own Secret, with its own readiness", () => {
    const [pool] = kind(system, "Deployment");
    expect((pool!.metadata as { name: string; namespace: string })).toMatchObject({ name: "factory-pool", namespace: "ezcorp-factory-system" });
    const spec = podSpec(pool!);
    expect(spec.hostNetwork).toBeUndefined();
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(spec.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 10_001 });
    const [container] = spec.containers;
    expect(container!.command).toEqual(["bun", "src/factory/pool/process.ts", "/run/ezcorp/secrets/pool.json"]);
    for (const each of [container!, spec.initContainers![0]!]) {
      expect(each.securityContext.privileged).toBeUndefined();
      expect(each.securityContext).toMatchObject({ runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } });
    }
    expect(container!.volumeMounts).toContainEqual({ name: "readiness", mountPath: "/run/ezcorp/readiness/pool" });
    expect(JSON.stringify((container as unknown as { readinessProbe: unknown }).readinessProbe)).toContain("/run/ezcorp/readiness/pool/pool.json");
    expect(spec.volumes).toContainEqual({ name: "pool-secret-source", secret: { secretName: factoryKubernetesSecretName("pool"), defaultMode: 0o400 } });
    expect(kind(system, "Secret").map((secret) => (secret.metadata as { name: string }).name)).toContain(factoryKubernetesSecretName("pool"));
    const [service] = kind(system, "Service");
    expect(service!.spec).toEqual({ selector: { "app.kubernetes.io/name": "factory-pool" }, ports: [{ name: "pool", port: 41_002, targetPort: 41_002 }] });
  });

  test("nothing tenant-scoped is rendered into the system namespace", () => {
    const text = JSON.stringify(system);
    expect(text).not.toContain("tenant-01");
    expect(text).not.toContain(bundle.installation.installationId);
  });
});

describe("factoryKubernetesManifestStream", () => {
  test("every document in the stream is valid JSON that round-trips to its object", () => {
    const stream = factoryKubernetesManifestStream([...system, ...objects]);
    expect(stream.endsWith("\n")).toBe(true);
    const documents = stream.trimEnd().split("\n---\n");
    expect(documents.length).toBe(system.length + objects.length);
    expect(documents.map((document) => JSON.parse(document))).toEqual(JSON.parse(JSON.stringify([...system, ...objects])));
  });

  test("an empty object list is an empty stream", () => {
    expect(factoryKubernetesManifestStream([])).toBe("\n");
  });
});
