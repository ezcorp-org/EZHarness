import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { judgePrivatePaths, podTemplate, privatePathUses, type PrivatePathUse } from "../../__tests__/helpers/kubernetes-private-paths";
import { FACTORY_KUBERNETES_SUPERVISOR_PATHS } from "./kubernetes-paths";
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
  factoryKubernetesImages,
  factoryKubernetesManifestStream,
  factoryKubernetesNamespace,
  factoryKubernetesSecretName,
  renderFactoryKubernetesIngress,
  renderFactoryKubernetesInstallation,
  renderFactoryKubernetesSystem,
  type FactoryKubernetesObject,
  type FactoryKubernetesSettings,
} from "./kubernetes-profile";
import { factoryPrometheusRuleResource } from "../observability/alert-rules";
import { FACTORY_PROMETHEUS_JOBS } from "../observability/prometheus-config";

const SETTINGS: FactoryKubernetesSettings = {
  fleetId: "fleet-a", systemNamespace: "ezcorp-factory-system",
  egressCidrs: ["10.0.0.0/24", "10.0.1.0/24"], egressPorts: [5432, 7233, 9000], runAsUser: 10_001,
  runtimeSocketPath: "/run/containerd/containerd.sock", runnerRoot: "/srv/ezcorp-runner", nodeCidrs: ["172.18.0.0/16"], nodeSelector: { "ezcorp.io/runner": "true" },
  monitoringNamespace: "monitoring",
};

/** The ingress fixture: the Compose platform's nginx, pinned, with one file in each of its three places. */
const NGINX = `docker.io/library/nginx@sha256:${"2".repeat(64)}`;
const files = { "nginx.conf": "events {}\n", "conf/ezcorp-factory.conf": "server {}\n", "certs/tenant-01.crt": "crt", "certs/tenant-01.key": "key" };
const ingress = () => renderFactoryKubernetesIngress(SETTINGS, { image: NGINX, listenPort: 8443, nodePort: 30443, files });

