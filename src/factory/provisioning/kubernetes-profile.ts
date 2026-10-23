/**
 * The hosted deployment profile: Kubernetes objects rendered from the same
 * installation bundle the Compose profile runs. `kubernetes-target.ts` applies
 * them (C12 row "Kubernetes deployment target"); what is proven where is in
 * docs/factory-deployment.md and tasks/factory/w4h-35-GATES.md.
 *
 * Layout, one namespace per installation (C01's one installation per tenant):
 *
 *   - The three tenant processes share ONE pod. The product reads its
 *     orchestrator's readiness from a file (`service-probes.ts`), so they must
 *     share a filesystem; an `emptyDir` is that filesystem, and it is the only
 *     thing they share. Each container mounts only its own copy of its own
 *     secrets.
 *   - The pool and the supervisor are the fleet host's, shared by every
 *     installation (coordinator ruling 2026-09-22): a Deployment and a
 *     DaemonSet in the fleet's system namespace. A tenant pod cannot mount the
 *     files they write, so it reads their readiness records from their own
 *     routes (`hostReadiness: network` in the startup document), the
 *     supervisor's through a node-local Service.
 *   - Secrets arrive as Kubernetes Secrets, one per service, created FROM the
 *     provisioner's delivery directories — never written into a manifest. A
 *     Secret volume is a tree of symbolic links owned by root, which the
 *     factory's private reader correctly refuses, so an init container copies
 *     each service's Secret into an owned 0700 directory of that service's own
 *     in-memory `emptyDir` as 0600 files owned by the pod's uid; the reader mounts
 *     only that directory.
 *   - The namespace enforces Pod Security `restricted`. The supervisor is a
 *     DaemonSet in the fleet's system namespace, the only namespace allowed
 *     `privileged`, and the only workload given the container runtime socket
 *     and the host identity.
 *   - The trusted ingress is the Compose platform's own nginx, in the system
 *     namespace (`renderFactoryKubernetesIngress`): it sets the installation
 *     and proof headers, and only its pods reach a harness.
 */
import { createHash } from "node:crypto";
import type { FactoryInstallationBundle } from "./deployment";
import { FACTORY_CONTAINER_PATHS, FACTORY_CONTAINER_SERVICES, FACTORY_HARNESS_DATA_DIRECTORIES, FACTORY_HOST_SERVICE_BASE_ENVIRONMENT } from "./deployment";
import { factoryComposeProject } from "./compose-profile";
import { FACTORY_KUBERNETES_SUPERVISOR_PATHS, FACTORY_KUBERNETES_SUPERVISOR_STATE, FACTORY_NODE_ADDRESS } from "./kubernetes-paths";
import { FactoryProvisioningError } from "./steps";
import { factoryImagePinned } from "./image-pin";
import { factoryPrometheusRuleResource } from "../observability/alert-rules";

export type FactoryKubernetesObject = Readonly<Record<string, unknown>>;

export interface FactoryKubernetesSettings {
  readonly fleetId: string;
  /** The fleet's own namespace: the shared pool, the supervisor DaemonSet, and the trusted ingress. */
  readonly systemNamespace: string;
  /** Destinations a tenant pod may reach: database, stores, Temporal. */
  readonly egressCidrs: readonly string[];
  readonly egressPorts: readonly number[];
  /** The uid every tenant container runs as and owns its copied secrets under. */
  readonly runAsUser: number;
  readonly runtimeSocketPath: string;
  /**
   * The supervisor's runner root. Its guests run on the node's container
   * runtime, which resolves bind mounts by the node's own path, so the
   * DaemonSet mounts it at the same path in the pod.
   */
  readonly runnerRoot: string;
  /**
   * The nodes' addresses. The supervisor runs on the host network, so its
   * traffic to a guest-broker route, and a pod's traffic to it, carry node
   * addresses that no namespace selector matches.
   */
  readonly nodeCidrs: readonly string[];
  readonly nodeSelector: Readonly<Record<string, string>>;
  /** The node runtime socket's group, the supervisor pod's supplementalGroups (C12 prerequisites row); absent, none. */
  readonly runtimeGroups?: readonly number[];
  /** Namespace of the platform's Prometheus, the only source allowed to reach a `/metrics` port (C11). */
  readonly monitoringNamespace?: string;
}

