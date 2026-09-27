/**
 * The hosted deployment profile: Kubernetes manifests rendered from the same
 * installation bundle the Compose profile runs.
 *
 * What this profile PROVES on this host, and what it does not, is stated in
 * docs/factory-deployment.md and the W16 gate file: the manifests are
 * schema-validated and admitted by a real API server in a local kind cluster,
 * and the admission layer is shown to enforce the supervisor separation. The
 * installations do not reach ready there, because this host's shared stores
 * listen on host loopback, which a kind pod cannot reach. That is a property
 * of the local infrastructure and is not claimed as a hosted pass.
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
 *     DaemonSet in the fleet's system namespace.
 *   - Secrets arrive as Kubernetes Secrets, one per service, created FROM the
 *     provisioner's delivery directories — never written into a manifest. A
 *     Secret volume is a tree of symbolic links owned by root, which the
 *     factory's private reader correctly refuses, so an init container copies
 *     each service's Secret into that service's own in-memory `emptyDir` as
 *     0600 files owned by the pod's uid.
 *   - The namespace enforces Pod Security `restricted`. The supervisor is a
 *     DaemonSet in the fleet's system namespace, the only namespace allowed
 *     `privileged`, and the only workload given the container runtime socket
 *     and the host identity.
 *
 * Known gap, named rather than hidden: the product reads the shared POOL's and
 * SUPERVISOR's readiness from files too, and a pod in a tenant namespace cannot
 * mount a file another namespace writes. The hosted profile therefore needs a
 * network readiness probe for both (`hosted-supervisor-readiness` in the gate
 * file); these manifests do not paper over it.
 */
import type { FactoryInstallationBundle } from "./deployment";
import { FACTORY_CONTAINER_PATHS, FACTORY_CONTAINER_SERVICES } from "./deployment";
import { factoryComposeProject } from "./compose-profile";

export type FactoryKubernetesObject = Readonly<Record<string, unknown>>;

export interface FactoryKubernetesSettings {
  readonly fleetId: string;
  readonly systemNamespace: string;
  readonly ingressClassName: string;
  /** Namespace of the ingress controller, the only source allowed to reach a harness. */
  readonly ingressNamespace: string;
  /** Destinations a tenant pod may reach: database, stores, Temporal. */
  readonly egressCidrs: readonly string[];
  readonly egressPorts: readonly number[];
  /** The uid every tenant container runs as and owns its copied secrets under. */
  readonly runAsUser: number;
  readonly runtimeSocketPath: string;
  readonly nodeSelector: Readonly<Record<string, string>>;
}

const LIMITS: Readonly<Record<(typeof FACTORY_CONTAINER_SERVICES)[number], { readonly memory: string; readonly cpu: string }>> = Object.freeze({
  gateway: { memory: "384Mi", cpu: "500m" },
  harness: { memory: "1536Mi", cpu: "1000m" },
  orchestrator: { memory: "512Mi", cpu: "500m" },
});

