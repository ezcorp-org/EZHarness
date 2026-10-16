/**
 * The hosted profile's deployment target (C12 row "Kubernetes deployment target").
 *
 * The same `FactoryDeploymentTarget` the Compose profile implements, so the
 * seven steps, their ledger and their failure records are one code path; only
 * HOW step 5 runs a bundle differs.
 *
 *   - `apply` sends ONE server-side apply through kubectl's standard input: the
 *     objects `kubernetes-profile.ts` renders, with each service's Secret
 *     filled from that service's private delivery directory. Secret data never
 *     enters a manifest file, an argument list, or a log, and server-side apply
 *     keeps no last-applied copy of it in an annotation.
 *   - The installation pod's template carries a digest of every delivery, so a
 *     changed delivery (a rotation) rolls the pod and an unchanged one does not.
 *   - `ready` reads the pod's container statuses: each container's own probe
 *     decides, and the harness's probe is `/api/ready`.
 *   - `remove` stops the workloads and withdraws the Secrets and keeps the
 *     volume; `purge` deletes the namespace.
 *
 * The cluster is named by a private kubeconfig file the operator owns; this
 * module passes its path to kubectl and never reads it.
 */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { factoryCommandCheck, type FactoryCommandExecutor, type FactoryCommandResult } from "./compose-profile";
import { FACTORY_CONTAINER_SERVICES, type FactoryDeploymentHandle, type FactoryDeploymentTarget, type FactoryInstallationBundle } from "./deployment";
import type { FactoryFleetHostBundle, FactoryFleetHostPaths, FactoryFleetHostRuntime } from "./host";
import type { FactoryStepResources } from "./installation";
import { FACTORY_KUBERNETES_INGRESS, factoryKubernetesManifestStream, factoryKubernetesNamespace, factoryKubernetesSecretName, renderFactoryKubernetesIngress, renderFactoryKubernetesInstallation, renderFactoryKubernetesSystem, type FactoryKubernetesIngressSettings, type FactoryKubernetesObject, type FactoryKubernetesSettings } from "./kubernetes-profile";
import { readFactoryPrivatePath, removeFactoryPrivateDirectory } from "./secret-files";
import { FactoryProvisioningError } from "./steps";