interface Container { name: string; image: string; command: string[]; env: { name: string; value: string }[]; securityContext: Record<string, unknown>; volumeMounts: { name: string; mountPath: string; subPath?: string; readOnly?: boolean }[]; ports?: { name: string; containerPort: number }[] }
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
  system = renderFactoryKubernetesSystem(SETTINGS, bundle.image.reference, bundle.host.ports);
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

  test("the installation pod's termination grace outlasts the harness's shutdown hard timeout", async () => {
    const { HARD_TIMEOUT_MS } = await import("../../../web/src/lib/server/shutdown");
    const [deployment] = kind(objects, "Deployment");
    const spec = podSpec(deployment!) as PodSpec & { terminationGracePeriodSeconds?: number };
    expect((spec.terminationGracePeriodSeconds ?? 0) * 1_000).toBeGreaterThan(HARD_TIMEOUT_MS);
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
    expect(secrets.map((secret) => (secret.metadata as { name: string }).name).sort()).toEqual([...FACTORY_CONTAINER_SERVICES.map(factoryKubernetesSecretName), "factory-metrics-scrape"].sort());
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
      expect(mounted).toEqual([{ name: `${container.name}-secrets`, mountPath: FACTORY_CONTAINER_PATHS.secrets, subPath: "private", readOnly: true }]);
    }
    for (const service of FACTORY_CONTAINER_SERVICES) {
      expect(spec.volumes).toContainEqual({ name: `${service}-secrets`, emptyDir: { medium: "Memory", sizeLimit: "4Mi" } });
      expect(spec.volumes).toContainEqual({ name: `${service}-secret-source`, secret: { secretName: factoryKubernetesSecretName(service), defaultMode: 0o400 } });
    }
    // Only the copier sees the Secret sources, read-only.
    const copier = spec.initContainers![0]!;
    expect(copier.volumeMounts.filter((mount) => mount.name.endsWith("-secret-source")).every((mount) => mount.readOnly === true)).toBe(true);
    expect(copier.command.join(" ")).toContain("umask 077 && mkdir -p -m 0700 /delivered/gateway-secrets/private && cp -L /source/gateway/* /delivered/gateway-secrets/private/ && chmod 0600 /delivered/gateway-secrets/private/*");
    expect(copier.command.join(" ")).toContain("mkdir -p -m 0700 /delivered/readiness/orchestration");
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
      expect(Object.fromEntries(byName[service]!.env.map((entry) => [entry.name, entry.value]))).toEqual(bundle.environment[service] as Record<string, string>);
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
    // The harness checks the ingress proof in this profile too (C12 row "Trusted ingress"): the proof file is named, and delivered with its Secret.
    expect(byName.harness!.env.map((entry: { name: string }) => entry.name)).toContain("EZCORP_INGRESS_PROOF_FILE");
  });

  test("no annotation sets a header: there is no Ingress object, and network policy admits only the fleet's ingress pods and, on the guest-broker port, the system namespace", () => {
    expect(kind(objects, "Ingress")).toEqual([]);
    expect(JSON.stringify(objects)).not.toContain("configuration-snippet");
    const policies = kind(objects, "NetworkPolicy");
    expect(policies.map((policy) => (policy.metadata as { name: string }).name)).toEqual(["default-deny", "installation"]);
    const policy = policies[1]!.spec as { ingress: unknown[]; egress: { to: unknown[]; ports: { port: number }[] }[] };
    // The node-address rule (W4H-35 C3) is the fourth entry, tested on its own below.
    expect(policy.ingress.slice(0, 3)).toEqual([
      { from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ezcorp-factory-system" } }, podSelector: { matchLabels: { "app.kubernetes.io/name": "factory-ingress" } } }], ports: [{ protocol: "TCP", port: bundle.ports.harness }] },
      // Only the fleet host's supervisor, in the system namespace, reaches W01g's guest-broker route.
      { from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ezcorp-factory-system" } } }], ports: [{ protocol: "TCP", port: bundle.ports.guestBroker }] },
      // C11 M4: only the platform's Prometheus reaches the three /metrics ports.
      { from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "monitoring" } } }], ports: [bundle.ports.gatewayMetrics, bundle.ports.harnessMetrics, bundle.ports.orchestratorMetrics].map((port) => ({ protocol: "TCP", port })) },
    ]);
    expect(policy.egress[1]).toEqual({ to: [{ ipBlock: { cidr: "10.0.0.0/24" } }, { ipBlock: { cidr: "10.0.1.0/24" } }], ports: [5432, 7233, 9000].map((port) => ({ protocol: "TCP", port })) });
    // The fleet host's shared pool and supervisor, both in the system namespace.
    expect(policy.egress[2]).toEqual({ to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ezcorp-factory-system" } } }], ports: [{ protocol: "TCP", port: 41_002 }, { protocol: "TCP", port: 41_003 }] } as never);
  });

  test("the supervisor runs on the host network, so the nodes' addresses reach the guest-broker route and are reached on the supervisor port (W4H-35 C3)", () => {
    const policy = kind(objects, "NetworkPolicy")[1]!.spec as { ingress: unknown[]; egress: unknown[] };
    expect(policy.ingress[3]).toEqual({ from: [{ ipBlock: { cidr: "172.18.0.0/16" } }], ports: [{ protocol: "TCP", port: bundle.ports.guestBroker }] });
    expect(policy.egress[3]).toEqual({ to: [{ ipBlock: { cidr: "172.18.0.0/16" } }], ports: [{ protocol: "TCP", port: 41_003 }] });
    // No node addresses declared: no rule (an empty peer list would admit everything).
    const none = renderFactoryKubernetesInstallation(bundle, { ...SETTINGS, nodeCidrs: [] });
    const bare = kind(none, "NetworkPolicy")[1]!.spec as { ingress: unknown[]; egress: unknown[] };
    expect([bare.ingress.length, bare.egress.length]).toEqual([3, 3]);
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
    // No start-time type check (C12 row "Container runtime readiness (hosted)"): a node without the socket still starts the
    // supervisor, whose connection probe holds the runtime role by name instead (W4H-35 run 12).
    expect(spec.volumes).toContainEqual({ name: "runtime-socket", hostPath: { path: SETTINGS.runtimeSocketPath } });
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
    expect(container!.volumeMounts).toContainEqual({ name: "readiness", mountPath: "/run/ezcorp/readiness/pool", subPath: "pool" });
    expect(JSON.stringify((container as unknown as { readinessProbe: unknown }).readinessProbe)).toContain("/run/ezcorp/readiness/pool/pool.json");
    expect(spec.volumes).toContainEqual({ name: "pool-secret-source", secret: { secretName: factoryKubernetesSecretName("pool"), defaultMode: 0o400 } });
    expect(kind(system, "Secret").map((secret) => (secret.metadata as { name: string }).name)).toContain(factoryKubernetesSecretName("pool"));
    const [service] = kind(system, "Service");
    expect(service!.spec).toEqual({ selector: { "app.kubernetes.io/name": "factory-pool" }, ports: [{ name: "pool", port: 41_002, targetPort: 41_002 }] });
  });

  test("the supervisor reads its host identity from private copies, publishes readiness, and is reached on its own node (W4H-35)", () => {
    const [daemonSet] = kind(system, "DaemonSet");
    const spec = podSpec(daemonSet!) as PodSpec & { dnsPolicy: string };
    // On the host network, and still able to resolve each installation's harness service for the guest-broker route.
    expect(spec.dnsPolicy).toBe("ClusterFirstWithHostNet");
    const [copy] = spec.initContainers!;
    expect(copy!.command).toEqual(["sh", "-ec", "umask 077 && mkdir -p -m 0700 /delivered/supervisor-secrets/private && cp -L /source/supervisor/* /delivered/supervisor-secrets/private/ && chmod 0600 /delivered/supervisor-secrets/private/* && mkdir -p -m 0700 /delivered/readiness/supervisor && mkdir -p -m 0700 /delivered/runner-root/supervisor-state"]);
    expect(copy!.volumeMounts).toEqual([{ name: "supervisor-secret-source", mountPath: "/source/supervisor", readOnly: true }, { name: "supervisor-secrets", mountPath: "/delivered/supervisor-secrets" }, { name: "readiness", mountPath: "/delivered/readiness" }, { name: "runner-root", mountPath: "/delivered/runner-root" }]);
    const [container] = spec.containers;
    expect(container!.command).toEqual(["bun", "src/factory/runner/supervisor-process.ts", "/run/ezcorp/host-identity/supervisor.json"]);
    expect(container!.volumeMounts).toContainEqual({ name: "supervisor-secrets", mountPath: "/run/ezcorp/host-identity", subPath: "private", readOnly: true });
    expect(container!.volumeMounts).toContainEqual({ name: "readiness", mountPath: "/run/ezcorp/readiness/supervisor", subPath: "supervisor" });
    expect(JSON.stringify((container as unknown as { readinessProbe: unknown }).readinessProbe)).toContain("/run/ezcorp/readiness/supervisor/supervisor.json");
    expect(spec.volumes).toContainEqual({ name: "supervisor-secret-source", secret: { secretName: "factory-supervisor-host-identity", defaultMode: 0o400 } });
    expect(spec.volumes).toContainEqual({ name: "supervisor-secrets", emptyDir: { medium: "Memory", sizeLimit: "4Mi" } });
    const service = kind(system, "Service").find((object) => (object.metadata as { name: string }).name === "factory-supervisor")!;
    expect(service.spec).toEqual({ selector: { "app.kubernetes.io/name": "factory-supervisor" }, internalTrafficPolicy: "Local", ports: [{ name: "supervisor", port: 41_003, targetPort: 41_003 }] });
  });

  test("the runner root is the setting, at the same path on the node and in the pod, because guests resolve bind mounts by the node's path (W4H-35 C3)", () => {
    const spec = podSpec(kind(system, "DaemonSet")[0]!);
    // An operator-prepared directory (C12 prerequisites row): type Directory, so a missing one stops the pod by name instead of
    // the kubelet creating it root-owned (W4H-35 run 12).
    expect(spec.volumes).toContainEqual({ name: "runner-root", hostPath: { path: "/srv/ezcorp-runner", type: "Directory" } });
    expect(spec.containers[0]!.volumeMounts).toContainEqual({ name: "runner-root", mountPath: "/srv/ezcorp-runner" });
  });

  // Merge of W4H-34 (the /metrics ports, C11 M4) and W4H-35 (the supervisor's host-services port, its delivered config, HOME): the
  // pool and the supervisor each carry both ports, and the supervisor keeps its delivered config path and base environment.
  test("the pool and the supervisor carry their service port and their /metrics port, and the supervisor keeps its delivered config (merge W4H-34 x W4H-35)", () => {
    const pool = podSpec(kind(system, "Deployment")[0]!);
    expect(pool.containers[0]!.ports).toEqual([{ name: "pool", containerPort: bundle.host.ports.pool }, { name: "pool-metrics", containerPort: bundle.host.ports.poolMetrics }]);
    const supervisor = podSpec(kind(system, "DaemonSet")[0]!);
    expect(supervisor.containers[0]!.ports).toEqual([{ name: "supervisor", containerPort: bundle.host.ports.supervisor }, { name: "supervisor-metrics", containerPort: bundle.host.ports.supervisorMetrics }]);
    expect(supervisor.containers[0]!.command).toEqual(["bun", "src/factory/runner/supervisor-process.ts", "/run/ezcorp/host-identity/supervisor.json"]);
    expect(supervisor.containers[0]!.env).toContainEqual({ name: "HOME", value: "/tmp" });
  });

  test("each system workload has HOME on its own writable /tmp, because the image's user has no home (W4H-35 kind proof)", () => {
    const pool = podSpec(kind(system, "Deployment")[0]!);
    expect(pool.containers[0]!.env).toContainEqual({ name: "HOME", value: "/tmp" });
    expect(pool.containers[0]!.volumeMounts).toContainEqual({ name: "tmp", mountPath: "/tmp" });
    const supervisor = podSpec(kind(system, "DaemonSet")[0]!);
    expect(supervisor.containers[0]!.env).toEqual([{ name: "HOME", value: "/tmp" }, { name: "CONTAINER_HOST", value: `unix://${SETTINGS.runtimeSocketPath}` }]);
    expect(supervisor.containers[0]!.volumeMounts).toContainEqual({ name: "tmp", mountPath: "/tmp" });
    expect(supervisor.volumes).toContainEqual({ name: "tmp", emptyDir: { sizeLimit: "64Mi" } });
  });

  test("only the supervisor pod gets the runtime groups as supplementalGroups, and none without the setting (W4H-35 run 12)", () => {
    const groups = renderFactoryKubernetesSystem({ ...SETTINGS, runtimeGroups: [985, 990] }, bundle.image.reference, bundle.host.ports);
    const security = (stream: readonly FactoryKubernetesObject[], name: string) => (podSpec(kind(stream, name)[0]!) as PodSpec & { securityContext: Record<string, unknown> }).securityContext;
    expect(security(groups, "DaemonSet").supplementalGroups).toEqual([985, 990]);
    expect(security(groups, "Deployment").supplementalGroups).toBeUndefined();
    expect(security(system, "DaemonSet").supplementalGroups).toBeUndefined();
    expect(JSON.stringify(objects)).not.toContain("supplementalGroups");
  });

  test("nothing tenant-scoped is rendered into the system namespace", () => {
    const text = JSON.stringify(system);
    expect(text).not.toContain("tenant-01");
    expect(text).not.toContain(bundle.installation.installationId);
  });
});

