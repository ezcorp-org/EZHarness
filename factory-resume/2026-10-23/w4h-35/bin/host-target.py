import sys
p=sys.argv[1]
s=open(p).read()
def rep(old,new):
    global s
    assert s.count(old)==1, old[:90]
    s=s.replace(old,new)
rep('''import type { FactoryStepResources } from "./installation";''','''import type { FactoryFleetHostBundle, FactoryFleetHostPaths, FactoryFleetHostRuntime } from "./host";
import type { FactoryStepResources } from "./installation";''')
rep('''export class FactoryKubernetesTarget implements FactoryDeploymentTarget {''','''const digestOf = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

/** A workload with its pod template annotated by the digest of what it reads, so a changed delivery rolls it. */
function annotated(object: FactoryKubernetesObject, digest: string): FactoryKubernetesObject {
  const spec = object.spec as { template: { metadata: Record<string, unknown> } };
  return { ...object, spec: { ...spec, template: { ...spec.template, metadata: { ...spec.template.metadata, annotations: { [FACTORY_KUBERNETES_DELIVERY_DIGEST]: digest } } } } };
}

export class FactoryKubernetesTarget implements FactoryDeploymentTarget {''')
rep('''    const digest = `sha256:${createHash("sha256").update(JSON.stringify([...secrets.entries()])).digest("hex")}`;
    const objects = renderFactoryKubernetesInstallation(bundle, this.options.settings).map((object): FactoryKubernetesObject => {
      if (object.kind === "Secret") return { ...object, data: secrets.get((object.metadata as { name: string }).name) ?? {} };
      if (object.kind !== "Deployment") return object;
      const spec = object.spec as { template: { metadata: Record<string, unknown> } };
      return { ...object, spec: { ...spec, template: { ...spec.template, metadata: { ...spec.template.metadata, annotations: { [FACTORY_KUBERNETES_DELIVERY_DIGEST]: digest } } } } };
    });''','''    const digest = digestOf([...secrets.entries()]);
    const objects = renderFactoryKubernetesInstallation(bundle, this.options.settings).map((object): FactoryKubernetesObject => {
      if (object.kind === "Secret") return { ...object, data: secrets.get((object.metadata as { name: string }).name) ?? {} };
      return object.kind === "Deployment" ? annotated(object, digest) : object;
    });''')
s=s.rstrip()+open(sys.argv[2]).read()
open(p,"w").write(s)