export const FACTORY_KUBERNETES_DELIVERY_DIGEST = "ezcorp.io/delivery-digest";
const FIELD_MANAGER = "ezcorp-factory";
/** Everything `remove` withdraws. The volume, quota, service account and namespace stay until `purge`. */
const REMOVED_KINDS = "deployment,service,ingress,networkpolicy,secret";
/** A container that will not start without a change: fail now instead of at the deadline. */
const FATAL_WAITING = new Set(["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "InvalidImageName", "CreateContainerConfigError", "CreateContainerError"]);
/** The orchestrator restarts until Temporal and the gateway answer; only its image failing is fatal. */
const IMAGE_WAITING = new Set(["ImagePullBackOff", "ErrImagePull", "InvalidImageName"]);

/** How every hosted component reaches the cluster: kubectl and the operator's kubeconfig, by path only. */
export interface FactoryKubectlOptions {
  readonly execute: FactoryCommandExecutor;
  /** The kubectl binary. */
  readonly kubectl: string;
  /** The operator's private kubeconfig file, passed by path only. */
  readonly kubeconfigPath: string;
}

/** One kubectl call; a secret document travels only on standard input. */
export class FactoryKubectl {
  constructor(private readonly options: FactoryKubectlOptions) {}

  run(args: readonly string[], stdin?: string): Promise<FactoryCommandResult> {
    return this.options.execute([this.options.kubectl, "--kubeconfig", this.options.kubeconfigPath, ...args], stdin === undefined ? undefined : { stdin: new TextEncoder().encode(stdin) });
  }

  must(args: readonly string[], what: string, stdin?: string, code = "deployment_kubernetes_failed"): Promise<FactoryCommandResult> {
    return factoryCommandCheck(this.run(args, stdin), [0], code, what);
  }

  /** One server-side apply of an object stream: no last-applied copy of a Secret's data is kept in an annotation. */
  apply(objects: readonly FactoryKubernetesObject[], code?: string): Promise<FactoryCommandResult> {
    return this.must(["apply", "--server-side", `--field-manager=${FIELD_MANAGER}`, "--force-conflicts", "-f", "-"], "kubectl apply", factoryKubernetesManifestStream(objects).trimEnd(), code);
  }
}

export interface FactoryKubernetesTargetOptions extends FactoryKubectlOptions {
  readonly settings: FactoryKubernetesSettings;
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

/** One delivery directory as Secret data: every file, base64, each read through the private reader. */
export async function factoryKubernetesSecretData(directory: string): Promise<Record<string, string>> {
  const data: Record<string, string> = {};
  for (const name of (await readdir(directory)).sort()) data[name] = Buffer.from(await readFactoryPrivatePath(join(directory, name))).toString("base64");
  return data;
}

interface PodStatus {
  readonly status?: { readonly containerStatuses?: ReadonlyArray<{ readonly name: string; readonly ready: boolean; readonly state?: { readonly waiting?: { readonly reason?: string } } }> };
}

const digestOf = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

/** A workload with its pod template annotated by the digest of what it reads, so a changed delivery rolls it. */
function annotated(object: FactoryKubernetesObject, digest: string): FactoryKubernetesObject {
  const spec = object.spec as { template: { metadata: Record<string, unknown> } };
  return { ...object, spec: { ...spec, template: { ...spec.template, metadata: { ...spec.template.metadata, annotations: { [FACTORY_KUBERNETES_DELIVERY_DIGEST]: digest } } } } };
}

export class FactoryKubernetesTarget implements FactoryDeploymentTarget {
  readonly profile = "kubernetes" as const;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly kubectl: FactoryKubectl;
  constructor(private readonly options: FactoryKubernetesTargetOptions) {
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((settle) => setTimeout(settle, milliseconds)));
    this.now = options.now ?? Date.now;
    this.kubectl = new FactoryKubectl(options);
  }

  private static selector(handle: Pick<FactoryDeploymentHandle, "installation">): string {
    return `ezcorp.io/installation=${handle.installation.installationId}`;
  }

  async apply(bundle: FactoryInstallationBundle): Promise<FactoryStepResources> {
    const secrets = new Map<string, Record<string, string>>();
    for (const service of FACTORY_CONTAINER_SERVICES) secrets.set(factoryKubernetesSecretName(service), await factoryKubernetesSecretData(bundle.deliveries[service].directory));
    const digest = digestOf([...secrets.entries()]);
    const objects = renderFactoryKubernetesInstallation(bundle, this.options.settings).map((object): FactoryKubernetesObject => {
      if (object.kind === "Secret") return { ...object, data: secrets.get((object.metadata as { name: string }).name) ?? {} };
      return object.kind === "Deployment" ? annotated(object, digest) : object;
    });
    await this.kubectl.apply(objects);
    return Object.freeze({ kubernetesNamespace: factoryKubernetesNamespace(bundle) });
  }

  /** Ready means every container of the installation pod says so by its own probe. A deadline names what still waits. */
  async ready(bundle: FactoryInstallationBundle): Promise<void> {
    const namespace = factoryKubernetesNamespace(bundle);
    const deadline = this.now() + (this.options.readyTimeoutMs ?? 600_000);
    let waiting: string = FACTORY_CONTAINER_SERVICES[0];
    while (this.now() < deadline) {
      const listed = await this.kubectl.run(["get", "pods", "--namespace", namespace, "--selector", FactoryKubernetesTarget.selector(bundle), "--output", "json"]);
      const statuses = listed.code === 0 ? (JSON.parse(listed.stdout) as { items: PodStatus[] }).items.flatMap((pod) => pod.status?.containerStatuses ?? []) : [];
      const fatal = statuses.find((entry) => {
        const reason = entry.state?.waiting?.reason ?? "";
        return entry.name === "orchestrator" ? IMAGE_WAITING.has(reason) : FATAL_WAITING.has(reason);
      });
      if (fatal) throw new FactoryProvisioningError("deployment_service_exited", `Service ${fatal.name}: ${fatal.state!.waiting!.reason}.`);
      const notReady = FACTORY_CONTAINER_SERVICES.find((service) => statuses.find((entry) => entry.name === service)?.ready !== true);
      if (!notReady) return;
      waiting = notReady;
      await this.sleep(this.options.pollMs ?? 3_000);
    }
    throw new FactoryProvisioningError("deployment_not_ready", `Installation ${bundle.installation.tenantId} did not become ready; still waiting on ${waiting}.`);
  }

  /** Stop every workload and withdraw the Secrets. Idempotent; needs no credential of the installation. */
  async remove(handle: FactoryDeploymentHandle): Promise<void> {
    await this.kubectl.must(["delete", REMOVED_KINDS, "--namespace", factoryKubernetesNamespace(handle), "--selector", FactoryKubernetesTarget.selector(handle), "--ignore-not-found", "--wait=true"], "kubectl delete");
  }

  /** Scale to zero and keep everything, for the operator's `stop`. An installation never applied has nothing to stop. */
  async stop(handle: FactoryDeploymentHandle): Promise<void> {
    const namespace = factoryKubernetesNamespace(handle);
    const listed = await this.kubectl.must(["get", "deployment", "--namespace", namespace, "--selector", FactoryKubernetesTarget.selector(handle), "--ignore-not-found", "--output", "name"], "kubectl get");
    if (listed.stdout.trim() === "") return;
    await this.kubectl.must(["scale", "deployment/installation", "--namespace", namespace, "--replicas=0"], "kubectl scale");
  }

  /** Scale back to one and wait until it serves, for the operator's `up`. */
  async start(bundle: FactoryInstallationBundle): Promise<void> {
    await this.kubectl.must(["scale", "deployment/installation", "--namespace", factoryKubernetesNamespace(bundle), "--replicas=1"], "kubectl scale");
    await this.ready(bundle);
  }

  /** Remove, then delete the namespace with its volume, then the runtime directory. */
  async purge(handle: FactoryDeploymentHandle): Promise<void> {
    await this.remove(handle);
    await this.kubectl.must(["delete", "namespace", factoryKubernetesNamespace(handle), "--ignore-not-found", "--wait=true"], "kubectl delete namespace");
    await removeFactoryPrivateDirectory(handle.runtimeDirectory);
  }
}

export interface FactoryKubernetesIngressReloaderOptions extends FactoryKubectlOptions, Omit<FactoryKubernetesIngressSettings, "files"> {
  readonly settings: FactoryKubernetesSettings;
  /** The ingress root the provisioner renders into (`platform.ts`): `nginx.conf`, `conf/`, `certs/`, and the operator's `routes/`. */
  readonly root: string;
}

/**
 * The hosted profile's ingress reload (`FactoryIngressStep`'s reloader): the
 * files nginx reads, and only those (the route files, which hold each proof
 * beside its state, stay with the operator), are applied as the ingress
 * Secret, and the reload waits for the new pod. A new configuration nginx
 * refuses never becomes ready, so the serving pod keeps serving and the reload
 * fails by name.
 */
export class FactoryKubernetesIngressReloader {
  private readonly kubectl: FactoryKubectl;
  constructor(private readonly options: FactoryKubernetesIngressReloaderOptions) { this.kubectl = new FactoryKubectl(options); }

  private async files(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const read = async (path: string) => { files[path] = new TextDecoder().decode(await readFactoryPrivatePath(join(this.options.root, path))); };
    await read("nginx.conf");
    for (const directory of ["conf", "certs"]) for (const name of (await readdir(join(this.options.root, directory))).sort()) await read(`${directory}/${name}`);
    return files;
  }

  async reload(): Promise<void> {
    const { image, listenPort, nodePort, settings } = this.options;
    await this.kubectl.apply(renderFactoryKubernetesIngress(settings, { image, listenPort, nodePort, files: await this.files() }), "ingress_reload_failed");
    await this.kubectl.must(["rollout", "status", `deployment/${FACTORY_KUBERNETES_INGRESS}`, "--namespace", settings.systemNamespace, "--timeout=120s"], "the ingress rollout", undefined, "ingress_reload_failed");
  }
}

/** Every object the fleet host owns in the system namespace, by name: never the fleet's ingress beside them. */
const HOST_OBJECTS = ["deployment/factory-pool", "daemonset/factory-supervisor", "service/factory-pool", "service/factory-supervisor", `secret/${factoryKubernetesSecretName("pool")}`, "secret/factory-supervisor-host-identity"];

export interface FactoryKubernetesHostTargetOptions extends FactoryKubectlOptions {
  readonly settings: FactoryKubernetesSettings;
}

/**
 * The fleet host's two shared services in the hosted profile (C12; W4H-35):
 * the pool Deployment and the supervisor DaemonSet in the system namespace,
 * each from its own delivery, as Secrets sent only on kubectl's standard input.
 * Each workload carries the digest of its own delivery, so a new admission
 * (new trust, new routes) rolls exactly the service whose delivery changed.
 */
export class FactoryKubernetesHostTarget implements FactoryFleetHostRuntime {
  private readonly kubectl: FactoryKubectl;
  constructor(private readonly options: FactoryKubernetesHostTargetOptions) { this.kubectl = new FactoryKubectl(options); }

  private get namespace(): string { return this.options.settings.systemNamespace; }

  async apply(bundle: FactoryFleetHostBundle): Promise<void> {
    const pool = await factoryKubernetesSecretData(bundle.paths.poolDelivery);
    const supervisor = await factoryKubernetesSecretData(bundle.paths.supervisorDelivery);
    const data: Readonly<Record<string, Record<string, string>>> = { [factoryKubernetesSecretName("pool")]: pool, "factory-supervisor-host-identity": supervisor };
    const objects = renderFactoryKubernetesSystem(this.options.settings, bundle.build.image, bundle.identity.ports).map((object): FactoryKubernetesObject => {
      if (object.kind === "Secret") return { ...object, data: data[(object.metadata as { name: string }).name] ?? {} };
      if (object.kind === "Deployment") return annotated(object, digestOf(pool));
      return object.kind === "DaemonSet" ? annotated(object, digestOf(supervisor)) : object;
    });
    await this.kubectl.apply(objects, "host_kubernetes_failed");
  }

  async ready(_bundle: FactoryFleetHostBundle): Promise<void> {
    for (const workload of ["deployment/factory-pool", "daemonset/factory-supervisor"]) {
      await this.kubectl.must(["rollout", "status", workload, "--namespace", this.namespace, "--timeout=180s"], `the ${workload} rollout`, undefined, "host_not_ready");
    }
  }

  async serving(_paths: FactoryFleetHostPaths): Promise<boolean> {
    const status = async (workload: string) => {
      const listed = await this.kubectl.run(["get", workload, "--namespace", this.namespace, "--output", "json"]);
      return listed.code === 0 ? (JSON.parse(listed.stdout) as { status?: { readyReplicas?: number; numberReady?: number } }).status ?? {} : {};
    };
    return ((await status("deployment/factory-pool")).readyReplicas ?? 0) >= 1 && ((await status("daemonset/factory-supervisor")).numberReady ?? 0) >= 1;
  }

  /** The pool scaled to zero and the DaemonSet removed; `up` re-applies both. Idempotent. */
  async stop(_paths: FactoryFleetHostPaths): Promise<void> {
    const scaled = await this.kubectl.run(["scale", "deployment/factory-pool", "--namespace", this.namespace, "--replicas=0"]);
    if (scaled.code !== 0 && !scaled.stderr.includes("NotFound")) throw new FactoryProvisioningError("host_kubernetes_failed", `kubectl scale failed (${scaled.code}): ${scaled.stderr.trim().slice(0, 400)}`);
    await this.kubectl.must(["delete", "daemonset/factory-supervisor", "--namespace", this.namespace, "--ignore-not-found", "--wait=true"], "kubectl delete", undefined, "host_kubernetes_failed");
  }

  async remove(_paths: FactoryFleetHostPaths): Promise<void> {
    await this.kubectl.must(["delete", ...HOST_OBJECTS, "--namespace", this.namespace, "--ignore-not-found", "--wait=true"], "kubectl delete", undefined, "host_kubernetes_failed");
  }

  async purge(paths: FactoryFleetHostPaths): Promise<void> {
    await this.remove(paths);
    await removeFactoryPrivateDirectory(paths.runtimeDirectory);
  }
}
