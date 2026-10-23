import sys
p=sys.argv[1]
s=open(p).read()
def rep(old,new):
    global s
    assert s.count(old)==1, old[:90]
    s=s.replace(old,new)
rep('''export interface FactoryKubernetesTargetOptions {
  readonly execute: FactoryCommandExecutor;
  /** The kubectl binary. */
  readonly kubectl: string;
  /** The operator's private kubeconfig file, passed by path only. */
  readonly kubeconfigPath: string;
  readonly settings: FactoryKubernetesSettings;''','''/** How every hosted component reaches the cluster: kubectl and the operator's kubeconfig, by path only. */
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
  readonly settings: FactoryKubernetesSettings;''')
rep('''  constructor(private readonly options: FactoryKubernetesTargetOptions) {
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((settle) => setTimeout(settle, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  private kubectl(args: readonly string[], stdin?: string): Promise<FactoryCommandResult> {
    return this.options.execute([this.options.kubectl, "--kubeconfig", this.options.kubeconfigPath, ...args], stdin === undefined ? undefined : { stdin: new TextEncoder().encode(stdin) });
  }

  private must(args: readonly string[], what: string, stdin?: string): Promise<FactoryCommandResult> {
    return factoryCommandCheck(this.kubectl(args, stdin), [0], "deployment_kubernetes_failed", what);
  }
''','''  private readonly kubectl: FactoryKubectl;
  constructor(private readonly options: FactoryKubernetesTargetOptions) {
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((settle) => setTimeout(settle, milliseconds)));
    this.now = options.now ?? Date.now;
    this.kubectl = new FactoryKubectl(options);
  }
''')
rep('''    await this.must(["apply", "--server-side", `--field-manager=${FIELD_MANAGER}`, "--force-conflicts", "-f", "-"], "kubectl apply", factoryKubernetesManifestStream(objects).trimEnd());''','''    await this.kubectl.apply(objects);''')
rep('''await this.kubectl(["get", "pods"''','''await this.kubectl.run(["get", "pods"''')
s=s.replace("await this.must(","await this.kubectl.must(")
open(p,"w").write(s)
print("left must:", s.count("this.must("), "left kubectl(:", s.count("this.kubectl("))
