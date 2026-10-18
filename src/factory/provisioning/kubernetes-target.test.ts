import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  factoryRejection,
  makeFactoryPrivateRoot,
  makeFactoryTestDeploymentSettings,
  makeFactoryTestInstallation,
  removeFactoryPrivateRoot,
  writeFactoryTestDatabaseCredentials,
  writeModeFile,
} from "../../__tests__/helpers/factory-private-root";
import type { FactoryCommandExecutor, FactoryCommandResult } from "./compose-profile";
import { FACTORY_CONTAINER_SERVICES, renderFactoryInstallationBundle, type FactoryInstallationBundle } from "./deployment";
import { factoryKubernetesNamespace, factoryKubernetesSecretName, type FactoryKubernetesObject, type FactoryKubernetesSettings } from "./kubernetes-profile";
import { FACTORY_KUBERNETES_DELIVERY_DIGEST, FactoryKubernetesHostTarget, FactoryKubernetesIngressReloader, FactoryKubernetesTarget, factoryKubernetesSecretData } from "./kubernetes-target";
import { factoryFleetHostIdentity, factoryFleetHostPaths, type FactoryFleetHostBundle } from "./host";

const SETTINGS: FactoryKubernetesSettings = {
  fleetId: "fleet-a", systemNamespace: "ezcorp-factory-system", monitoringNamespace: "monitoring",
  egressCidrs: ["10.0.0.0/24"], egressPorts: [5432], runAsUser: 10_001, runtimeSocketPath: "/run/containerd/containerd.sock", runnerRoot: "/srv/ezcorp-runner", nodeCidrs: [], nodeSelector: {},
};
const KUBECTL = "/nix/store/kubectl/bin/kubectl";
const KUBECONFIG = "/srv/operator/kubeconfig";
const APPLY = [KUBECTL, "--kubeconfig", KUBECONFIG, "apply", "--server-side", "--field-manager=ezcorp-factory", "--force-conflicts", "-f", "-"];

/** The secret each service's delivery holds, unique so a leak into argv or another Secret is visible. */
const SECRET = (service: string, name: string) => `secret-${service}-${name}-value\n`;
const DELIVERED: Readonly<Record<string, readonly string[]>> = { gateway: ["gateway.json"], harness: ["factory-startup.json", "harness-database-url"], orchestrator: ["orchestrator.json", "master.key", "wraps.json"] };

let root: string;
let bundle: FactoryInstallationBundle;
let namespace: string;

beforeAll(async () => {
  root = await makeFactoryPrivateRoot();
  const installation = makeFactoryTestInstallation(root);
  await writeFactoryTestDatabaseCredentials(installation);
  bundle = await renderFactoryInstallationBundle(installation, makeFactoryTestDeploymentSettings(join(root, "runtime")));
  namespace = factoryKubernetesNamespace(bundle);
  for (const service of FACTORY_CONTAINER_SERVICES) {
    const directory = bundle.deliveries[service].directory;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const name of DELIVERED[service]!) await writeModeFile(join(directory, name), SECRET(service, name));
  }
});
afterAll(async () => { await removeFactoryPrivateRoot(root); });

interface Call { readonly argv: readonly string[]; readonly stdin?: string }

/** A kubectl stand-in: records every call, answers each by the first matching rule. */
function kubectl(answers: ReadonlyArray<readonly [(argv: readonly string[]) => boolean, FactoryCommandResult | (() => FactoryCommandResult)]> = []) {
  const calls: Call[] = [];
  const execute: FactoryCommandExecutor = async (argv, options) => {
    calls.push({ argv, ...(options?.stdin ? { stdin: new TextDecoder().decode(options.stdin) } : {}) });
    const answer = answers.find(([matches]) => matches(argv))?.[1];
    return typeof answer === "function" ? answer() : answer ?? { code: 0, stdout: "", stderr: "" };
  };
  return { calls, execute };
}

function target(execute: FactoryCommandExecutor, options: { readonly now?: () => number; readonly readyTimeoutMs?: number } = {}) {
  return new FactoryKubernetesTarget({ execute, kubectl: KUBECTL, kubeconfigPath: KUBECONFIG, settings: SETTINGS, sleep: async () => {}, pollMs: 1, ...options });
}