describe("renderFactoryKubernetesIngress (C12 row \"Trusted ingress\")", () => {

  test("one pinned nginx in the system namespace, configured only from one Secret mounted read-only at the Compose path", () => {
    const objects = ingress();
    expect(objects.map((object) => object.kind)).toEqual(["Secret", "Deployment", "Service"]);
    for (const object of objects) expect((object.metadata as { namespace: string }).namespace).toBe("ezcorp-factory-system");
    const [secret, deployment, service] = objects;
    expect(secret!.data).toEqual(Object.fromEntries(Object.entries(files).map(([path, value]) => [path.replaceAll("/", "--"), Buffer.from(value).toString("base64")])));
    const pod = podSpec(deployment!);
    const [container] = pod.containers;
    expect(container!.image).toBe(NGINX);
    expect(container!.command).toEqual(["nginx", "-c", "/etc/ezcorp-ingress/nginx.conf", "-g", "daemon off;"]);
    expect(container!.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 10_001, readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } });
    expect(container!.volumeMounts).toEqual([{ name: "ingress", mountPath: "/etc/ezcorp-ingress", readOnly: true }, { name: "tmp", mountPath: "/tmp" }]);
    expect(pod.volumes[0]).toEqual({ name: "ingress", secret: { secretName: "factory-ingress", defaultMode: 0o400, items: Object.keys(files).sort().map((path) => ({ key: path.replaceAll("/", "--"), path })) } });
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(service!.spec).toEqual({ type: "NodePort", selector: { "app.kubernetes.io/name": "factory-ingress" }, ports: [{ name: "https", port: 8443, targetPort: 8443, nodePort: 30443 }] });
  });

  test("a new configuration rolls a new pod that must be ready before the serving one goes, so a bad configuration never replaces it", () => {
    const deployment = ingress()[1]!;
    const spec = deployment.spec as { strategy: unknown; template: { metadata: { annotations: Record<string, string> } } };
    expect(spec.strategy).toEqual({ type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } });
    const digest = spec.template.metadata.annotations["ezcorp.io/ingress-digest"];
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const changed = renderFactoryKubernetesIngress(SETTINGS, { image: NGINX, listenPort: 8443, nodePort: 30443, files: { ...files, "certs/tenant-01.crt": "rotated" } })[1]!;
    expect((changed.spec as typeof spec).template.metadata.annotations["ezcorp.io/ingress-digest"]).not.toBe(digest);
    const probe = (podSpec(deployment).containers[0] as unknown as { readinessProbe: unknown }).readinessProbe;
    expect(probe).toEqual({ tcpSocket: { port: 8443 }, periodSeconds: 2 });
  });

  test("refuses an unpinned image, a file outside the three ingress places, and a key that would collide", () => {
    expect(() => renderFactoryKubernetesIngress(SETTINGS, { image: "nginx:latest", listenPort: 8443, nodePort: 30443, files })).toThrow(expect.objectContaining({ code: "deployment_image_unpinned" }));
    for (const path of ["routes/tenant-01.json", "../nginx.conf", "conf/a/b.conf", "conf/--x.conf"]) {
      expect(() => renderFactoryKubernetesIngress(SETTINGS, { image: NGINX, listenPort: 8443, nodePort: 30443, files: { ...files, [path]: "x" } })).toThrow(expect.objectContaining({ code: "ingress_files_invalid" }));
    }
  });
});

