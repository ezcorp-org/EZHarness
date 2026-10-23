

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