const LIMITS: Readonly<Record<(typeof FACTORY_CONTAINER_SERVICES)[number], { readonly memory: string; readonly cpu: string }>> = Object.freeze({
  gateway: { memory: "384Mi", cpu: "500m" },
  harness: { memory: "1536Mi", cpu: "1000m" },
  orchestrator: { memory: "512Mi", cpu: "500m" },
});

/** Each tenant container's entry command; the node-run ones are loaded under the pinned Node by scripts/factory-node-entries-registration.test.ts. */
export const FACTORY_CONTAINER_COMMANDS: Readonly<Record<(typeof FACTORY_CONTAINER_SERVICES)[number], readonly string[]>> = Object.freeze({
  gateway: ["bun", "src/factory/gateway-process.ts", `${FACTORY_CONTAINER_PATHS.secrets}/gateway.json`],
  harness: ["bun", "src/factory/provisioning/secret-env.ts", `${FACTORY_CONTAINER_PATHS.secrets}/secret-env.json`, "--", "bun", "web/build/index.js"],
  orchestrator: ["node", "src/factory/orchestration-process.ts", `${FACTORY_CONTAINER_PATHS.secrets}/orchestrator.json`],
});

export function factoryKubernetesNamespace(bundle: Pick<FactoryInstallationBundle, "installation">): string {
  return factoryComposeProject(bundle.installation);
}

export function factoryKubernetesSecretName(service: string): string { return `factory-${service}-secrets`; }

function labels(bundle: FactoryInstallationBundle): Readonly<Record<string, string>> {
  return { "app.kubernetes.io/part-of": "ezcorp-factory", "ezcorp.io/fleet": bundle.installation.fleetId, "ezcorp.io/tenant": bundle.installation.tenantId, "ezcorp.io/installation": bundle.installation.installationId };
}

/** The readiness directory a writing service owns, matching the Compose profile's per-writer mounts. */
const ORCHESTRATION = "orchestration";

const restrictedContainer = (runAsUser: number) => ({
  runAsNonRoot: true, runAsUser, runAsGroup: runAsUser, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" },
});

/**
 * A pod's own non-root user and group (C12 row "Scoped secret delivery (hosted)"). Kubernetes owns a Secret volume's
 * files by root; `fsGroup` makes the kubelet present them as root:group 0440, the only way a non-root reader reads them.
 */
const restrictedPod = (runAsUser: number) => ({ runAsNonRoot: true, runAsUser, runAsGroup: runAsUser, fsGroup: runAsUser, seccompProfile: { type: "RuntimeDefault" } });

/**
 * A private directory of a hosted container (C12 row "Private paths of a hosted container (hosted)"). The factory's private
 * reader and writer need a directory on the path owned by the process, and the kubelet owns an emptyDir's root (and any subPath
 * it makes itself), so the deliver-secrets init container prepares each one as `subPath` of its emptyDir: owned by runAsUser,
 * 0700, optionally filled with 0600 copies of a service's Secret files. The container mounts only that directory.
 */
interface PrivateDirectory { readonly volume: string; readonly subPath: string; readonly copyOf?: string }
/** A service's Secret volume, which only the init container mounts. */
const secretSource = (service: string) => `${service}-secret-source`;
/** A service's delivered copy of its Secret. */
const delivered = (service: string): PrivateDirectory => ({ volume: `${service}-secrets`, subPath: "private", copyOf: service });
/** A readiness writer's own directory on the pod's readiness emptyDir. */
const readinessOf = (writer: string): PrivateDirectory => ({ volume: "readiness", subPath: writer });

/** A container's mount of one private directory. */
const privateMount = (directory: PrivateDirectory, mountPath: string, readOnly: boolean) => ({ name: directory.volume, mountPath, subPath: directory.subPath, ...(readOnly ? { readOnly: true } : {}) });

/** The pod's deliver-secrets init container: it alone sees the Secret sources, and it prepares every private directory of the pod. */
function deliverSecrets(directories: readonly PrivateDirectory[], image: string, runAsUser: number) {
  const step = ({ volume, subPath, copyOf }: PrivateDirectory) => {
    const target = `/delivered/${volume}/${subPath}`;
    return [`mkdir -p -m 0700 ${target}`, ...(copyOf === undefined ? [] : [`cp -L /source/${copyOf}/* ${target}/`, `chmod 0600 ${target}/*`])].join(" && ");
  };
  return {
    name: "deliver-secrets", image, imagePullPolicy: "IfNotPresent", command: ["sh", "-ec", `umask 077 && ${directories.map(step).join(" && ")}`],
    securityContext: restrictedContainer(runAsUser),
    resources: { requests: { memory: "32Mi", cpu: "50m" }, limits: { memory: "64Mi", cpu: "100m" } },
    volumeMounts: [
      ...directories.flatMap(({ copyOf }) => (copyOf === undefined ? [] : [{ name: secretSource(copyOf), mountPath: `/source/${copyOf}`, readOnly: true }])),
      ...[...new Set(directories.map(({ volume }) => volume))].map((volume) => ({ name: volume, mountPath: `/delivered/${volume}` })),
    ],
  };
}

