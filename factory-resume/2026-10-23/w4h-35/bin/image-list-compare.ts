// image-list-compare.ts <worktree> <old|new> <hosted-spec.json> <image ref>: the hosted image list exactly as repro/hosted-images.ts
// renders it after its fleet parse (the same three renderers, the same arguments), for patch 04's M5 evidence. `old` is run 12's call
// shape { pool, supervisor }; `new` is patch 04's { pool, supervisor, poolMetrics, supervisorMetrics }. The kubernetes settings are the
// fleet-profile mapping of the spec, with no monitoring (as the proof's fleet has none). Prints one image per line.
const [worktree, shape, specPath, image] = process.argv.slice(2);
const spec = JSON.parse(await Bun.file(specPath!).text()) as Record<string, any>;
const { factoryKubernetesImages, renderFactoryKubernetesIngress, renderFactoryKubernetesSystem } = await import(`${worktree}/src/factory/provisioning/kubernetes-profile.ts`);
const { factoryPlatformServices } = await import(`${worktree}/src/factory/provisioning/platform.ts`);
const kubernetes = {
  fleetId: "w4h35", systemNamespace: spec.systemNamespace, egressCidrs: spec.egressCidrs, egressPorts: spec.egressPorts, runAsUser: spec.runAsUser,
  runtimeSocketPath: spec.runtimeSocketPath, runnerRoot: spec.runnerRoot, nodeCidrs: spec.nodeCidrs, nodeSelector: spec.nodeSelector,
};
const { ingressImage } = await factoryPlatformServices(worktree!);
const ports = shape === "old" ? { pool: 1, supervisor: 2 } : { pool: 1, supervisor: 2, poolMetrics: 3, supervisorMetrics: 4 };
const objects = [
  ...renderFactoryKubernetesSystem(kubernetes, image!, ports),
  ...renderFactoryKubernetesIngress(kubernetes, { image: ingressImage, listenPort: spec.ingress.listenPort, nodePort: spec.ingress.nodePort, files: { "nginx.conf": "events {}\n" } }),
];
console.log([...new Set([...factoryKubernetesImages(objects), image!])].join("\n"));
