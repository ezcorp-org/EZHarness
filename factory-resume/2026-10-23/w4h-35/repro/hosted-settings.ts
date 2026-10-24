// hosted-settings.ts <fleet.json> <spec.json> [<ordinary endpoint> <archive endpoint>]: turn a local fleet's settings into the
// hosted profile's (W4H-35 proof). The optional endpoints point the provisioner at the proof's own stores (run 6 ruling).
// spec.json names the kubectl and kubeconfig paths, the namespace, the ingress ports, the runner root, the node and
// service CIDRs, and the pod-side service addresses. The result is validated by the product's own fleet parser before
// it is written; nothing secret is read or printed (the kubeconfig and every credential are named by path only).
import { parseFactoryFleetSettings } from "/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35/src/factory/provisioning/fleet.ts";
const [fleetPath, specPath, ordinaryEndpoint, archiveEndpoint] = process.argv.slice(2);
const fleet = JSON.parse(await Bun.file(fleetPath!).text()) as Record<string, unknown>;
const spec = JSON.parse(await Bun.file(specPath!).text()) as Record<string, unknown>;
const storage = fleet.storage as { ordinary: Record<string, unknown>; archive: Record<string, unknown> } & Record<string, unknown>;
const stores = ordinaryEndpoint && archiveEndpoint
  ? { ...storage, ordinary: { ...storage.ordinary, endpoint: ordinaryEndpoint }, archive: { ...storage.archive, endpoint: archiveEndpoint } }
  : storage;
const hosted = parseFactoryFleetSettings({ ...fleet, storage: stores, profile: "kubernetes", kubernetes: spec });
await Bun.write(fleetPath!, `${JSON.stringify(hosted, null, 2)}\n`);
console.log(JSON.stringify({ written: fleetPath, profile: hosted.profile, namespace: hosted.kubernetes!.systemNamespace, stores: [hosted.storage.ordinary.endpoint, hosted.storage.archive.endpoint] }));