/** A container's `env` list from an environment record, in its order. */
function environment(values: Readonly<Record<string, string>>): { name: string; value: string }[] {
  return Object.entries(values).map(([name, value]) => ({ name, value }));
}

/** Every image a rendered object stream runs: the containers and init containers of each workload's pod template. */
export function factoryKubernetesImages(objects: readonly FactoryKubernetesObject[]): readonly string[] {
  return objects.flatMap((object) => {
    const pod = (object.spec as { template?: { spec?: { containers?: { image: string }[]; initContainers?: { image: string }[] } } } | undefined)?.template?.spec;
    return [...(pod?.initContainers ?? []), ...(pod?.containers ?? [])].map((container) => container.image);
  });
}

/** The deployment-lock rule at render time: a stream with any image not pinned by digest is never returned. */
function pinned(objects: readonly FactoryKubernetesObject[]): readonly FactoryKubernetesObject[] {
  const unpinned = factoryKubernetesImages(objects).filter((image) => !factoryImagePinned(image));
  if (unpinned.length > 0) throw new FactoryProvisioningError("deployment_image_unpinned", `Every Kubernetes image must be pinned by digest; refused: ${[...new Set(unpinned)].join(", ") || "(empty)"}.`);
  return objects;
}

/** The Secret every PodMonitor reads the fleet's scrape token from; created from the host's token file, like every Secret here. */
export const FACTORY_KUBERNETES_METRICS_SECRET = "factory-metrics-scrape";

/**
 * One scrape endpoint for the platform's Prometheus operator: the named port,
 * the scrape token from its Secret, and the job label the C11 rules watch.
 */
function metricsEndpoint(port: string, service: string, tenant?: string): Record<string, unknown> {
  return {
    port, path: "/metrics", scheme: "http",
    bearerTokenSecret: { name: FACTORY_KUBERNETES_METRICS_SECRET, key: "token" },
    relabelings: [{ targetLabel: "job", replacement: `factory-${service}` }, ...(tenant === undefined ? [] : [{ targetLabel: "tenant", replacement: tenant }])],
  };
}

/** Each tenant process's `/metrics` port name; at most 15 characters, as a container port name must be. */
const METRICS_PORT_NAMES = Object.freeze({ harness: "harness-metrics", gateway: "gateway-metrics", orchestrator: "orch-metrics" } as const);