const COMMANDS: Readonly<Record<(typeof FACTORY_CONTAINER_SERVICES)[number], readonly string[]>> = Object.freeze({
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

/** Every object one installation needs, in apply order. No Secret carries data: they are created from files. */
export function renderFactoryKubernetesInstallation(bundle: FactoryInstallationBundle, settings: FactoryKubernetesSettings): readonly FactoryKubernetesObject[] {
  const namespace = factoryKubernetesNamespace(bundle);
  const metadata = (name: string) => ({ name, namespace, labels: labels(bundle) });
  const image = bundle.image.reference;
  const sourceVolume = (service: string) => `${service}-secret-source`;
  const deliveredVolume = (service: string) => `${service}-secrets`;
  const containers = FACTORY_CONTAINER_SERVICES.map((service) => ({
    name: service,
    image,
    imagePullPolicy: "IfNotPresent",
    command: [...COMMANDS[service]],
    // The ingress proof is a Compose-profile control: on a shared host it stops a
    // local process that reaches the harness port from posing as the ingress.
    // Here the NetworkPolicy admits only the ingress controller, and an
    // annotation would publish the proof to anyone who can read the Ingress.
    env: Object.entries(bundle.environment[service]).filter(([name]) => name !== "EZCORP_INGRESS_PROOF_FILE").map(([name, value]) => ({ name, value })),
    securityContext: restrictedContainer(settings.runAsUser),
    resources: { requests: { memory: LIMITS[service].memory, cpu: LIMITS[service].cpu }, limits: { memory: LIMITS[service].memory, cpu: LIMITS[service].cpu } },
    volumeMounts: [
      { name: deliveredVolume(service), mountPath: FACTORY_CONTAINER_PATHS.secrets, readOnly: true },
      // Each readiness writer mounts only its own subdirectory, so it cannot forge another's record; readers see all of it read-only.
      service === "orchestrator"
        ? { name: "readiness", mountPath: `${FACTORY_CONTAINER_PATHS.readiness}/${ORCHESTRATION}`, subPath: ORCHESTRATION }
        : { name: "readiness", mountPath: FACTORY_CONTAINER_PATHS.readiness, readOnly: true },
      { name: "tmp", mountPath: "/tmp" },
      ...(service === "harness" ? [{ name: "harness-data", mountPath: FACTORY_CONTAINER_PATHS.data }, { name: "harness-data", mountPath: "/app/.ezcorp", subPath: "app-state" }] : []),
    ],
    ...(service === "harness" ? {
      ports: [{ name: "http", containerPort: bundle.ports.harness }, { name: "guest-broker", containerPort: bundle.ports.guestBroker }],
      readinessProbe: { httpGet: { path: "/api/ready", port: bundle.ports.harness }, periodSeconds: 5, failureThreshold: 3 },
      livenessProbe: { httpGet: { path: "/api/health", port: bundle.ports.harness }, periodSeconds: 10, failureThreshold: 6, initialDelaySeconds: 30 },
    } : {
      readinessProbe: { exec: { command: service === "gateway" ? ["bun", "src/factory/provisioning/readiness-check.ts", "--tcp", `127.0.0.1:${bundle.ports.gateway}`] : ["bun", "src/factory/provisioning/readiness-check.ts", `${FACTORY_CONTAINER_PATHS.readiness}/${ORCHESTRATION}/${ORCHESTRATION}.json`] }, periodSeconds: 5 },
    }),
  }));
  const copy = FACTORY_CONTAINER_SERVICES.map((service) => `cp -L /source/${service}/* /delivered/${service}/ && chmod 0600 /delivered/${service}/*`).join(" && ");
  return Object.freeze([
    { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace, labels: { ...labels(bundle), "pod-security.kubernetes.io/enforce": "restricted", "pod-security.kubernetes.io/enforce-version": "latest" } } },
    { apiVersion: "v1", kind: "ServiceAccount", metadata: metadata("installation"), automountServiceAccountToken: false },
    { apiVersion: "v1", kind: "ResourceQuota", metadata: metadata("installation"), spec: { hard: { "limits.memory": "3Gi", "limits.cpu": "3", pods: "4", "requests.storage": "10Gi" } } },
    ...FACTORY_CONTAINER_SERVICES.map((service) => ({ apiVersion: "v1", kind: "Secret", metadata: metadata(factoryKubernetesSecretName(service)), type: "Opaque" })),
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
            securityContext: { runAsNonRoot: true, runAsUser: settings.runAsUser, runAsGroup: settings.runAsUser, seccompProfile: { type: "RuntimeDefault" } },
            initContainers: [{
              name: "deliver-secrets", image, imagePullPolicy: "IfNotPresent", command: ["sh", "-ec", `umask 077 && ${copy}`],
              securityContext: restrictedContainer(settings.runAsUser),
              resources: { requests: { memory: "32Mi", cpu: "50m" }, limits: { memory: "64Mi", cpu: "100m" } },
              volumeMounts: FACTORY_CONTAINER_SERVICES.flatMap((service) => [{ name: sourceVolume(service), mountPath: `/source/${service}`, readOnly: true }, { name: deliveredVolume(service), mountPath: `/delivered/${service}` }]),
            }],
            containers,
            volumes: [
              ...FACTORY_CONTAINER_SERVICES.flatMap((service) => [
                { name: sourceVolume(service), secret: { secretName: factoryKubernetesSecretName(service), defaultMode: 0o400 } },
                { name: deliveredVolume(service), emptyDir: { medium: "Memory", sizeLimit: "4Mi" } },
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
    {
      apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: { ...metadata("installation"), annotations: { "nginx.ingress.kubernetes.io/configuration-snippet": `more_clear_input_headers "X-EZCorp-Installation"; proxy_set_header X-EZCorp-Installation "${bundle.installation.installationId}";` } },
      spec: { ingressClassName: settings.ingressClassName, tls: [{ hosts: [bundle.installation.hostname], secretName: "installation-tls" }], rules: [{ host: bundle.installation.hostname, http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "harness", port: { number: 80 } } } }] } }] },
    },
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: metadata("default-deny"), spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] } },
    {
      apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: metadata("installation"),
      spec: {
        podSelector: { matchLabels: { "ezcorp.io/installation": bundle.installation.installationId } }, policyTypes: ["Ingress", "Egress"],
        ingress: [
          { from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": settings.ingressNamespace } } }], ports: [{ protocol: "TCP", port: bundle.ports.harness }] },
          // W01g's guest-broker route: only the fleet host's supervisor, in the system namespace, reaches it.
          { from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": settings.systemNamespace } } }], ports: [{ protocol: "TCP", port: bundle.ports.guestBroker }] },
        ],
        egress: [
          { to: [{ namespaceSelector: {}, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
          { to: settings.egressCidrs.map((cidr) => ({ ipBlock: { cidr } })), ports: settings.egressPorts.map((port) => ({ protocol: "TCP", port })) },
          // The fleet host's shared pool and supervisor, in the system namespace.
          { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": settings.systemNamespace } } }], ports: [{ protocol: "TCP", port: bundle.host.ports.pool }, { protocol: "TCP", port: bundle.host.ports.supervisor }] },
        ],
      },
    },
  ]);
}

/** The fleet's system namespace: the shared pool, the supervisor DaemonSet, and nothing tenant-scoped. */
export function renderFactoryKubernetesSystem(settings: FactoryKubernetesSettings, image: string, poolPort: number): readonly FactoryKubernetesObject[] {
  const namespace = settings.systemNamespace;
  const common = { "app.kubernetes.io/part-of": "ezcorp-factory", "ezcorp.io/fleet": settings.fleetId };
  return Object.freeze([
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
            securityContext: { runAsNonRoot: true, runAsUser: settings.runAsUser, runAsGroup: settings.runAsUser, seccompProfile: { type: "RuntimeDefault" } },
            initContainers: [{
              name: "deliver-secrets", image, imagePullPolicy: "IfNotPresent", command: ["sh", "-ec", "umask 077 && cp -L /source/pool/* /delivered/pool/ && chmod 0600 /delivered/pool/*"],
              securityContext: restrictedContainer(settings.runAsUser),
              resources: { requests: { memory: "32Mi", cpu: "50m" }, limits: { memory: "64Mi", cpu: "100m" } },
              volumeMounts: [{ name: "pool-secret-source", mountPath: "/source/pool", readOnly: true }, { name: "pool-secrets", mountPath: "/delivered/pool" }],
            }],
            containers: [{
              name: "pool", image, imagePullPolicy: "IfNotPresent",
              command: ["bun", "src/factory/pool/process.ts", `${FACTORY_CONTAINER_PATHS.secrets}/pool.json`],
              securityContext: restrictedContainer(settings.runAsUser),
              resources: { requests: { memory: "512Mi", cpu: "500m" }, limits: { memory: "512Mi", cpu: "1" } },
              ports: [{ name: "pool", containerPort: poolPort }],
              volumeMounts: [{ name: "pool-secrets", mountPath: FACTORY_CONTAINER_PATHS.secrets, readOnly: true }, { name: "readiness", mountPath: `${FACTORY_CONTAINER_PATHS.readiness}/pool` }, { name: "tmp", mountPath: "/tmp" }],
              readinessProbe: { exec: { command: ["bun", "src/factory/provisioning/readiness-check.ts", `${FACTORY_CONTAINER_PATHS.readiness}/pool/pool.json`] }, periodSeconds: 5 },
            }],
            volumes: [
              { name: "pool-secret-source", secret: { secretName: factoryKubernetesSecretName("pool"), defaultMode: 0o400 } },
              { name: "pool-secrets", emptyDir: { medium: "Memory", sizeLimit: "4Mi" } },
              { name: "readiness", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
              { name: "tmp", emptyDir: { sizeLimit: "64Mi" } },
            ],
          },
        },
      },
    },
    { apiVersion: "v1", kind: "Service", metadata: { name: "factory-pool", namespace, labels: common }, spec: { selector: { "app.kubernetes.io/name": "factory-pool" }, ports: [{ name: "pool", port: poolPort, targetPort: poolPort }] } },
    {
      apiVersion: "apps/v1", kind: "DaemonSet", metadata: { name: "factory-supervisor", namespace, labels: common },
      spec: {
        selector: { matchLabels: { "app.kubernetes.io/name": "factory-supervisor" } },
        updateStrategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 1 } },
        template: {
          metadata: { labels: { ...common, "app.kubernetes.io/name": "factory-supervisor" } },
          spec: {
            serviceAccountName: "factory-supervisor", automountServiceAccountToken: false, hostNetwork: true, nodeSelector: { ...settings.nodeSelector },
            containers: [{
              name: "supervisor", image, imagePullPolicy: "IfNotPresent",
              command: ["bun", "src/factory/runner/supervisor-process.ts", "/run/ezcorp/host-identity/supervisor.json"],
              env: [{ name: "CONTAINER_HOST", value: `unix://${settings.runtimeSocketPath}` }],
              // The ONE privileged workload: it alone reaches the container runtime.
              securityContext: { privileged: true },
              resources: { requests: { memory: "256Mi", cpu: "250m" }, limits: { memory: "2Gi", cpu: "2" } },
              volumeMounts: [
                { name: "runtime-socket", mountPath: settings.runtimeSocketPath },
                { name: "runner-root", mountPath: "/var/lib/ezcorp-factory/runner" },
                { name: "host-identity", mountPath: "/run/ezcorp/host-identity", readOnly: true },
              ],
            }],
            volumes: [
              { name: "runtime-socket", hostPath: { path: settings.runtimeSocketPath, type: "Socket" } },
              { name: "runner-root", hostPath: { path: "/var/lib/ezcorp-factory/runner", type: "DirectoryOrCreate" } },
              { name: "host-identity", secret: { secretName: "factory-supervisor-host-identity", defaultMode: 0o400 } },
            ],
          },
        },
      },
    },
  ]);
}

/** YAML is a superset of JSON: one JSON document per `---` is a valid manifest stream. */
export function factoryKubernetesManifestStream(objects: readonly FactoryKubernetesObject[]): string {
  return objects.map((object) => JSON.stringify(object)).join("\n---\n").concat("\n");
}
