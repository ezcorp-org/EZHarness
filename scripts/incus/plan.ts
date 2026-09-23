import { isIP } from "node:net";
import { canonicalJson, type SandboxPreset } from "@ezcorp/extension-contract";
import { INCUS_PROVIDER_ID, incusManifest } from "../../extensions/incus-sandbox/manifest";
import { guestHelperSha256 } from "../../src/infrastructure/incus-guest/protocol";
import type { IncusImageBootstrapPlan, IncusInventory, IncusSetupPlan, IncusSetupRecipe, SetupStep } from "./model";
import { SETUP_SCHEMA_VERSION, assertExactKeys, assertRecord, assertSafeName, assertSetupPlanDigest, assertSha256, digest, inventoryFingerprint, isSubset } from "./model";

const VERSION = /^\d+\.\d+\.\d+$/;
const SIZE = /^[1-9]\d*(?:KiB|MiB|GiB|TiB)$/;
const HTTPS_ADDRESS = /^(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/;
const NETWORK_CONFIG_KEYS = ["dns.domain", "dns.mode", "ipv4.address", "ipv4.nat", "ipv6.address"] as const;
const PROJECT_CONFIG_KEYS = [
  "features.images", "features.networks", "features.networks.zones", "features.profiles", "features.storage.buckets", "features.storage.volumes",
  "limits.containers", "limits.cpu", "limits.disk.pool.<pool>", "limits.memory", "limits.networks", "limits.processes", "limits.virtual-machines",
  "restricted", "restricted.containers.nesting", "restricted.devices.nic", "restricted.images.servers", "restricted.networks.access",
  "restricted.storage-pools.access",
] as const;
const PROFILE_CONFIG_KEYS = ["limits.cpu", "limits.memory", "limits.memory.enforce", "limits.processes", "security.idmap.isolated", "security.nesting", "security.privileged"] as const;

function sortedEntries(value: Record<string, string>): Array<[string, string]> { return Object.entries(value).sort(([left], [right]) => left.localeCompare(right)); }
function configArgs(config: Record<string, string>): string[] { return sortedEntries(config).flatMap(([key, value]) => ["--config", `${key}=${value}`]); }
function keyValueArgs(config: Record<string, string>): string[] { return sortedEntries(config).map(([key, value]) => `${key}=${value}`); }

function assertClosedStringMap(value: Record<string, string>, label: string): void {
  for (const [key, entry] of Object.entries(value)) {
    const hasControlCharacter = [...entry].some(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
    if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(key) || !entry || entry.length > 512 || hasControlCharacter) throw new Error(`${label} contains an invalid setting`);
  }
}

function assertExactStringMap(value: Record<string, string>, keys: readonly string[], label: string): void {
  assertExactKeys(value, keys, label);
  if (Object.keys(value).length !== keys.length) throw new Error(`${label} must define every supported setting`);
  assertClosedStringMap(value, label);
}

function binarySizeBytes(value: string): number {
  const match = /^(?<amount>[1-9]\d*)(?<unit>KiB|MiB|GiB|TiB)$/.exec(value);
  if (!match?.groups) throw new Error("size must use an explicit binary unit");
  const powers = { KiB: 1, MiB: 2, GiB: 3, TiB: 4 } as const;
  const bytes = Number(match.groups.amount) * 1024 ** powers[match.groups.unit as keyof typeof powers];
  if (!Number.isSafeInteger(bytes)) throw new Error("size exceeds the safe integer range");
  return bytes;
}

function binarySizeLabel(bytes: number): string {
  const gib = 1024 ** 3;
  return bytes % gib === 0 ? `${bytes / gib}GiB` : `${bytes}B`;
}

function presetCompatibilityReasons(recipe: IncusSetupRecipe, presets: readonly SandboxPreset[]): string[] {
  if (!presets.length) return ["incus_presets_missing"];
  const rootSize = recipe.profile.devices.root!.size!;
  const rootBytes = binarySizeBytes(rootSize);
  const reasons: string[] = [];
  for (const preset of presets) {
    if (!preset.requirements.storageDrivers.includes(recipe.storage.driver)) {
      reasons.push(`preset_storage_driver_incompatible:${preset.id}:${recipe.storage.driver}:requires_${[...preset.requirements.storageDrivers].sort().join("_or_")}`);
    }
    const requiredBytes = Math.max(preset.limits.diskBytes, preset.storage.minimumBytes);
    if (rootBytes < requiredBytes) {
      reasons.push(`preset_root_disk_too_small:${preset.id}:${rootSize}:requires_${binarySizeLabel(requiredBytes)}`);
    }
  }
  return reasons;
}

function boundedPositiveInteger(value: string, maximum: number, label: string): void {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum) throw new Error(`${label} exceeds the supported bound`);
}