const streamOf = (call: Call) => call.stdin!.split("\n---\n").map((document) => JSON.parse(document) as FactoryKubernetesObject & { data?: Record<string, string> });
const pods = (containers: ReadonlyArray<{ name: string; ready: boolean; waiting?: string }>) => ({
  code: 0, stderr: "",
  stdout: JSON.stringify({ items: [{ status: { phase: "Running", containerStatuses: containers.map((entry) => ({ name: entry.name, ready: entry.ready, restartCount: entry.waiting ? 4 : 0, state: entry.waiting ? { waiting: { reason: entry.waiting } } : { running: {} } })) } }] }),
});
const allReady = () => pods(["gateway", "harness", "orchestrator"].map((name) => ({ name, ready: true })));
const isGet = (argv: readonly string[]) => argv.includes("get") && argv.includes("pods");

describe("factoryKubernetesSecretData", () => {
  test("is every delivered file, base64, through the private reader", async () => {
    expect(await factoryKubernetesSecretData(bundle.deliveries.orchestrator.directory)).toEqual(Object.fromEntries(DELIVERED.orchestrator!.map((name) => [name, Buffer.from(SECRET("orchestrator", name)).toString("base64")])));
  });

  test("a delivered file that is not private is refused", async () => {
    const directory = join(root, "loose");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeModeFile(join(directory, "token"), "x\n", 0o644);
    expect((await factoryRejection(factoryKubernetesSecretData(directory))).message).toContain("private");
  });
});

describe("FactoryKubernetesTarget.apply", () => {
  test("one server-side apply through stdin: each service's Secret carries exactly its own delivery, and no secret reaches argv", async () => {
    const { calls, execute } = kubectl();
    expect(await target(execute).apply(bundle)).toEqual({ kubernetesNamespace: namespace });
    expect(calls.map((call) => call.argv)).toEqual([APPLY]);
    const objects = streamOf(calls[0]!);
    expect(objects[0]!.kind).toBe("Namespace");
    for (const service of FACTORY_CONTAINER_SERVICES) {
      const secret = objects.find((object) => object.kind === "Secret" && (object.metadata as { name: string }).name === factoryKubernetesSecretName(service))!;
      expect(Object.keys(secret.data!).sort()).toEqual([...DELIVERED[service]!].sort());
      for (const name of DELIVERED[service]!) expect(Buffer.from(secret.data![name]!, "base64").toString()).toBe(SECRET(service, name));
    }
    const holders = (name: string) => objects.filter((object) => object.kind === "Secret" && object.data && name in object.data).map((object) => (object.metadata as { name: string }).name);
    expect(holders("master.key")).toEqual([factoryKubernetesSecretName("orchestrator")]);
    expect(holders("wraps.json")).toEqual([factoryKubernetesSecretName("orchestrator")]);
    for (const service of FACTORY_CONTAINER_SERVICES) for (const name of DELIVERED[service]!) expect(calls[0]!.argv.join(" ")).not.toContain(SECRET(service, name).trim());
  });

  test("the installation's pod template carries the deliveries' digest, so a changed delivery rolls the pod and an unchanged one does not", async () => {
    const digestOf = async () => {
      const { calls, execute } = kubectl();
      await target(execute).apply(bundle);
      const deployment = streamOf(calls[0]!).find((object) => object.kind === "Deployment")!;
      return (deployment.spec as { template: { metadata: { annotations: Record<string, string> } } }).template.metadata.annotations[FACTORY_KUBERNETES_DELIVERY_DIGEST]!;
    };
    const first = await digestOf();
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await digestOf()).toBe(first);
    const token = join(bundle.deliveries.harness.directory, "harness-database-url");
    await writeModeFile(token, "rotated\n");
    expect(await digestOf()).not.toBe(first);
    await writeModeFile(token, SECRET("harness", "harness-database-url"));
  });

  test("a refused apply is a named failure", async () => {
    const { execute } = kubectl([[(argv) => argv.includes("apply"), { code: 1, stdout: "", stderr: "Error from server (Forbidden)" }]]);
    const error = await factoryRejection(target(execute).apply(bundle));
    expect(error.code).toBe("deployment_kubernetes_failed");
    expect(error.message).toContain("Forbidden");
  });
});