describe("scoped secret delivery (C12 row \"Scoped secret delivery (hosted)\")", () => {
  /** Kubernetes' mode for a Secret or projected volume that names no `defaultMode`. */
  const KUBERNETES_DEFAULT_MODE = 0o644;
  interface SecretSource { defaultMode?: number; items?: { mode?: number }[]; sources?: { secret?: { items?: { mode?: number }[] } }[] }
  interface Pod { securityContext?: { fsGroup?: number; runAsUser?: number; runAsGroup?: number }; initContainers?: Container[]; containers: Container[]; volumes?: { name: string; secret?: SecretSource; projected?: SecretSource }[] }
  const positive = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
  const key = (object: FactoryKubernetesObject) => `${String(object.kind)}/${(object.metadata as { name: string }).name}`;

  /**
   * Every breach of the row in a rendered object stream, by workload, container and volume. A root-owned Secret file
   * is readable by a non-root container only through the pod's fsGroup, whatever its group bit, so every pod that
   * mounts one needs fsGroup equal to each reader's group; no mode may grant others; every container's user and
   * group are explicit (pod or container) and non-root.
   */
  function refusals(stream: readonly FactoryKubernetesObject[]): string[] {
    return stream.flatMap((object) => {
      const pod = (object.spec as { template?: { spec?: Pod } } | undefined)?.template?.spec;
      if (!pod) return [];
      const workload = key(object);
      const secrets = (pod.volumes ?? []).filter((volume) => volume.secret ?? volume.projected);
      const found: string[] = [];
      for (const volume of secrets) {
        const source = (volume.secret ?? volume.projected)!;
        const items = [...(source.items ?? []), ...(source.sources ?? []).flatMap((entry) => entry.secret?.items ?? [])];
        for (const mode of [source.defaultMode ?? KUBERNETES_DEFAULT_MODE, ...items.flatMap((item) => item.mode === undefined ? [] : [item.mode])]) {
          if ((mode & 0o007) !== 0) found.push(`${workload}: volume ${volume.name} mode 0${mode.toString(8)} is readable by others`);
        }
      }
      for (const container of [...(pod.initContainers ?? []), ...pod.containers]) {
        const own = container.securityContext as { runAsUser?: number; runAsGroup?: number } | undefined;
        const user = own?.runAsUser ?? pod.securityContext?.runAsUser;
        const group = own?.runAsGroup ?? pod.securityContext?.runAsGroup;
        const where = `${workload}/${container.name}`;
        if (!positive(user)) found.push(`${where}: no explicit non-root runAsUser`);
        if (!positive(group)) found.push(`${where}: no explicit non-root runAsGroup`);
        const reads = container.volumeMounts.some((mount) => secrets.some((volume) => volume.name === mount.name));
        if (reads && pod.securityContext?.fsGroup !== group) found.push(`${where}: reads a Secret volume, but the pod's fsGroup ${String(pod.securityContext?.fsGroup)} is not its group ${String(group)}`);
      }
      return found;
    });
  }

  const everyPodTemplate = () => [...objects, ...system, ...ingress()];
  /** A deep copy of the stream with one change to the pod template of one workload, named by kind and name. */
  const mutate = (workload: string, change: (pod: Pod) => void) => everyPodTemplate().map((object) => {
    const copy = structuredClone(object) as FactoryKubernetesObject;
    if (key(copy) === workload) change((copy.spec as { template: { spec: Pod } }).template.spec);
    return copy;
  });

  test("the invariant visits every rendered pod template: installation, pool, supervisor, and ingress", () => {
    expect(everyPodTemplate().filter((object) => (object.spec as { template?: unknown } | undefined)?.template !== undefined).map(key))
      .toEqual(["Deployment/installation", "Deployment/factory-pool", "DaemonSet/factory-supervisor", "Deployment/factory-ingress"]);
  });

  test("every rendered pod template keeps its Secrets private and readable by its own non-root readers", () => {
    expect(refusals(everyPodTemplate())).toEqual([]);
  });

  test("the invariant refuses a pod without fsGroup, a mode readable by others, and a container left to the image's user", () => {
    expect(refusals(mutate("Deployment/installation", (pod) => { delete pod.securityContext!.fsGroup; }))).toContain("Deployment/installation/deliver-secrets: reads a Secret volume, but the pod's fsGroup undefined is not its group 10001");
    expect(refusals(mutate("Deployment/factory-ingress", (pod) => { pod.volumes![0]!.secret!.defaultMode = 0o444; }))).toEqual(["Deployment/factory-ingress: volume ingress mode 0444 is readable by others"]);
    expect(refusals(mutate("Deployment/factory-ingress", (pod) => { delete pod.volumes![0]!.secret!.defaultMode; }))).toEqual(["Deployment/factory-ingress: volume ingress mode 0644 is readable by others"]);
    expect(refusals(mutate("DaemonSet/factory-supervisor", (pod) => { delete pod.securityContext; }))).toEqual([
      "DaemonSet/factory-supervisor/deliver-secrets: reads a Secret volume, but the pod's fsGroup undefined is not its group 10001",
      "DaemonSet/factory-supervisor/supervisor: no explicit non-root runAsUser",
      "DaemonSet/factory-supervisor/supervisor: no explicit non-root runAsGroup",
    ]);
    expect(refusals(mutate("Deployment/factory-pool", (pod) => { pod.containers[0]!.securityContext.runAsUser = 0; }))).toContain("Deployment/factory-pool/pool: no explicit non-root runAsUser");
  });
});