function ipv4ToInt(address: string): number {
  if (isIP(address) !== 4) throw new Error(`invalid IPv4 address ${address}`);
  return address.split(".").reduce((result, octet) => result * 256 + Number(octet), 0) >>> 0;
}

function cidrRange(value: string): [number, number] | undefined {
  const [address, rawPrefix] = value.split("/");
  if (!address || isIP(address) !== 4 || rawPrefix === undefined || !/^\d+$/.test(rawPrefix)) return undefined;
  const prefix = Number(rawPrefix);
  if (prefix < 0 || prefix > 32) return undefined;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = ipv4ToInt(address) & mask;
  return [start >>> 0, (start | (~mask >>> 0)) >>> 0];
}

function overlaps(left: string, right: string): boolean {
  const a = cidrRange(left); const b = cidrRange(right);
  return Boolean(a && b && a[0] <= b[1] && b[0] <= a[1]);
}

export function validateRecipe(recipe: IncusSetupRecipe): void {
  assertRecord(recipe, "recipe");
  assertExactKeys(recipe, ["schemaVersion", "id", "version", "expected", "storage", "network", "project", "profile", "server", "guestImage", "providerClient"], "recipe");
  for (const [value, keys, label] of [
    [recipe.expected, ["hostname", "architecture", "incusVersion", "serverCertificateFingerprint", "sshHostKeySha256", "firewall", "minimumRootFreeBytes", "requiredApiExtensions"], "expected host"],
    [recipe.storage, ["name", "driver", "size", "sizeBytes", "defaultVolumeSize"], "storage"],
    [recipe.network, ["name", "project", "type", "config"], "network"],
    [recipe.project, ["name", "description", "config"], "project"],
    [recipe.profile, ["name", "description", "config", "devices"], "profile"],
    [recipe.server, ["httpsAddress"], "server"],
  ] as const) {
    assertRecord(value, label);
    assertExactKeys(value, keys, label);
  }
  if (recipe.schemaVersion !== SETUP_SCHEMA_VERSION) throw new Error("unsupported Incus recipe schema");
  if (recipe.guestImage) {
    const image = recipe.guestImage;
    assertRecord(image, "guest image");
    assertExactKeys(image, ["alias", "fingerprint", "sourceFingerprint", "helperSha256", "user", "uid", "gid", "pythonPackageVersion", "dockerArchiveSha256", "composeSha256"], "guest image");
    assertSafeName(image.alias, "guest image alias");
    if (image.user !== "sandbox" || image.uid !== 1000 || image.gid !== 1000) throw new Error("guest image must pin sandbox user 1000:1000");
    assertSha256(image.helperSha256, "guest helper digest");
    if (image.helperSha256 !== guestHelperSha256()) throw new Error("guest helper source differs from the reviewed image recipe");
    for (const [value, label] of [[image.fingerprint, "guest image fingerprint"], [image.sourceFingerprint, "guest source fingerprint"],
      [image.dockerArchiveSha256, "Docker archive digest"], [image.composeSha256, "Compose digest"]] as const) {
      if (value !== null) assertSha256(value, label);
    }
    if (image.pythonPackageVersion !== null && !/^[A-Za-z0-9.+:~_-]{1,128}$/.test(image.pythonPackageVersion)) throw new Error("Python package version must be exact");
  }
  assertSafeName(recipe.id, "recipe id");
  if (!VERSION.test(recipe.version)) throw new Error("recipe version must be exact semantic version");
  assertSafeName(recipe.expected.hostname, "expected hostname");
  if (!VERSION.test(recipe.expected.incusVersion)) throw new Error("expected Incus version must be exact");
  assertSha256(recipe.expected.serverCertificateFingerprint, "server certificate fingerprint");
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(recipe.expected.sshHostKeySha256)) throw new Error("SSH host key fingerprint must be SHA256 base64");
  if (!Number.isSafeInteger(recipe.expected.minimumRootFreeBytes) || recipe.expected.minimumRootFreeBytes <= recipe.storage.sizeBytes) throw new Error("minimum root free space must preserve capacity beyond the pool");
  if (!Array.isArray(recipe.expected.requiredApiExtensions) || !recipe.expected.requiredApiExtensions.length || recipe.expected.requiredApiExtensions.some(value => !/^[a-z][a-z0-9_]{0,127}$/.test(value)) || new Set(recipe.expected.requiredApiExtensions).size !== recipe.expected.requiredApiExtensions.length) throw new Error("required API extensions must be a unique bounded list");
  for (const [value, label] of [[recipe.storage.name, "storage name"], [recipe.network.name, "network name"], [recipe.project.name, "project name"], [recipe.profile.name, "profile name"]] as const) assertSafeName(value, label);
  if (recipe.expected.architecture !== "x86_64" || recipe.expected.firewall !== "nftables") throw new Error("host architecture and firewall must use the supported values");
  if (!["lvm", "btrfs", "zfs"].includes(recipe.storage.driver) || !SIZE.test(recipe.storage.size) || !SIZE.test(recipe.storage.defaultVolumeSize) || binarySizeBytes(recipe.storage.size) !== recipe.storage.sizeBytes) throw new Error("storage sizes and driver must be exact and consistent");
  if (binarySizeBytes(recipe.storage.defaultVolumeSize) > recipe.storage.sizeBytes) throw new Error("default storage volume exceeds the pool");
  if (recipe.network.project !== "default" || recipe.network.type !== "bridge") throw new Error("network must be a managed bridge in the default project");
  assertExactStringMap(recipe.network.config, NETWORK_CONFIG_KEYS, "network config");
  assertExactStringMap(recipe.project.config, PROJECT_CONFIG_KEYS.map(key => key === "limits.disk.pool.<pool>" ? `limits.disk.pool.${recipe.storage.name}` : key), "project config");
  assertExactStringMap(recipe.profile.config, PROFILE_CONFIG_KEYS, "profile config");
  assertExactKeys(recipe.profile.devices, ["eth0", "root"], "profile devices");
  if (Object.keys(recipe.profile.devices).length !== 2) throw new Error("profile must define eth0 and root only");
  const eth0 = recipe.profile.devices.eth0; const root = recipe.profile.devices.root;
  assertRecord(eth0, "eth0 device"); assertRecord(root, "root device");
  assertExactStringMap(eth0, ["type", "name", "network"], "eth0 device");
  assertExactStringMap(root, ["type", "path", "pool", "size"], "root device");
  if (canonicalJson(eth0) !== canonicalJson({ type: "nic", name: "eth0", network: recipe.network.name })) throw new Error("eth0 must use the managed setup network");
  if (canonicalJson(root) !== canonicalJson({ type: "disk", path: "/", pool: recipe.storage.name, size: recipe.storage.defaultVolumeSize })) throw new Error("root must use the bounded setup storage pool");
  const cidr = recipe.network.config["ipv4.address"];
  if (!cidr || !cidrRange(cidr) || recipe.network.config["ipv4.nat"] !== "true" || recipe.network.config["ipv6.address"] !== "none" || recipe.network.config["dns.mode"] !== "managed") throw new Error("network must pin an IPv4 CIDR, NAT, managed DNS and disabled IPv6");
  const project = recipe.project.config;
  if (project.restricted !== "true" || project["features.networks"] !== "false" || project["features.profiles"] !== "true" || project["limits.virtual-machines"] !== "0" || project["restricted.devices.nic"] !== "managed" || project["restricted.networks.access"] !== recipe.network.name || project["restricted.storage-pools.access"] !== recipe.storage.name) throw new Error("project must retain the closed restriction policy");
  boundedPositiveInteger(project["limits.containers"]!, 4, "container limit"); boundedPositiveInteger(project["limits.cpu"]!, 12, "project CPU limit"); boundedPositiveInteger(project["limits.processes"]!, 4096, "project process limit");
  if (binarySizeBytes(project["limits.memory"]!) > 32 * 1024 ** 3 || binarySizeBytes(project[`limits.disk.pool.${recipe.storage.name}`]!) > recipe.storage.sizeBytes) throw new Error("project memory or disk limit exceeds the supported bound");
  const profile = recipe.profile.config;
  if (profile["limits.memory.enforce"] !== "hard" || profile["security.idmap.isolated"] !== "true" || profile["security.nesting"] !== "true" || profile["security.privileged"] !== "false") throw new Error("profile must retain hard unprivileged isolation");
  boundedPositiveInteger(profile["limits.cpu"]!, Number(project["limits.cpu"]), "profile CPU limit"); boundedPositiveInteger(profile["limits.processes"]!, Number(project["limits.processes"]), "profile process limit");
  if (binarySizeBytes(profile["limits.memory"]!) > binarySizeBytes(project["limits.memory"]!)) throw new Error("profile memory exceeds the project limit");
  if (!HTTPS_ADDRESS.test(recipe.server.httpsAddress)) throw new Error("HTTPS address must be an exact IPv4 address and port");
  const [httpsHost, httpsPort] = recipe.server.httpsAddress.split(":");
  if (isIP(httpsHost!) !== 4 || Number(httpsPort) < 1 || Number(httpsPort) > 65535) throw new Error("HTTPS address is invalid");
  if (recipe.providerClient) {
    assertRecord(recipe.providerClient, "provider client");
    assertExactKeys(recipe.providerClient, ["name", "certificateFingerprint", "certificatePem", "projects", "restricted"], "provider client");
    assertSafeName(recipe.providerClient.name, "provider client name");
    assertSha256(recipe.providerClient.certificateFingerprint, "provider certificate fingerprint");
    if (!recipe.providerClient.certificatePem.startsWith("-----BEGIN CERTIFICATE-----\n") || !recipe.providerClient.certificatePem.endsWith("-----END CERTIFICATE-----\n") || recipe.providerClient.certificatePem.length > 16_384) throw new Error("provider certificate must be bounded PEM");
    if (recipe.providerClient.restricted !== true || canonicalJson([...recipe.providerClient.projects].sort()) !== canonicalJson([recipe.project.name])) throw new Error("provider certificate must be restricted to the setup project");
  }
}