describe("FactoryKubernetesTarget.ready", () => {
  const LIST = [KUBECTL, "--kubeconfig", KUBECONFIG, "get", "pods", "--namespace", "", "--selector", "", "--output", "json"];

  test("resolves when every container is ready by its own probe (the harness's is /api/ready)", async () => {
    const { calls, execute } = kubectl([[isGet, allReady()]]);
    await target(execute).ready(bundle);
    expect(calls.map((call) => call.argv)).toEqual([LIST.map((value, index) => index === 6 ? namespace : index === 8 ? `ezcorp.io/installation=${bundle.installation.installationId}` : value)]);
  });

  test("waits through a pod that is not ready yet, and through a failed listing", async () => {
    const answers = [{ code: 1, stdout: "", stderr: "connection refused" }, pods([{ name: "gateway", ready: true }, { name: "harness", ready: false }, { name: "orchestrator", ready: true }]), allReady()];
    const { calls, execute } = kubectl([[isGet, () => answers.shift()!]]);
    await target(execute).ready(bundle);
    expect(calls).toHaveLength(3);
  });

  test("a crash-looping gateway or harness, or an image that cannot be pulled, fails at once by name", async () => {
    for (const [name, reason] of [["harness", "CrashLoopBackOff"], ["gateway", "ImagePullBackOff"], ["orchestrator", "ErrImagePull"]] as const) {
      const { execute } = kubectl([[isGet, pods([{ name: "gateway", ready: name !== "gateway" }, { name: "harness", ready: name !== "harness" }, { name: "orchestrator", ready: name !== "orchestrator" }].map((entry) => entry.name === name ? { ...entry, waiting: reason } : entry))]]);
      const error = await factoryRejection(target(execute).ready(bundle));
      expect(error.code).toBe("deployment_service_exited");
      expect(error.message).toContain(`${name}: ${reason}`);
    }
  });

  test("the orchestrator restarting until its dependencies answer is not a failure before the deadline; the deadline names what is still waiting", async () => {
    let clock = 0;
    const { execute } = kubectl([[isGet, () => { clock += 1_000; return pods([{ name: "gateway", ready: true }, { name: "harness", ready: false }, { name: "orchestrator", ready: false, waiting: "CrashLoopBackOff" }]); }]]);
    const error = await factoryRejection(target(execute, { now: () => clock, readyTimeoutMs: 5_000 }).ready(bundle));
    expect(error.code).toBe("deployment_not_ready");
    expect(error.message).toBe(`Installation tenant-01 did not become ready; still waiting on harness.`);
  });

  test("no pod at all is waiting on the installation pod", async () => {
    let clock = 0;
    const { execute } = kubectl([[isGet, () => { clock += 1_000; return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" }; }]]);
    expect((await factoryRejection(target(execute, { now: () => clock, readyTimeoutMs: 2_000 }).ready(bundle))).message).toContain("still waiting on gateway");
  });
});

describe("FactoryKubernetesTarget.remove, stop, start, purge", () => {
  const run = (...args: string[]) => [KUBECTL, "--kubeconfig", KUBECONFIG, ...args];
  const selector = () => `ezcorp.io/installation=${bundle.installation.installationId}`;

  test("remove deletes the workloads, routes, policies and Secrets of the installation only, keeps its volume and namespace, and is idempotent", async () => {
    const { calls, execute } = kubectl();
    await target(execute).remove(bundle);
    await target(execute).remove(bundle);
    const remove = run("delete", "deployment,service,ingress,networkpolicy,secret", "--namespace", namespace, "--selector", selector(), "--ignore-not-found", "--wait=true");
    expect(calls.map((call) => call.argv)).toEqual([remove, remove]);
  });

  test("stop scales the installation to zero and keeps everything; a never-applied installation has nothing to stop", async () => {
    const present = kubectl([[(argv) => argv.includes("get"), { code: 0, stdout: "deployment.apps/installation\n", stderr: "" }]]);
    await target(present.execute).stop(bundle);
    expect(present.calls.map((call) => call.argv)).toEqual([
      run("get", "deployment", "--namespace", namespace, "--selector", selector(), "--ignore-not-found", "--output", "name"),
      run("scale", "deployment/installation", "--namespace", namespace, "--replicas=0"),
    ]);
    const absent = kubectl();
    await target(absent.execute).stop(bundle);
    expect(absent.calls).toHaveLength(1);
  });

  test("start scales back to one and waits until ready", async () => {
    const { calls, execute } = kubectl([[isGet, allReady()]]);
    await target(execute).start(bundle);
    expect(calls[0]!.argv).toEqual(run("scale", "deployment/installation", "--namespace", namespace, "--replicas=1"));
    expect(calls).toHaveLength(2);
  });

  test("purge deletes the namespace with its volume and removes the runtime directory", async () => {
    const runtimeDirectory = join(root, "purge-runtime");
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    const { calls, execute } = kubectl();
    await target(execute).purge({ ...bundle, runtimeDirectory });
    expect(calls.map((call) => call.argv)).toEqual([
      run("delete", "deployment,service,ingress,networkpolicy,secret", "--namespace", namespace, "--selector", selector(), "--ignore-not-found", "--wait=true"),
      run("delete", "namespace", namespace, "--ignore-not-found", "--wait=true"),
    ]);
    expect((await factoryRejection(stat(runtimeDirectory))).code).toBe("ENOENT");
  });

  test("a failed delete is a named failure and the runtime directory is kept", async () => {
    const runtimeDirectory = join(root, "kept-runtime");
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    const { execute } = kubectl([[(argv) => argv.includes("namespace"), { code: 1, stdout: "", stderr: "timed out" }]]);
    expect((await factoryRejection(target(execute).purge({ ...bundle, runtimeDirectory }))).code).toBe("deployment_kubernetes_failed");
    expect((await stat(runtimeDirectory)).isDirectory()).toBe(true);
  });
});

describe("FactoryKubernetesIngressReloader (C12 row \"Trusted ingress\")", () => {
  const NGINX = `docker.io/library/nginx@sha256:${"2".repeat(64)}`;
  async function ingressRoot(): Promise<string> {
    const ingress = join(root, `ingress-${Math.random().toString(16).slice(2)}`);
    for (const directory of ["", "conf", "certs", "routes"]) await mkdir(join(ingress, directory), { recursive: true, mode: 0o700 });
    await writeModeFile(join(ingress, "nginx.conf"), "events {}\n");
    await writeModeFile(join(ingress, "conf", "ezcorp-factory.conf"), "server {}\n");
    await writeModeFile(join(ingress, "certs", "tenant-01.crt"), "crt\n");
    await writeModeFile(join(ingress, "certs", "tenant-01.key"), "key\n");
    await writeModeFile(join(ingress, "routes", "tenant-01.json"), "{\"proof\":\"route files stay with the operator\"}\n");
    return ingress;
  }
  const reloader = (execute: FactoryCommandExecutor, ingress: string) => new FactoryKubernetesIngressReloader({ execute, kubectl: KUBECTL, kubeconfigPath: KUBECONFIG, settings: SETTINGS, root: ingress, image: NGINX, listenPort: 8443, nodePort: 30443 });

  test("applies the ingress from the files nginx reads, never the route files, then waits for the rollout", async () => {
    const ingress = await ingressRoot();
    const { calls, execute } = kubectl();
    await reloader(execute, ingress).reload();
    expect(calls.map((call) => call.argv)).toEqual([APPLY, [KUBECTL, "--kubeconfig", KUBECONFIG, "rollout", "status", "deployment/factory-ingress", "--namespace", "ezcorp-factory-system", "--timeout=120s"]]);
    const secret = streamOf(calls[0]!).find((object) => object.kind === "Secret")!;
    expect(Object.keys(secret.data!).sort()).toEqual(["certs--tenant-01.crt", "certs--tenant-01.key", "conf--ezcorp-factory.conf", "nginx.conf"]);
    expect(calls[0]!.stdin).not.toContain("route files stay with the operator");
  });

  test("a rollout that does not become ready is a named reload failure; the serving pod keeps serving", async () => {
    const ingress = await ingressRoot();
    const { execute } = kubectl([[(argv) => argv.includes("rollout"), { code: 1, stdout: "", stderr: "timed out waiting for the condition" }]]);
    const error = await factoryRejection(reloader(execute, ingress).reload());
    expect(error.code).toBe("ingress_reload_failed");
    expect(error.message).toContain("timed out");
  });

  test("an ingress file that is not private is refused before anything is applied", async () => {
    const ingress = await ingressRoot();
    await writeModeFile(join(ingress, "certs", "tenant-01.key"), "key\n", 0o644);
    const { calls, execute } = kubectl();
    expect((await factoryRejection(reloader(execute, ingress).reload())).message).toContain("private");
    expect(calls).toEqual([]);
  });
});

describe("FactoryKubernetesHostTarget (the shared pool and supervisor, W4H-35)", () => {
  const IMAGE = `registry.test/ezcorp@sha256:${"d".repeat(64)}`;
  const run = (...args: string[]) => [KUBECTL, "--kubeconfig", KUBECONFIG, ...args];
  const OWNED = ["deployment/factory-pool", "daemonset/factory-supervisor", "service/factory-pool", "service/factory-supervisor", "secret/factory-pool-secrets", "secret/factory-supervisor-host-identity"];
  async function hostBundle(): Promise<FactoryFleetHostBundle> {
    const paths = factoryFleetHostPaths("fleet-a", { secretsRoot: join(root, "host-secrets"), operatorRoot: join(root, "host-operator"), runtimeRoot: join(root, "host-runtime") });
    for (const [directory, files] of [[paths.poolDelivery, { "pool.json": "pool-config\n", "pool-database.json": "pool-database-secret\n" }], [paths.supervisorDelivery, { "supervisor.json": "supervisor-config\n", "host.key": "host-key-secret\n" }]] as const) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const [name, value] of Object.entries(files)) await writeModeFile(join(directory, name), value);
    }
    await mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
    return { identity: factoryFleetHostIdentity("fleet-a", 40_000), paths, admitted: [], build: { image: IMAGE, revision: "e".repeat(40), release: "/release" }, pool: {}, supervisor: {}, deliveries: { pool: {}, supervisor: {} } };
  }
  const host = (execute: FactoryCommandExecutor, options: { readonly now?: () => number } = {}) => new FactoryKubernetesHostTarget({ execute, kubectl: KUBECTL, kubeconfigPath: KUBECONFIG, settings: SETTINGS, ...options });

  test("apply fills the pool's Secret from its delivery and the supervisor's from its own, through stdin, and digests each into its own workload", async () => {
    const bundle = await hostBundle();
    const { calls, execute } = kubectl();
    await host(execute).apply(bundle);
    expect(calls.map((call) => call.argv)).toEqual([APPLY]);
    const objects = streamOf(calls[0]!);
    const data = (name: string) => Object.keys(objects.find((object) => object.kind === "Secret" && (object.metadata as { name: string }).name === name)!.data!).sort();
    expect(data("factory-pool-secrets")).toEqual(["pool-database.json", "pool.json"]);
    expect(data("factory-supervisor-host-identity")).toEqual(["host.key", "supervisor.json"]);
    for (const secret of ["pool-database-secret", "host-key-secret"]) expect(calls[0]!.argv.join(" ")).not.toContain(secret);
    const annotation = (kind: string) => ((objects.find((object) => object.kind === kind)!.spec as { template: { metadata: { annotations: Record<string, string> } } }).template.metadata.annotations[FACTORY_KUBERNETES_DELIVERY_DIGEST]);
    expect(annotation("Deployment")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(annotation("DaemonSet")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(annotation("Deployment")).not.toBe(annotation("DaemonSet"));
    expect(JSON.stringify(objects)).toContain(IMAGE);
  });

  test("ready waits for both rollouts, and a rollout that does not finish is host_not_ready", async () => {
    const bundle = await hostBundle();
    const ok = kubectl();
    await host(ok.execute).ready(bundle);
    expect(ok.calls.map((call) => call.argv)).toEqual([
      run("rollout", "status", "deployment/factory-pool", "--namespace", "ezcorp-factory-system", "--timeout=180s"),
      run("rollout", "status", "daemonset/factory-supervisor", "--namespace", "ezcorp-factory-system", "--timeout=180s"),
    ]);
    const stuck = kubectl([[(argv) => argv.includes("daemonset/factory-supervisor"), { code: 1, stdout: "", stderr: "timed out" }]]);
    expect((await factoryRejection(host(stuck.execute).ready(bundle))).code).toBe("host_not_ready");
  });

  // C12 row "Supervisor runner root and runtime socket (hosted prerequisites)": the runner root is a hostPath of type Directory the
  // operator prepares; a missing one stops the supervisor pod at its mount, and the installer HOLDs by name, not as a bare timeout.
  test("a supervisor rollout stopped by an unprepared runner root is runner_root_unprepared, named from the pod's events (W4H-35 run 12)", async () => {
    const bundle = await hostBundle();
    const events = { items: [
      { reason: "FailedMount", involvedObject: { kind: "Pod", name: "factory-supervisor-abcde" }, message: `MountVolume.SetUp failed for volume "runner-root" : hostPath type check failed: ${SETTINGS.runnerRoot} is not a directory` },
      { reason: "FailedMount", involvedObject: { kind: "Pod", name: "other" }, message: "MountVolume.SetUp failed for volume \"x\" : secret \"y\" not found" },
    ] };
    const unprepared = kubectl([
      [(argv) => argv.includes("daemonset/factory-supervisor"), { code: 1, stdout: "", stderr: "timed out" }],
      [(argv) => argv.includes("events"), { code: 0, stdout: JSON.stringify(events), stderr: "" }],
    ]);
    const error = await factoryRejection(host(unprepared.execute).ready(bundle));
    expect(error.code).toBe("runner_root_unprepared");
    expect(error.message).toContain(SETTINGS.runnerRoot);
    expect(unprepared.calls.map((call) => call.argv).at(-1)).toEqual(run("get", "events", "--namespace", "ezcorp-factory-system", "--field-selector", "reason=FailedMount", "--output", "json"));
    // Another mount failure, or events the cluster does not give, keep the rollout's own refusal.
    const other = kubectl([
      [(argv) => argv.includes("daemonset/factory-supervisor"), { code: 1, stdout: "", stderr: "timed out" }],
      [(argv) => argv.includes("events"), { code: 0, stdout: JSON.stringify({ items: [events.items[1]] }), stderr: "" }],
    ]);
    expect((await factoryRejection(host(other.execute).ready(bundle))).code).toBe("host_not_ready");
    const silent = kubectl([
      [(argv) => argv.includes("daemonset/factory-supervisor"), { code: 1, stdout: "", stderr: "timed out" }],
      [(argv) => argv.includes("events"), { code: 1, stdout: "", stderr: "forbidden" }],
    ]);
    expect((await factoryRejection(host(silent.execute).ready(bundle))).code).toBe("host_not_ready");
  });

  test("serving means a ready pool and a ready supervisor; anything else, or no cluster answer, is not serving", async () => {
    const bundle = await hostBundle();
    const answer = (pool: unknown, supervisor: unknown) => kubectl([
      [(argv) => argv.includes("deployment/factory-pool"), { code: 0, stdout: JSON.stringify(pool), stderr: "" }],
      [(argv) => argv.includes("daemonset/factory-supervisor"), { code: 0, stdout: JSON.stringify(supervisor), stderr: "" }],
    ]).execute;
    expect(await host(answer({ status: { readyReplicas: 1 } }, { status: { numberReady: 1 } })).serving(bundle.paths)).toBe(true);
    expect(await host(answer({ status: {} }, { status: { numberReady: 1 } })).serving(bundle.paths)).toBe(false);
    expect(await host(answer({ status: { readyReplicas: 1 } }, { status: { numberReady: 0 } })).serving(bundle.paths)).toBe(false);
    expect(await host(kubectl([[() => true, { code: 1, stdout: "", stderr: "NotFound" }]]).execute).serving(bundle.paths)).toBe(false);
  });

  test("stop scales the pool to zero and removes the DaemonSet; up re-applies it. remove and purge touch only the host's own objects, never the ingress", async () => {
    const bundle = await hostBundle();
    const stopped = kubectl();
    await host(stopped.execute).stop(bundle.paths);
    expect(stopped.calls.map((call) => call.argv)).toEqual([
      run("scale", "deployment/factory-pool", "--namespace", "ezcorp-factory-system", "--replicas=0"),
      run("delete", "daemonset/factory-supervisor", "--namespace", "ezcorp-factory-system", "--ignore-not-found", "--wait=true"),
    ]);
    const absent = kubectl([[(argv) => argv.includes("scale"), { code: 1, stdout: "", stderr: 'Error from server (NotFound): deployments.apps "factory-pool" not found' }]]);
    await host(absent.execute).stop(bundle.paths);
    const removed = kubectl();
    await host(removed.execute).purge(bundle.paths);
    expect(removed.calls.map((call) => call.argv)).toEqual([run("delete", ...OWNED, "--namespace", "ezcorp-factory-system", "--ignore-not-found", "--wait=true")]);
    expect(JSON.stringify(removed.calls)).not.toContain("factory-ingress");
    expect((await factoryRejection(stat(bundle.paths.runtimeDirectory))).code).toBe("ENOENT");
  });
});
