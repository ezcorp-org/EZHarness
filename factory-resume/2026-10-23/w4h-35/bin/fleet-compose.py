p="/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35/src/factory/provisioning/fleet.ts"
s=open(p).read()
def rep(old,new):
    global s
    assert s.count(old)==1, old[:100]
    s=s.replace(old,new)
rep('''import { FactoryComposeHostTarget, FactoryComposeTarget, FactoryComposeUpgradeTarget, factorySpawnExecutor, type FactoryCommandExecutor, type FactoryComposeCommand } from "./compose-profile";
import { FactoryFleetUpgrades, type FactoryBuild } from "./fleet-upgrade";''','''import { factorySpawnExecutor, type FactoryCommandExecutor, type FactoryComposeCommand } from "./compose-profile";
import { factoryFleetProfile } from "./fleet-profile";
import { FactoryFleetUpgrades, FactoryProfileUpgradeTarget, type FactoryBuild } from "./fleet-upgrade";''')
rep('''import { ensureFactoryPlatformMaterial, factoryPlatformPaths, factoryPodmanIngressReloader, stopFactoryPlatform, type FactoryPlatformPaths } from "./platform";''','''import { ensureFactoryPlatformMaterial, factoryPlatformPaths, stopFactoryPlatform, type FactoryPlatformPaths, type FactoryPlatformSettings } from "./platform";''')
rep('''  const hostTarget = runtime.hostTarget ?? new FactoryComposeHostTarget({
    compose: runtime.compose, templatePath: resolve(settings.release.directory, "deploy/factory/compose/host.yml"), execute,
    supervisor: { bun: settings.release.bun, releaseDirectory: settings.release.directory, path: settings.release.path },
    databasePort: settings.database.servicePort, uid: runtime.uid, gid: runtime.gid,
  });
  host = new FactoryFleetHost({
    settings: {
      fleetId: settings.fleetId, secretsRoot: settings.roots.secrets, operatorRoot: settings.roots.operator, runtimeRoot: settings.roots.runtime,
      portBase: settings.installations.portBase, resources: settings.resources,''','''  // What differs between the two deployment profiles, and only that (`fleet-profile.ts`).
  const profile = await factoryFleetProfile(settings, { execute, compose: runtime.compose, uid: runtime.uid, gid: runtime.gid, ingressRoot: platform.ingress.root });
  const hostTarget = runtime.hostTarget ?? profile.hostTarget;
  host = new FactoryFleetHost({
    settings: {
      fleetId: settings.fleetId, secretsRoot: settings.roots.secrets, operatorRoot: settings.roots.operator, runtimeRoot: settings.roots.runtime,
      portBase: settings.installations.portBase, resources: settings.resources, ...(profile.hosted === undefined ? {} : { hosted: profile.hosted }),''')
rep('''    network: {
      databaseHost: settings.database.serviceHost, databasePort: settings.database.servicePort,
      ordinaryEndpoint: settings.storage.ordinary.endpoint, archiveEndpoint: settings.storage.archive.endpoint,
      temporalAddress: `127.0.0.1:${settings.temporal.port}`, temporalServerName: settings.temporal.serverName,
      temporalHttpEndpoint: `https://127.0.0.1:${settings.temporal.httpPort}`,
      publicOrigin:''','''    network: {
      ...profile.network, temporalServerName: settings.temporal.serverName,
      publicOrigin:''')
rep('''  const storagePorts = [settings.storage.ordinary.endpoint, settings.storage.archive.endpoint].map((endpointUrl) => Number(new URL(endpointUrl).port));
  const composeTarget = new FactoryComposeTarget({
    compose: runtime.compose, templatePath: resolve(settings.release.directory, "deploy/factory/compose/installation.yml"), execute,
    databasePort: settings.database.servicePort, storagePorts, temporalPort: settings.temporal.port, temporalHttpPort: settings.temporal.httpPort, uid: runtime.uid, gid: runtime.gid,
  });
  const target = runtime.target ?? composeTarget;''','''  const target = runtime.target ?? profile.target;''')
rep('''    paths: { root: platform.ingress.root, mountedRoot: "/etc/ezcorp-ingress", listenAddress: settings.ingress.address, listenPort: settings.ingress.port },''','''    paths: { root: platform.ingress.root, mountedRoot: "/etc/ezcorp-ingress", listenAddress: profile.ingress.listenAddress, listenPort: profile.ingress.listenPort },''')
rep('''    reloader: factoryPodmanIngressReloader(settings.fleetId, execute),''','''    reloader: profile.ingress.reloader,''')
rep('''    upstreamPort: (installation) => factoryInstallationPorts(installation.tenantId, settings.installations.portBase).harness,''','''    upstreamPort: profile.ingress.upstreamPort,
    ...(profile.ingress.upstreamHost === undefined ? {} : { upstreamHost: profile.ingress.upstreamHost }),''')
rep('''new FactoryComposeUpgradeTarget((installation) => deployment.bundle(installation), composeTarget, fleetHost)''','''new FactoryProfileUpgradeTarget((installation) => deployment.bundle(installation), profile.upgrades, fleetHost)''')
rep('''    stopInstallation: async (tenantId: string) => composeTarget.stop(factoryDeploymentHandle(await composed.installation(tenantId), settings.roots.runtime)),
    startInstallation: async (tenantId: string) => composeTarget.start(await deployment.bundle(await composed.installation(tenantId))),''','''    stopInstallation: async (tenantId: string) => profile.target.stop(factoryDeploymentHandle(await composed.installation(tenantId), settings.roots.runtime)),
    startInstallation: async (tenantId: string) => profile.target.start(await deployment.bundle(await composed.installation(tenantId))),''')
open(p,"w").write(s)
print("ok")