describe("private paths of the installation pod (C12 row \"Private paths of a hosted container (hosted)\", kind proof run 11)", () => {
  /** The product's private roots: the delivered secrets and the readiness records (the supervisor's live under them too). */
  const ROOTS = [FACTORY_CONTAINER_PATHS.secrets, FACTORY_CONTAINER_PATHS.readiness, FACTORY_KUBERNETES_SUPERVISOR_PATHS.secrets, FACTORY_KUBERNETES_SUPERVISOR_PATHS.readinessDirectory];
  let hosted: FactoryInstallationBundle;
  beforeAll(async () => {
    const base = makeFactoryTestDeploymentSettings(join(root, "runtime"));
    const hostAddresses = { pool: "https://factory-pool.ezcorp-factory-system.svc.cluster.local:41002", supervisor: "https://factory-supervisor.ezcorp-factory-system.svc.cluster.local:41003" };
    hosted = await renderFactoryInstallationBundle(bundle.installation, { ...base, network: { ...base.network, hostAddresses } });
  });
  /** Every private path each container's OWN delivery documents and environment name (the command arguments are added by the judge). */
  const uses = (rendered: FactoryInstallationBundle): Record<string, PrivatePathUse[]> => Object.fromEntries(FACTORY_CONTAINER_SERVICES.map((service) => [service, [
    ...Object.values(rendered.deliveries[service].files).flatMap((entry) => "document" in entry ? privatePathUses(entry.document, ROOTS) : []),
    ...privatePathUses(rendered.environment[service], ROOTS),
  ]]));

  test("every path a container reads or writes privately is reached through an owned private directory on its rendered mounts", async () => {
    const lines = await judgePrivatePaths(podTemplate(renderFactoryKubernetesInstallation(hosted, SETTINGS), "Deployment", "installation"), uses(hosted), ROOTS, process.getuid!());
    expect(lines.filter((line) => !line.endsWith(": ok"))).toEqual([]);
    // The readiness record is judged as the orchestrator's write and the harness's read, and the secrets as reads.
    expect(lines).toContain("orchestrator w /run/ezcorp/readiness/orchestration/orchestration.json: ok");
    expect(lines).toContain("harness r /run/ezcorp/readiness/orchestration/orchestration.json: ok");
    expect(lines).toContain("harness r /run/ezcorp/secrets/factory-startup.json: ok");
    expect(lines.length).toBeGreaterThan(40);
  });

  test("the judge refuses a writer whose readiness directory the init step did not prepare, and a path no mount covers", async () => {
    const pod = structuredClone(podTemplate(renderFactoryKubernetesInstallation(hosted, SETTINGS), "Deployment", "installation")) as unknown as { initContainers: { command: string[] }[]; containers: { name: string; volumeMounts: { name: string; mountPath: string; subPath?: string }[] }[] };
    const unprepared = structuredClone(pod);
    unprepared.initContainers[0]!.command[2] = unprepared.initContainers[0]!.command[2]!.replaceAll(/ && mkdir -p -m 0700 \/delivered\/readiness\/[a-z]+/g, "");
    expect(await judgePrivatePaths(unprepared as never, uses(hosted), ROOTS, process.getuid!())).toContain("orchestrator w /run/ezcorp/readiness/orchestration/orchestration.json: Private path has no owned directory.");
    const unmounted = structuredClone(pod);
    const harness = unmounted.containers.find((container) => container.name === "harness")!;
    harness.volumeMounts = harness.volumeMounts.filter((mount) => mount.name !== "readiness");
    expect(await judgePrivatePaths(unmounted as never, uses(hosted), ROOTS, process.getuid!())).toContain("harness r /run/ezcorp/readiness/orchestration/orchestration.json: no mount covers it");
  });
});