function step(id: string, resource: SetupStep["resource"], description: string, inspectArgv: string[], expected: unknown, applyArgv: string[], stdin?: string, emptyAsAbsent = false): SetupStep {
  return { id, resource, description, inspect: { argv: inspectArgv, expected, notFoundExitCodes: [1], ...(emptyAsAbsent ? { emptyAsAbsent: true } : {}) }, apply: { argv: applyArgv, ...(stdin === undefined ? {} : { stdin }) } };
}

function compareExisting(existing: unknown, expected: unknown, reason: string, blocked: string[]): void {
  if (existing !== undefined && !isSubset(expected, existing)) blocked.push(reason);
}

function sameRecord(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function partialProfileMatches(existing: IncusInventory["profiles"][number], desired: IncusInventory["profiles"][number]): boolean {
  return existing.name === desired.name && existing.project === desired.project && existing.description === desired.description &&
    Object.entries(existing.config).every(([key, value]) => desired.config[key] === value) &&
    Object.entries(existing.devices).every(([key, device]) => desired.devices[key] !== undefined && sameRecord(device, desired.devices[key]!));
}

export function createSetupPlan(recipe: IncusSetupRecipe, inventory: IncusInventory, presets: readonly SandboxPreset[] =
  incusManifest.sandboxProviders?.find(provider => provider.id === INCUS_PROVIDER_ID)?.presets ?? []): IncusSetupPlan {
  validateRecipe(recipe);
  const blocked: string[] = presetCompatibilityReasons(recipe, presets);
  if (!recipe.guestImage) blocked.push("guest_image_missing_from_recipe");
  if (recipe.guestImage) {
    const image = recipe.guestImage;
    if (!image.fingerprint || !image.sourceFingerprint || !image.pythonPackageVersion ||
        !image.dockerArchiveSha256 || !image.composeSha256) blocked.push("guest_image_artifact_unpinned");
    else if (!inventory.images?.some(value => value.fingerprint === image.fingerprint && value.aliases.includes(image.alias))) {
      blocked.push("guest_image_missing_or_drifted");
    }
  }
  if (inventory.connection.sshHostKeySha256 !== recipe.expected.sshHostKeySha256) blocked.push("ssh_host_key_changed");
  if (inventory.host.hostname !== recipe.expected.hostname) blocked.push("hostname_mismatch");
  if (inventory.host.architecture !== recipe.expected.architecture) blocked.push("architecture_mismatch");
  if (inventory.server.clientVersion !== recipe.expected.incusVersion || inventory.server.serverVersion !== recipe.expected.incusVersion) blocked.push("incus_version_mismatch");
  if (inventory.server.certificateFingerprint !== recipe.expected.serverCertificateFingerprint) blocked.push("incus_certificate_changed");
  if (inventory.server.firewall !== recipe.expected.firewall) blocked.push("firewall_mismatch");
  if (inventory.server.clustered) blocked.push("clustered_server_unsupported");
  if (!inventory.server.serviceActive || inventory.server.apiStatus !== "stable") blocked.push("incus_not_ready");
  if (inventory.host.cgroupVersion !== "v2") blocked.push("cgroup_v2_required");
  if (!inventory.host.ntpSynchronized) blocked.push("clock_not_synchronized");
  const poolAlreadyExists = inventory.storagePools.some(pool => pool.name === recipe.storage.name);
  const requiredFreeBytes = recipe.expected.minimumRootFreeBytes - (poolAlreadyExists ? recipe.storage.sizeBytes : 0);
  if (inventory.host.rootFreeBytes < requiredFreeBytes) blocked.push("insufficient_root_capacity");
  if (!inventory.server.storageDrivers.some(driver => driver.name === recipe.storage.driver && !driver.remote)) blocked.push(`${recipe.storage.driver}_driver_unavailable`);
  const [httpsHost] = recipe.server.httpsAddress.split(":");
  if (!inventory.host.addresses.includes(httpsHost!)) blocked.push("https_bind_address_missing");
  if (Number(recipe.project.config["limits.cpu"]) > inventory.host.cpuThreads || binarySizeBytes(recipe.project.config["limits.memory"]!) > inventory.host.memoryBytes) blocked.push("resource_limits_exceed_host");
  for (const extension of recipe.expected.requiredApiExtensions) if (!inventory.server.apiExtensions.includes(extension)) blocked.push(`missing_api_extension:${extension}`);
  const networkCidr = recipe.network.config["ipv4.address"]!;

  const desiredPool = { name: recipe.storage.name, driver: recipe.storage.driver, config: { size: recipe.storage.size,
    ...(recipe.storage.driver === "lvm" ? { "lvm.use_thinpool": "true" } : {}), "volume.size": recipe.storage.defaultVolumeSize } };
  const desiredNetwork = { name: recipe.network.name, project: recipe.network.project, type: recipe.network.type, managed: true, config: recipe.network.config };
  const desiredProject = { name: recipe.project.name, description: recipe.project.description, config: recipe.project.config };
  const desiredProfile = { name: recipe.profile.name, project: recipe.project.name, description: recipe.profile.description, config: recipe.profile.config, devices: recipe.profile.devices };
  const existingPool = inventory.storagePools.find(pool => pool.name === recipe.storage.name);
  const existingNetwork = inventory.networks.find(network => network.project === recipe.network.project && network.name === recipe.network.name);
  for (const route of inventory.routes) {
    if (!overlaps(networkCidr, route)) continue;
    const bindings = inventory.routeBindings?.filter(binding => binding.destination === route) ?? [];
    const ownedRoute = existingNetwork && isSubset(desiredNetwork, existingNetwork) &&
      cidrRange(networkCidr)?.join(":") === cidrRange(route)?.join(":") &&
      bindings.length > 0 && bindings.every(binding => binding.device === recipe.network.name);
    if (!ownedRoute) blocked.push(`network_route_conflict:${route}`);
  }
  const existingProject = inventory.projects.find(project => project.name === recipe.project.name);
  const existingProfile = inventory.profiles.find(profile => profile.project === recipe.project.name && profile.name === recipe.profile.name);
  compareExisting(existingPool, desiredPool, "storage_pool_drift", blocked);
  compareExisting(existingNetwork, desiredNetwork, "network_drift", blocked);
  compareExisting(existingProject, desiredProject, "project_drift", blocked);
  if (existingProfile && !partialProfileMatches(existingProfile, desiredProfile)) blocked.push("profile_drift");
  if (existingNetwork && Object.keys(existingNetwork.config).some(key => !Object.hasOwn(recipe.network.config, key) && !key.startsWith("volatile."))) blocked.push("network_drift");
  if (existingProject && !sameRecord(existingProject.config, recipe.project.config)) blocked.push("project_drift");
  if (inventory.instances.length) blocked.push("instances_present");
  if (inventory.trust.some(entry => entry.fingerprint !== recipe.providerClient?.certificateFingerprint)) blocked.push("unexpected_trust_entry");

  const steps: SetupStep[] = [
    step("storage-pool", "storage", `Create ${recipe.storage.name} as a bounded ${recipe.storage.driver} pool`, ["incus", "query", `/1.0/storage-pools/${recipe.storage.name}`], desiredPool, ["incus", "storage", "create", recipe.storage.name, recipe.storage.driver, ...keyValueArgs(desiredPool.config)]),
    step("managed-network", "network", `Create the pinned ${networkCidr} managed bridge`, ["incus", "query", `/1.0/networks/${recipe.network.name}?project=${recipe.network.project}`], desiredNetwork, ["incus", "network", "create", recipe.network.name, `--project=${recipe.network.project}`, `--type=${recipe.network.type}`, ...keyValueArgs(recipe.network.config)]),
    step("restricted-project", "project", `Create restricted project ${recipe.project.name}`, ["incus", "query", `/1.0/projects/${recipe.project.name}`], desiredProject, ["incus", "project", "create", recipe.project.name, `--description=${recipe.project.description}`, ...configArgs(recipe.project.config)]),
    step("compose-profile", "profile", `Create bounded profile ${recipe.profile.name}`, ["incus", "query", `/1.0/profiles/${recipe.profile.name}?project=${recipe.project.name}`], { name: recipe.profile.name }, ["incus", "profile", "create", recipe.profile.name, "--description", recipe.profile.description, "--project", recipe.project.name]),
    ...sortedEntries(recipe.profile.config).map(([key, value]) => step(`profile-config-${key.replaceAll(".", "-")}`, "profile", `Set ${key} on ${recipe.profile.name}`, ["incus", "profile", "get", recipe.profile.name, key, "--project", recipe.project.name], value, ["incus", "profile", "set", recipe.profile.name, `${key}=${value}`, "--project", recipe.project.name], undefined, true)),
    ...Object.entries(recipe.profile.devices).sort(([left], [right]) => left.localeCompare(right)).map(([deviceName, device]) => step(`profile-device-${deviceName}`, "profile", `Add ${deviceName} to ${recipe.profile.name}`, ["incus", "profile", "device", "get", recipe.profile.name, deviceName, "type", "--project", recipe.project.name], device.type, ["incus", "profile", "device", "add", recipe.profile.name, deviceName, device.type!, ...keyValueArgs(Object.fromEntries(Object.entries(device).filter(([key]) => key !== "type"))), "--project", recipe.project.name])),
    step("https-listener", "server", `Bind Incus HTTPS to ${recipe.server.httpsAddress}`, ["incus", "config", "get", "core.https_address"], recipe.server.httpsAddress, ["incus", "config", "set", `core.https_address=${recipe.server.httpsAddress}`], undefined, true),
  ];
  if (!recipe.providerClient) blocked.push("provider_client_certificate_missing");
  else {
    const desiredTrust = { fingerprint: recipe.providerClient.certificateFingerprint, name: recipe.providerClient.name, restricted: true, projects: [...recipe.providerClient.projects].sort(), type: "client" };
    compareExisting(inventory.trust.find(entry => entry.fingerprint === recipe.providerClient!.certificateFingerprint), desiredTrust, "provider_trust_drift", blocked);
    steps.push(step("provider-client", "trust", `Trust only the scoped ${recipe.providerClient.name} certificate`, ["incus", "query", `/1.0/certificates/${recipe.providerClient.certificateFingerprint}`], desiredTrust, ["incus", "config", "trust", "add-certificate", "-", "--name", recipe.providerClient.name, "--projects", recipe.project.name, "--restricted"], recipe.providerClient.certificatePem));
  }
  const recipeDigest = digest(recipe);
  const payload = { schemaVersion: SETUP_SCHEMA_VERSION, setupId: `${recipe.id}:${recipe.version}:${inventory.server.certificateFingerprint.slice(0, 16)}`, recipeId: recipe.id, recipeVersion: recipe.version, recipeDigest, inventoryFingerprint: inventoryFingerprint(inventory), status: blocked.length ? "blocked" as const : "ready" as const, blockedReasons: [...new Set(blocked)].sort(), steps };
  return { ...payload, planDigest: digest(payload) };
}

const IMAGE_BOOTSTRAP_PREREQUISITES = new Set([
  "guest_image_missing_from_recipe", "guest_image_artifact_unpinned", "guest_image_missing_or_drifted", "provider_client_certificate_missing",
]);

function bootstrapBaselineFingerprint(recipe: IncusSetupRecipe, inventory: IncusInventory): string {
  const desiredRoute = recipe.network.config["ipv4.address"]!;
  const targetNetwork = inventory.networks.find(network => network.name === recipe.network.name && network.project === recipe.network.project);
  const matchingNetwork = targetNetwork && isSubset({ type: "bridge", managed: true, config: recipe.network.config }, targetNetwork);
  const [gateway, prefix] = desiredRoute.split("/");
  const [networkAddress, broadcastAddress] = cidrRange(desiredRoute)!;
  const toIpv4 = (value: number): string => [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join(".");
  const bridgeRoutes = new Set([`${toIpv4(networkAddress)}/${prefix}`, gateway!, toIpv4(broadcastAddress)]);
  const ownedRoute = (route: string): boolean => {
    if (!matchingNetwork || !bridgeRoutes.has(route)) return false;
    const bindings = inventory.routeBindings?.filter(binding => binding.destination === route) ?? [];
    return bindings.length > 0 && bindings.every(binding => binding.device === recipe.network.name);
  };
  const stable = {
    ...inventory,
    host: { ...inventory.host, rootFreeBytes: 0,
      addresses: inventory.host.addresses.filter(address => !(address === gateway && ownedRoute(gateway!))) },
    storagePools: inventory.storagePools.filter(pool => pool.name !== recipe.storage.name),
    networks: inventory.networks.filter(network => !(network.name === recipe.network.name && network.project === recipe.network.project)),
    routes: inventory.routes.filter(route => !ownedRoute(route)),
    routeBindings: (inventory.routeBindings ?? []).filter(binding => !ownedRoute(binding.destination)),
  };
  return inventoryFingerprint(stable);
}

export function verifyImageBootstrapPlan(plan: IncusImageBootstrapPlan, recipe: IncusSetupRecipe, inventory: IncusInventory, presets?: readonly SandboxPreset[]): string[] {
  assertSetupPlanDigest(plan);
  const current = createImageBootstrapPlan(recipe, inventory, presets);
  const failures = [
    ...(plan.purpose !== "image_bootstrap" || plan.status !== "ready" || typeof plan.targetPresence?.storage !== "boolean" || typeof plan.targetPresence?.network !== "boolean" || plan.recipeDigest !== current.recipeDigest || plan.baselineFingerprint !== current.baselineFingerprint || digest(plan.steps) !== digest(current.steps) ? ["bootstrap_plan_drift"] : []),
    ...current.blockedReasons,
    ...current.steps.filter(step => step.resource === "storage" ? !inventory.storagePools.some(pool => isSubset(step.inspect.expected, pool)) : !inventory.networks.some(network => isSubset(step.inspect.expected, network))).map(step => `unverified:${step.id}`),
  ];
  return [...new Set(failures)].sort();
}

export function createImageBootstrapPlan(recipe: IncusSetupRecipe, inventory: IncusInventory, presets?: readonly SandboxPreset[]): IncusImageBootstrapPlan {
  const setup = createSetupPlan(recipe, inventory, presets);
  const blockedReasons = setup.blockedReasons.filter(reason => !IMAGE_BOOTSTRAP_PREREQUISITES.has(reason));
  const steps = setup.steps.filter(step => step.resource === "storage" || step.resource === "network");
  if (steps.length !== 2 || steps[0]?.id !== "storage-pool" || steps[1]?.id !== "managed-network") throw new Error("bootstrap resource scope changed");
  const payload = {
    schemaVersion: SETUP_SCHEMA_VERSION, setupId: setup.setupId, recipeId: setup.recipeId, recipeVersion: setup.recipeVersion,
    recipeDigest: setup.recipeDigest, inventoryFingerprint: setup.inventoryFingerprint,
    status: blockedReasons.length ? "blocked" as const : "ready" as const, blockedReasons, steps,
    purpose: "image_bootstrap" as const, baselineFingerprint: bootstrapBaselineFingerprint(recipe, inventory),
    targetPresence: {
      storage: inventory.storagePools.some(pool => pool.name === recipe.storage.name),
      network: inventory.networks.some(network => network.name === recipe.network.name && network.project === recipe.network.project),
    },
  };
  return { ...payload, planDigest: digest(payload) };
}

export function verifySetupPlan(plan: IncusSetupPlan, recipe: IncusSetupRecipe, inventory: IncusInventory, presets?: readonly SandboxPreset[]): string[] {
  assertSetupPlanDigest(plan);
  const regenerated = createSetupPlan(recipe, inventory, presets);
  const failures: string[] = [];
  if (plan.recipeDigest !== digest(recipe)) failures.push("recipe_digest_changed");
  if (plan.status !== "ready") failures.push(...plan.blockedReasons.map(reason => `plan_blocked:${reason}`));
  if (regenerated.status !== "ready") failures.push(...regenerated.blockedReasons.map(reason => `current_state:${reason}`));
  for (const step of plan.steps) {
    if (step.resource === "server" && !inventory.server.httpsAddresses.includes(recipe.server.httpsAddress)) failures.push(`unverified:${step.id}`);
    if (step.resource === "storage" && !inventory.storagePools.some(pool => isSubset(step.inspect.expected, pool))) failures.push(`unverified:${step.id}`);
    if (step.resource === "network" && !inventory.networks.some(network => isSubset(step.inspect.expected, network))) failures.push(`unverified:${step.id}`);
    if (step.resource === "project" && !inventory.projects.some(project => isSubset(step.inspect.expected, project))) failures.push(`unverified:${step.id}`);
    if (step.resource === "profile" && !inventory.profiles.some(profile => profile.project === recipe.project.name && profile.name === recipe.profile.name && isSubset({ config: recipe.profile.config, devices: recipe.profile.devices }, profile))) failures.push(`unverified:${step.id}`);
    if (step.resource === "trust" && !inventory.trust.some(entry => isSubset(step.inspect.expected, entry))) failures.push(`unverified:${step.id}`);
  }
  return [...new Set(failures)].sort();
}