/** Every object one installation needs, in apply order. No Secret carries data: they are created from files. */
export function renderFactoryKubernetesInstallation(bundle: FactoryInstallationBundle, settings: FactoryKubernetesSettings): readonly FactoryKubernetesObject[] {
  const namespace = factoryKubernetesNamespace(bundle);
  const metricsPorts = { harness: bundle.ports.harnessMetrics, gateway: bundle.ports.gatewayMetrics, orchestrator: bundle.ports.orchestratorMetrics } as const;
  const metadata = (name: string) => ({ name, namespace, labels: labels(bundle) });
  const image = bundle.image.reference;
  const containers = FACTORY_CONTAINER_SERVICES.map((service) => ({
    name: service,
    image,
    imagePullPolicy: "IfNotPresent",
    command: [...FACTORY_CONTAINER_COMMANDS[service]],
    // The harness checks host, installation header, and ingress proof in both profiles (C12 row "Trusted
    // ingress"); the proof file arrives with the harness's Secret, and only the fleet's ingress sets the header.
    env: environment(bundle.environment[service]),
    securityContext: restrictedContainer(settings.runAsUser),
    resources: { requests: { memory: LIMITS[service].memory, cpu: LIMITS[service].cpu }, limits: { memory: LIMITS[service].memory, cpu: LIMITS[service].cpu } },
    volumeMounts: [
      privateMount(delivered(service), FACTORY_CONTAINER_PATHS.secrets, true),
      // Each readiness writer mounts only its own subdirectory, so it cannot forge another's record; readers see all of it read-only.
      service === "orchestrator"
        ? privateMount(readinessOf(ORCHESTRATION), `${FACTORY_CONTAINER_PATHS.readiness}/${ORCHESTRATION}`, false)
        : { name: "readiness", mountPath: FACTORY_CONTAINER_PATHS.readiness, readOnly: true },
      { name: "tmp", mountPath: "/tmp" },
      ...(service === "harness" ? [{ name: "harness-data", mountPath: FACTORY_CONTAINER_PATHS.data }, { name: "harness-data", mountPath: "/app/.ezcorp", subPath: "app-state" }] : []),
    ],
    ...(service === "harness" ? {
      ports: [{ name: "http", containerPort: bundle.ports.harness }, { name: "guest-broker", containerPort: bundle.ports.guestBroker }, { name: METRICS_PORT_NAMES.harness, containerPort: metricsPorts.harness }],
      readinessProbe: { httpGet: { path: "/api/ready", port: bundle.ports.harness }, periodSeconds: 5, failureThreshold: 3 },
      livenessProbe: { httpGet: { path: "/api/health", port: bundle.ports.harness }, periodSeconds: 10, failureThreshold: 6, initialDelaySeconds: 30 },
    } : {
      ports: [{ name: METRICS_PORT_NAMES[service], containerPort: metricsPorts[service] }],
      readinessProbe: { exec: { command: service === "gateway" ? ["bun", "src/factory/provisioning/readiness-check.ts", "--tcp", `127.0.0.1:${bundle.ports.gateway}`] : ["bun", "src/factory/provisioning/readiness-check.ts", `${FACTORY_CONTAINER_PATHS.readiness}/${ORCHESTRATION}/${ORCHESTRATION}.json`] }, periodSeconds: 5 },
    }),
  }));
  return pinned(Object.freeze([
    { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace, labels: { ...labels(bundle), "pod-security.kubernetes.io/enforce": "restricted", "pod-security.kubernetes.io/enforce-version": "latest" } } },
    { apiVersion: "v1", kind: "ServiceAccount", metadata: metadata("installation"), automountServiceAccountToken: false },
    { apiVersion: "v1", kind: "ResourceQuota", metadata: metadata("installation"), spec: { hard: { "limits.memory": "3Gi", "limits.cpu": "3", pods: "4", "requests.storage": "10Gi" } } },
    ...FACTORY_CONTAINER_SERVICES.map((service) => ({ apiVersion: "v1", kind: "Secret", metadata: metadata(factoryKubernetesSecretName(service)), type: "Opaque" })),
    ...(settings.monitoringNamespace === undefined ? [] : [{ apiVersion: "v1", kind: "Secret", metadata: metadata(FACTORY_KUBERNETES_METRICS_SECRET), type: "Opaque" }]),
    { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: metadata("harness-data"), spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "5Gi" } } } },
    {
      apiVersion: "apps/v1", kind: "Deployment", metadata: metadata("installation"),
      spec: {
        replicas: 1, strategy: { type: "Recreate" },
        selector: { matchLabels: { "ezcorp.io/installation": bundle.installation.installationId } },
        template: {
          metadata: { labels: labels(bundle) },
          spec: {
            serviceAccountName: "installation", automountServiceAccountToken: false, enableServiceLinks: false,
            // Above the harness's 25 s shutdown hard timeout, so it drains and closes its database before SIGKILL.
            terminationGracePeriodSeconds: 30,
            securityContext: restrictedPod(settings.runAsUser),
            // The harness data directories (one list with Compose): a new harness-data claim holds none, and the harness's boot
            // refuses an unresolvable project root or HOME (boot.ts isWithin fails closed).
            initContainers: [deliverSecrets([...FACTORY_CONTAINER_SERVICES.map(delivered), readinessOf(ORCHESTRATION), ...FACTORY_HARNESS_DATA_DIRECTORIES.map((subPath) => ({ volume: "harness-data", subPath }))], image, settings.runAsUser)],
            containers,
            volumes: [
              ...FACTORY_CONTAINER_SERVICES.flatMap((service) => [
                { name: secretSource(service), secret: { secretName: factoryKubernetesSecretName(service), defaultMode: 0o400 } },
                { name: delivered(service).volume, emptyDir: { medium: "Memory", sizeLimit: "4Mi" } },
              ]),
              { name: "readiness", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
              { name: "tmp", emptyDir: { sizeLimit: "256Mi" } },
              { name: "harness-data", persistentVolumeClaim: { claimName: "harness-data" } },
            ],
          },
        },
      },
    },
    { apiVersion: "v1", kind: "Service", metadata: metadata("harness"), spec: { selector: { "ezcorp.io/installation": bundle.installation.installationId }, ports: [{ name: "http", port: 80, targetPort: bundle.ports.harness }, { name: "guest-broker", port: bundle.ports.guestBroker, targetPort: bundle.ports.guestBroker }] } },
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: metadata("default-deny"), spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] } },
    {
      apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: metadata("installation"),
      spec: {
        podSelector: { matchLabels: { "ezcorp.io/installation": bundle.installation.installationId } }, policyTypes: ["Ingress", "Egress"],
        ingress: [
          // Only the fleet's own ingress pods, which overwrite the installation header and set the proof.
          { from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": settings.systemNamespace } }, podSelector: { matchLabels: { "app.kubernetes.io/name": FACTORY_KUBERNETES_INGRESS } } }], ports: [{ protocol: "TCP", port: bundle.ports.harness }] },
          // W01g's guest-broker route: only the fleet host's supervisor, in the system namespace, reaches it.
          { from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": settings.systemNamespace } } }], ports: [{ protocol: "TCP", port: bundle.ports.guestBroker }] },
          // C11 M4: only the platform's Prometheus reaches /metrics, and each port answers only the scrape token; no monitoring, no rule.
          ...(settings.monitoringNamespace === undefined ? [] : [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": settings.monitoringNamespace } } }], ports: FACTORY_CONTAINER_SERVICES.map((service) => ({ protocol: "TCP", port: metricsPorts[service] })) }]),
          // The same route from the supervisor on the host network. No addresses, no rule: an empty peer list admits everything.
          ...(settings.nodeCidrs.length === 0 ? [] : [{ from: settings.nodeCidrs.map((cidr) => ({ ipBlock: { cidr } })), ports: [{ protocol: "TCP", port: bundle.ports.guestBroker }] }]),
        ],
        egress: [
          { to: [{ namespaceSelector: {}, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
          { to: settings.egressCidrs.map((cidr) => ({ ipBlock: { cidr } })), ports: settings.egressPorts.map((port) => ({ protocol: "TCP", port })) },
          // The fleet host's shared pool and supervisor, in the system namespace.
          { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": settings.systemNamespace } } }], ports: [{ protocol: "TCP", port: bundle.host.ports.pool }, { protocol: "TCP", port: bundle.host.ports.supervisor }] },
          // The node-local supervisor Service resolves to the node's own address.
          ...(settings.nodeCidrs.length === 0 ? [] : [{ to: settings.nodeCidrs.map((cidr) => ({ ipBlock: { cidr } })), ports: [{ protocol: "TCP", port: bundle.host.ports.supervisor }] }]),
        ],
      },
    },
    ...(settings.monitoringNamespace === undefined ? [] : [{
      apiVersion: "monitoring.coreos.com/v1", kind: "PodMonitor", metadata: metadata("installation"),
      spec: {
        selector: { matchLabels: { "ezcorp.io/installation": bundle.installation.installationId } },
        podMetricsEndpoints: FACTORY_CONTAINER_SERVICES.map((service) => metricsEndpoint(METRICS_PORT_NAMES[service], service, bundle.installation.tenantId)),
      },
    }]),
  ]));
}

/** The fleet's system namespace: the shared pool, the supervisor DaemonSet, and nothing tenant-scoped. */
export function renderFactoryKubernetesSystem(settings: FactoryKubernetesSettings, image: string, ports: { readonly pool: number; readonly supervisor: number; readonly poolMetrics: number; readonly supervisorMetrics: number }): readonly FactoryKubernetesObject[] {
  const namespace = settings.systemNamespace;
  const poolPort = ports.pool;
  const monitored = settings.monitoringNamespace !== undefined;
  const common = { "app.kubernetes.io/part-of": "ezcorp-factory", "ezcorp.io/fleet": settings.fleetId };
  return pinned(Object.freeze([
    { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace, labels: { ...common, "pod-security.kubernetes.io/enforce": "privileged" } } },
    { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "factory-supervisor", namespace, labels: common }, automountServiceAccountToken: false },
    { apiVersion: "v1", kind: "Secret", metadata: { name: "factory-supervisor-host-identity", namespace, labels: common }, type: "Opaque" },
    // The shared pool: restricted like any tenant workload, its delivery copied from its Secret as in an installation pod.
    { apiVersion: "v1", kind: "Secret", metadata: { name: factoryKubernetesSecretName("pool"), namespace, labels: common }, type: "Opaque" },
    {
      apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "factory-pool", namespace, labels: common },
      spec: {
        replicas: 1, strategy: { type: "Recreate" },
        selector: { matchLabels: { "app.kubernetes.io/name": "factory-pool" } },
        template: {
          metadata: { labels: { ...common, "app.kubernetes.io/name": "factory-pool" } },
          spec: {
            automountServiceAccountToken: false, enableServiceLinks: false,
            securityContext: restrictedPod(settings.runAsUser),
            initContainers: [deliverSecrets([delivered("pool"), readinessOf("pool")], image, settings.runAsUser)],
            containers: [{
              name: "pool", image, imagePullPolicy: "IfNotPresent",
              command: ["bun", "src/factory/pool/process.ts", `${FACTORY_CONTAINER_PATHS.secrets}/pool.json`],
              env: environment(FACTORY_HOST_SERVICE_BASE_ENVIRONMENT.pool),
              securityContext: restrictedContainer(settings.runAsUser),
              resources: { requests: { memory: "512Mi", cpu: "500m" }, limits: { memory: "512Mi", cpu: "1" } },
              ports: [{ name: "pool", containerPort: poolPort }, { name: "pool-metrics", containerPort: ports.poolMetrics }],
              volumeMounts: [privateMount(delivered("pool"), FACTORY_CONTAINER_PATHS.secrets, true), privateMount(readinessOf("pool"), `${FACTORY_CONTAINER_PATHS.readiness}/pool`, false), { name: "tmp", mountPath: "/tmp" }],
              readinessProbe: { exec: { command: ["bun", "src/factory/provisioning/readiness-check.ts", `${FACTORY_CONTAINER_PATHS.readiness}/pool/pool.json`] }, periodSeconds: 5 },
            }],
            volumes: [
              { name: secretSource("pool"), secret: { secretName: factoryKubernetesSecretName("pool"), defaultMode: 0o400 } },
              { name: delivered("pool").volume, emptyDir: { medium: "Memory", sizeLimit: "4Mi" } },
              { name: "readiness", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
              { name: "tmp", emptyDir: { sizeLimit: "64Mi" } },
            ],
          },
        },
      },
    },
    { apiVersion: "v1", kind: "Service", metadata: { name: "factory-pool", namespace, labels: common }, spec: { selector: { "app.kubernetes.io/name": "factory-pool" }, ports: [{ name: "pool", port: poolPort, targetPort: poolPort }] } },
    // C11, only when the fleet names its monitoring namespace (C12 "Kubernetes deployment target"): the alert rules for the platform's
    // Prometheus operator, and the scrapes of the shared pool and the supervisor. The supervisor binds its /metrics on the node's own
    // address (status.hostIP), which closes W4H-34's gap hosted-supervisor-metrics-address.
    ...(monitored ? [
      factoryPrometheusRuleResource(namespace, common),
      { apiVersion: "v1", kind: "Secret", metadata: { name: FACTORY_KUBERNETES_METRICS_SECRET, namespace, labels: common }, type: "Opaque" },
      {
        apiVersion: "monitoring.coreos.com/v1", kind: "PodMonitor", metadata: { name: "factory-pool", namespace, labels: common },
        spec: { selector: { matchLabels: { "app.kubernetes.io/name": "factory-pool" } }, podMetricsEndpoints: [metricsEndpoint("pool-metrics", "pool")] },
      },
      {
        apiVersion: "monitoring.coreos.com/v1", kind: "PodMonitor", metadata: { name: "factory-supervisor", namespace, labels: common },
        spec: { selector: { matchLabels: { "app.kubernetes.io/name": "factory-supervisor" } }, podMetricsEndpoints: [metricsEndpoint("supervisor-metrics", "supervisor")] },
      },
    ] : []),
    {
      apiVersion: "apps/v1", kind: "DaemonSet", metadata: { name: "factory-supervisor", namespace, labels: common },
      spec: {
        selector: { matchLabels: { "app.kubernetes.io/name": "factory-supervisor" } },
        updateStrategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 1 } },
        template: {
          metadata: { labels: { ...common, "app.kubernetes.io/name": "factory-supervisor" } },
          spec: {
            // On the host network, and still resolving each installation's harness service for its guest-broker route.
            serviceAccountName: "factory-supervisor", automountServiceAccountToken: false, hostNetwork: true, dnsPolicy: "ClusterFirstWithHostNet", nodeSelector: { ...settings.nodeSelector },
            // The runtime groups reach the supervisor alone: the one workload that dials the node's container-runtime socket.
            securityContext: { ...restrictedPod(settings.runAsUser), ...(settings.runtimeGroups === undefined ? {} : { supplementalGroups: [...settings.runtimeGroups] }) },
            // A Secret volume is a tree of root-owned links the private reader refuses: copy it into private files first, as the pool does.
            initContainers: [deliverSecrets([delivered("supervisor"), readinessOf("supervisor"), { volume: "runner-root", subPath: FACTORY_KUBERNETES_SUPERVISOR_STATE }], image, settings.runAsUser)],
            containers: [{
              name: "supervisor", image, imagePullPolicy: "IfNotPresent",
              command: ["bun", "src/factory/runner/supervisor-process.ts", `${FACTORY_KUBERNETES_SUPERVISOR_PATHS.secrets}/supervisor.json`],
              env: [
                ...environment({ ...FACTORY_HOST_SERVICE_BASE_ENVIRONMENT.supervisor, CONTAINER_HOST: `unix://${settings.runtimeSocketPath}` }),
                ...(monitored ? [{ name: FACTORY_NODE_ADDRESS.env, valueFrom: { fieldRef: { fieldPath: "status.hostIP" } } }] : []),
              ],
              // The ONE privileged workload: it alone reaches the container runtime.
              securityContext: { privileged: true },
              resources: { requests: { memory: "256Mi", cpu: "250m" }, limits: { memory: "2Gi", cpu: "2" } },
              ports: [{ name: "supervisor", containerPort: ports.supervisor }, ...(monitored ? [{ name: "supervisor-metrics", containerPort: ports.supervisorMetrics }] : [])],
              readinessProbe: { exec: { command: ["bun", "src/factory/provisioning/readiness-check.ts", `${FACTORY_KUBERNETES_SUPERVISOR_PATHS.readinessDirectory}/supervisor.json`] }, periodSeconds: 5 },
              volumeMounts: [
                { name: "runtime-socket", mountPath: settings.runtimeSocketPath },
                { name: "runner-root", mountPath: settings.runnerRoot },
                privateMount(delivered("supervisor"), FACTORY_KUBERNETES_SUPERVISOR_PATHS.secrets, true),
                privateMount(readinessOf("supervisor"), FACTORY_KUBERNETES_SUPERVISOR_PATHS.readinessDirectory, false),
                { name: "tmp", mountPath: "/tmp" },
              ],
            }],
            volumes: [
              { name: "runtime-socket", hostPath: { path: settings.runtimeSocketPath } },   // no type check: the connection probe decides (C12 runtime row)
              // An operator-prepared directory owned by runAsUser (C12 prerequisites row): a missing one stops the pod by name.
              { name: "runner-root", hostPath: { path: settings.runnerRoot, type: "Directory" } },
              { name: secretSource("supervisor"), secret: { secretName: "factory-supervisor-host-identity", defaultMode: 0o400 } },
              { name: delivered("supervisor").volume, emptyDir: { medium: "Memory", sizeLimit: "4Mi" } },
              { name: "readiness", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
              { name: "tmp", emptyDir: { sizeLimit: "64Mi" } },
            ],
          },
        },
      },
    },
    // Node-local: each installation reaches the supervisor of the node its pod runs on (C12 row "Shared-service readiness and address").
    { apiVersion: "v1", kind: "Service", metadata: { name: "factory-supervisor", namespace, labels: common }, spec: { selector: { "app.kubernetes.io/name": "factory-supervisor" }, internalTrafficPolicy: "Local", ports: [{ name: "supervisor", port: ports.supervisor, targetPort: ports.supervisor }] } },
  ]));
}

export const FACTORY_KUBERNETES_INGRESS = "factory-ingress";
/** Where the Compose platform's ingress mounts its root; the hosted one mounts the same files there. */
const INGRESS_ROOT = "/etc/ezcorp-ingress";
/** The ingress files the nginx process reads: its main config, the rendered routes, and each hostname's certificate and key. */
const INGRESS_FILE = /^(?:nginx\.conf|conf\/[A-Za-z0-9._][A-Za-z0-9._-]{0,127}|certs\/[A-Za-z0-9._][A-Za-z0-9._-]{0,127})$/;

export interface FactoryKubernetesIngressSettings {
  /** The same pinned nginx the Compose platform runs (its digest is read from `platform.yml`). */
  readonly image: string;
  readonly listenPort: number;
  readonly nodePort: number;
  /** Relative path under the ingress root -> content: `nginx.conf`, `conf/*`, and `certs/*`. Route files are not the ingress's. */
  readonly files: Readonly<Record<string, string>>;
}

/**
 * The fleet's trusted ingress (C12 row "Trusted ingress"): the Compose
 * platform's nginx, with the same rendered configuration, in the system
 * namespace. It overwrites the installation header and sets the ingress proof
 * on every request, as the Compose ingress does; no annotation sets a header.
 * Every file it reads arrives in one Secret, mounted where the Compose ingress
 * mounts its root. A new configuration rolls a new pod that must be ready
 * before the serving one goes, so a configuration nginx refuses never replaces
 * the one that serves.
 */
export function renderFactoryKubernetesIngress(settings: FactoryKubernetesSettings, ingress: FactoryKubernetesIngressSettings): readonly FactoryKubernetesObject[] {
  const paths = Object.keys(ingress.files).sort();
  const key = (path: string) => path.replaceAll("/", "--");
  if (paths.some((path) => !INGRESS_FILE.test(path) || path.slice(path.indexOf("/") + 1).includes("--"))) throw new FactoryProvisioningError("ingress_files_invalid", "The hosted ingress reads only nginx.conf, conf/*, and certs/*.");
  const namespace = settings.systemNamespace;
  const labels = { "app.kubernetes.io/part-of": "ezcorp-factory", "ezcorp.io/fleet": settings.fleetId, "app.kubernetes.io/name": FACTORY_KUBERNETES_INGRESS };
  const data = Object.fromEntries(paths.map((path) => [key(path), Buffer.from(ingress.files[path]!).toString("base64")]));
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(data)).digest("hex")}`;
  return pinned(Object.freeze([
    { apiVersion: "v1", kind: "Secret", metadata: { name: FACTORY_KUBERNETES_INGRESS, namespace, labels }, type: "Opaque", data },
    {
      apiVersion: "apps/v1", kind: "Deployment", metadata: { name: FACTORY_KUBERNETES_INGRESS, namespace, labels },
      spec: {
        replicas: 1, strategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
        selector: { matchLabels: { "app.kubernetes.io/name": FACTORY_KUBERNETES_INGRESS } },
        template: {
          metadata: { labels, annotations: { "ezcorp.io/ingress-digest": digest } },
          spec: {
            automountServiceAccountToken: false, enableServiceLinks: false,
            securityContext: restrictedPod(settings.runAsUser),
            containers: [{
              name: "nginx", image: ingress.image, imagePullPolicy: "IfNotPresent",
              command: ["nginx", "-c", `${INGRESS_ROOT}/nginx.conf`, "-g", "daemon off;"],
              securityContext: restrictedContainer(settings.runAsUser),
              // The Compose ingress's own bounds (platform.yml).
              resources: { requests: { memory: "128Mi", cpu: "500m" }, limits: { memory: "128Mi", cpu: "500m" } },
              ports: [{ name: "https", containerPort: ingress.listenPort }],
              readinessProbe: { tcpSocket: { port: ingress.listenPort }, periodSeconds: 2 },
              volumeMounts: [{ name: "ingress", mountPath: INGRESS_ROOT, readOnly: true }, { name: "tmp", mountPath: "/tmp" }],
            }],
            volumes: [
              { name: "ingress", secret: { secretName: FACTORY_KUBERNETES_INGRESS, defaultMode: 0o400, items: paths.map((path) => ({ key: key(path), path })) } },
              { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
            ],
          },
        },
      },
    },
    { apiVersion: "v1", kind: "Service", metadata: { name: FACTORY_KUBERNETES_INGRESS, namespace, labels }, spec: { type: "NodePort", selector: { "app.kubernetes.io/name": FACTORY_KUBERNETES_INGRESS }, ports: [{ name: "https", port: ingress.listenPort, targetPort: ingress.listenPort, nodePort: ingress.nodePort }] } },
  ]));
}

/** YAML is a superset of JSON: one JSON document per `---` is a valid manifest stream. */
export function factoryKubernetesManifestStream(objects: readonly FactoryKubernetesObject[]): string {
  return objects.map((object) => JSON.stringify(object)).join("\n---\n").concat("\n");
}