describe("image pins (deployment locks)", () => {
  test("every rendered workload names only digest-pinned images", () => {
    expect(factoryKubernetesImages([...objects, ...system]).every((image) => /^[^@\s]+@sha256:[a-f0-9]{64}$/.test(image))).toBe(true);
    expect(new Set(factoryKubernetesImages(objects))).toEqual(new Set([bundle.image.reference]));
  });

  test("the renderer refuses an unpinned image instead of returning objects", () => {
    for (const image of ["registry.test/ezcorp:latest", "registry.test/ezcorp@sha256:short", ""]) {
      expect(() => renderFactoryKubernetesSystem(SETTINGS, image, { pool: 41_002, supervisor: 41_003, poolMetrics: 41_004, supervisorMetrics: 41_005 })).toThrow(expect.objectContaining({ code: "deployment_image_unpinned" }));
      expect(() => renderFactoryKubernetesInstallation({ ...bundle, image: { ...bundle.image, reference: image } }, SETTINGS)).toThrow(expect.objectContaining({ code: "deployment_image_unpinned" }));
    }
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

describe("the hosted evaluator's objects (C11, W4H-34)", () => {
  test("each tenant container names its /metrics port, and only the monitoring namespace may reach those ports", () => {
    const pod = podSpec(kind(objects, "Deployment")[0]!) as unknown as { containers: Array<{ name: string; ports?: Array<{ name: string; containerPort: number }> }> };
    const metricsPort = (name: string) => pod.containers.find((container) => container.name === name)!.ports!.find((port) => port.name.endsWith("-metrics"))!;
    expect(metricsPort("harness")).toEqual({ name: "harness-metrics", containerPort: bundle.ports.harnessMetrics });
    expect(metricsPort("gateway")).toEqual({ name: "gateway-metrics", containerPort: bundle.ports.gatewayMetrics });
    expect(metricsPort("orchestrator")).toEqual({ name: "orch-metrics", containerPort: bundle.ports.orchestratorMetrics });
    const policy = kind(objects, "NetworkPolicy").find((object) => (object.metadata as { name: string }).name === "installation")!;
    const rule = (policy.spec as { ingress: Array<{ from: Array<{ namespaceSelector: { matchLabels: Record<string, string> } }>; ports: Array<{ port: number }> }> }).ingress
      .find((entry) => entry.from[0]!.namespaceSelector.matchLabels["kubernetes.io/metadata.name"] === "monitoring")!;
    expect(rule.ports.map((port) => port.port)).toEqual([bundle.ports.gatewayMetrics, bundle.ports.harnessMetrics, bundle.ports.orchestratorMetrics]);
  });

  test("a PodMonitor scrapes the three tenant processes with the scrape-token Secret, under the jobs the rules watch", () => {
    const [monitor] = kind(objects, "PodMonitor");
    expect(monitor).toMatchObject({ apiVersion: "monitoring.coreos.com/v1", metadata: { name: "installation", namespace: factoryKubernetesNamespace(bundle) } });
    const endpoints = (monitor!.spec as { podMetricsEndpoints: Array<{ port: string; path: string; bearerTokenSecret: unknown; relabelings: Array<{ targetLabel: string; replacement: string }> }> }).podMetricsEndpoints;
    expect(endpoints.map((endpoint) => [endpoint.port, endpoint.relabelings.find((label) => label.targetLabel === "job")!.replacement])).toEqual([
      ["gateway-metrics", "factory-gateway"], ["harness-metrics", "factory-harness"], ["orch-metrics", "factory-orchestrator"],
    ]);
    for (const endpoint of endpoints) {
      expect(endpoint.path).toBe("/metrics");
      expect(endpoint.bearerTokenSecret).toEqual({ name: "factory-metrics-scrape", key: "token" });
      expect(endpoint.relabelings).toContainEqual({ targetLabel: "tenant", replacement: bundle.installation.tenantId });
    }
    // The token arrives as a Secret created from the fleet's file, never inside a manifest.
    expect(kind(objects, "Secret").find((object) => (object.metadata as { name: string }).name === "factory-metrics-scrape")).toEqual({ apiVersion: "v1", kind: "Secret", metadata: expect.objectContaining({ name: "factory-metrics-scrape" }), type: "Opaque" });
  });

  test("the system namespace carries the C11 rules and scrapes the shared pool", () => {
    const [rules] = kind(system, "PrometheusRule");
    expect(rules).toEqual(factoryPrometheusRuleResource(SETTINGS.systemNamespace, { "app.kubernetes.io/part-of": "ezcorp-factory", "ezcorp.io/fleet": "fleet-a" }) as never);
    const pool = podSpec(kind(system, "Deployment")[0]!) as unknown as { containers: Array<{ ports: Array<{ name: string; containerPort: number }> }> };
    expect(pool.containers[0]!.ports).toContainEqual({ name: "pool-metrics", containerPort: bundle.host.ports.poolMetrics });
    const [monitor] = kind(system, "PodMonitor");
    const endpoint = (monitor!.spec as { podMetricsEndpoints: Array<{ port: string; bearerTokenSecret: unknown; relabelings: Array<{ targetLabel: string; replacement: string }> }> }).podMetricsEndpoints[0]!;
    expect([endpoint.port, endpoint.relabelings.find((label) => label.targetLabel === "job")!.replacement]).toEqual(["pool-metrics", "factory-pool"]);
    expect(kind(system, "Secret").map((object) => (object.metadata as { name: string }).name)).toContain("factory-metrics-scrape");
  });

  test("every factory service has exactly one scrape job, the supervisor included (F3)", () => {
    const jobs = [...kind(objects, "PodMonitor"), ...kind(system, "PodMonitor")].flatMap((monitor) => (monitor.spec as { podMetricsEndpoints: Array<{ relabelings: Array<{ targetLabel: string; replacement: string }> }> }).podMetricsEndpoints
      .map((endpoint) => endpoint.relabelings.find((label) => label.targetLabel === "job")!.replacement));
    expect(jobs.sort()).toEqual([...FACTORY_PROMETHEUS_JOBS].sort());
    const supervisor = kind(system, "PodMonitor").find((monitor) => (monitor.metadata as { name: string }).name === "factory-supervisor")!;
    expect((supervisor.spec as { selector: unknown }).selector).toEqual({ matchLabels: { "app.kubernetes.io/name": "factory-supervisor" } });
    const daemon = podSpec(kind(system, "DaemonSet")[0]!) as unknown as { containers: Array<{ ports?: Array<{ name: string; containerPort: number }> }> };
    expect(daemon.containers[0]!.ports).toContainEqual({ name: "supervisor-metrics", containerPort: bundle.host.ports.supervisorMetrics });
  });
});
