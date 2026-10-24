// hosted-images.ts <fleet.json>: every image reference the hosted profile's manifests will run, one per line, from the
// product's own renderers (never restated): the system namespace (pool, supervisor), the trusted ingress (its image from
// platform.yml, factoryPlatformServices), and the installation pods (the fleet's image reference). W4H-35 pre-install check.
import { parseFactoryFleetSettings } from "/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35/src/factory/provisioning/fleet.ts";
import { factoryFleetKubernetesSettings } from "/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35/src/factory/provisioning/fleet-profile.ts";
import { factoryKubernetesImages, renderFactoryKubernetesIngress, renderFactoryKubernetesSystem } from "/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35/src/factory/provisioning/kubernetes-profile.ts";
import { factoryPlatformServices } from "/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35/src/factory/provisioning/platform.ts";
const settings = parseFactoryFleetSettings(JSON.parse(await Bun.file(process.argv[2]!).text()));
const kubernetes = factoryFleetKubernetesSettings(settings);
const image = settings.image.reference;
const { ingressImage } = await factoryPlatformServices(settings.release.directory);
const objects = [
  ...renderFactoryKubernetesSystem(kubernetes, image, { pool: 1, supervisor: 2, poolMetrics: 3, supervisorMetrics: 4 }),
  ...renderFactoryKubernetesIngress(kubernetes, { image: ingressImage, listenPort: settings.kubernetes!.ingress.listenPort, nodePort: settings.kubernetes!.ingress.nodePort, files: { "nginx.conf": "events {}\n" } }),
];
console.log([...new Set([...factoryKubernetesImages(objects), image])].join("\n"));
