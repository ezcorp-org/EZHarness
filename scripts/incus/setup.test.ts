import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INCUS_PROVIDER_ID, incusManifest } from "../../extensions/incus-sandbox/manifest";
import checkedInRecipe from "./recipe.json";
import { digest, type IncusInventory, type IncusSetupPlan, type IncusSetupRecipe } from "./model";
import { applySetupPlan, classifyApplyResult } from "./apply";
import { inspectIncus, verifyKnownHostPin } from "./inspect";
import { createSetupPlan, validateRecipe, verifySetupPlan } from "./plan";
import { guestHelperSha256 } from "../../src/infrastructure/incus-guest/protocol";

const pem = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n";

function recipe(overrides: Partial<IncusSetupRecipe> = {}): IncusSetupRecipe {
  const poolBytes = 100 * 1024 ** 3;
  return {
    schemaVersion: 1,
    id: "incus-fixture",
    version: "1.0.0",
    expected: {
      hostname: "sandbox-server", architecture: "x86_64", incusVersion: "6.0.6", serverCertificateFingerprint: "a".repeat(64),
      sshHostKeySha256: `SHA256:${"A".repeat(43)}`, firewall: "nftables", minimumRootFreeBytes: poolBytes + 1,
      requiredApiExtensions: ["etag", "projects_restrictions"],
    },
    storage: { name: "pool", driver: "lvm", size: "100GiB", sizeBytes: poolBytes, defaultVolumeSize: "16GiB" },
    network: { name: "bridge", project: "default", type: "bridge", config: { "dns.domain": "sandbox.internal", "dns.mode": "managed", "ipv4.address": "10.173.0.1/24", "ipv4.nat": "true", "ipv6.address": "none" } },
    project: { name: "project", description: "Owned", config: {
      "features.images": "false", "features.networks": "false", "features.networks.zones": "false", "features.profiles": "true", "features.storage.buckets": "false", "features.storage.volumes": "true",
      "limits.containers": "4", "limits.cpu": "8", "limits.disk.pool.pool": "80GiB", "limits.memory": "32GiB", "limits.networks": "0", "limits.processes": "4096", "limits.virtual-machines": "0",
      restricted: "true", "restricted.containers.nesting": "allow", "restricted.devices.nic": "managed", "restricted.images.servers": "images.linuxcontainers.org", "restricted.networks.access": "bridge", "restricted.storage-pools.access": "pool", "restricted.virtual-machines.nesting": "block",
    } },
    profile: { name: "compose", description: "Bounded", config: { "limits.cpu": "2", "limits.memory": "8GiB", "limits.memory.enforce": "hard", "limits.processes": "1024", "security.idmap.isolated": "true", "security.nesting": "true", "security.privileged": "false" }, devices: { eth0: { type: "nic", name: "eth0", network: "bridge" }, root: { type: "disk", path: "/", pool: "pool", size: "16GiB" } } },
    server: { httpsAddress: "100.81.181.39:8443" },
    providerClient: { name: "engine", certificateFingerprint: "b".repeat(64), certificatePem: pem, projects: ["project"], restricted: true },
    ...overrides,
  };
}

function inventory(overrides: Partial<IncusInventory> = {}): IncusInventory {
  return {
    schemaVersion: 1,
    capturedAt: "2026-09-22T12:00:00.000Z",
    connection: { sshTarget: "dev@host", sshHostKeySha256: `SHA256:${"A".repeat(43)}` },
    host: { hostname: "sandbox-server", os: "NixOS", kernel: "7.0.3", architecture: "x86_64", cpuThreads: 12, memoryBytes: 64 * 1024 ** 3, rootFreeBytes: 200 * 1024 ** 3, addresses: ["100.81.181.39", "127.0.0.1"], cgroupVersion: "v2", ntpSynchronized: true },
    server: { clientVersion: "6.0.6", serverVersion: "6.0.6", certificateFingerprint: "a".repeat(64), apiStatus: "stable", clustered: false, firewall: "nftables", serviceActive: true, apiExtensions: ["etag", "projects_restrictions"], storageDrivers: [{ name: "lvm", version: "2", remote: false }], httpsAddresses: [] },
    routes: ["100.81.181.39", "172.17.0.0/16", "192.168.0.0/24"], projects: [], storagePools: [], networks: [], profiles: [], instances: [], trust: [],
    ...overrides,
  };
}

function result(exitCode: number, stdout = "", stderr = "") { return { exitCode, stdout, stderr }; }

// Exercise the apply state machine with a ready plan, without changing the real LVM recipe.
function syntheticReadyPlan(): IncusSetupPlan {
  const { planDigest: _planDigest, ...planned } = createSetupPlan(recipe(), inventory());
  const payload = { ...planned, status: "ready" as const, blockedReasons: [] };
  return { ...payload, planDigest: digest(payload) };
}

test("connection metadata must match the actual known-hosts key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "incus-known-host-"));
  try {
    const encodedKey = "AAAAC3NzaC1lZDI1NTE5AAAAIM+s+GddlB2egyYtk02Vnyrzoqr0JQeX0bwgYIfedKwE";
    const fingerprint = createHash("sha256").update(Buffer.from(encodedKey, "base64")).digest("base64").replace(/=+$/, "");
    const knownHosts = join(directory, "known_hosts");
    await writeFile(knownHosts, `host.example ssh-ed25519 ${encodedKey}\n`);
    const connection = { sshTarget: "dev@host.example", sshIdentityFile: "/key", sshKnownHostsFile: knownHosts, sshHostKeySha256: `SHA256:${fingerprint}` };
    await expect(verifyKnownHostPin(connection)).resolves.toBeUndefined();
    await expect(verifyKnownHostPin({ ...connection, sshHostKeySha256: `SHA256:${"A".repeat(43)}` })).rejects.toThrow("does not match");
    const otherKey = Buffer.from(encodedKey, "base64");
    otherKey[otherKey.length - 1] = (otherKey[otherKey.length - 1] ?? 0) ^ 1;
    await writeFile(knownHosts, `host.example ssh-ed25519 ${encodedKey}\nhost.example ssh-ed25519 ${otherKey.toString("base64")}\n`);
    await expect(verifyKnownHostPin(connection)).rejects.toThrow("does not match");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("guest image builder refuses unpinned, mismatched, and changed inputs before launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "incus-image-build-"));
  try {
    const image = checkedInRecipe.guestImage;
    const docker = join(directory, "docker.tgz");
    const compose = join(directory, "compose");
    const helper = join(directory, "helper.py");
    const recipePath = join(directory, "recipe.json");
    await Promise.all([writeFile(docker, "docker"), writeFile(compose, "compose"), writeFile(helper, "helper")]);
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const pins = { ...image, sourceFingerprint: "b".repeat(64), pythonPackageVersion: "3.11.2-6+deb12u1",
      dockerArchiveSha256: hash("docker"), composeSha256: hash("compose"), helperSha256: hash("helper") };
    const args = [recipePath, pins.sourceFingerprint, pins.pythonPackageVersion, docker, pins.dockerArchiveSha256,
      compose, pins.composeSha256, helper, pins.helperSha256, pins.alias];
    const run = () => Bun.spawnSync(["bash", join(import.meta.dir, "build-guest-image.sh"), ...args]);

    await writeFile(recipePath, JSON.stringify({ guestImage: image }));
    expect(run().stderr.toString()).toContain("reviewed recipe pins");

    await writeFile(recipePath, JSON.stringify({ guestImage: pins }));
    args[1] = "c".repeat(64);
    expect(run().stderr.toString()).toContain("reviewed recipe pins");
    args[1] = pins.sourceFingerprint;
    await writeFile(docker, "changed docker");
    expect(run().exitCode).not.toBe(0);

    await writeFile(docker, "docker");
    const incus = join(directory, "incus");
    await writeFile(incus, `#!/bin/sh\nprintf '[{"name":"${pins.alias}"}]\\n'\n`);
    await chmod(incus, 0o755);
    const guarded = Bun.spawnSync(["bash", join(import.meta.dir, "build-guest-image.sh"), ...args],
      { env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` } });
    expect(guarded.stderr.toString()).toContain("image alias already exists");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspection uses a fixed bounded read-only snapshot and drops unneeded server fields", async () => {
  const server = {
    api_status: "stable",
    api_extensions: ["projects_restrictions", "etag"],
    environment: {
      certificate_fingerprint: "a".repeat(64), server_clustered: false, firewall: "nftables",
      storage_supported_drivers: [{ Name: "lvm", Version: "2", Remote: false }],
      addresses: ["100.81.181.39:8443"], private_key: "must-not-be-retained",
    },
  };
  const output = new Map<string, string>([
    ["hostnamectl\0--static", "sandbox-server"], ["cat\0/etc/os-release", 'PRETTY_NAME="NixOS"'], ["uname\0-r", "7.0.3"], ["uname\0-m", "x86_64"],
    ["nproc", "12"], ["getconf\0_PHYS_PAGES", "100"], ["getconf\0PAGESIZE", "4096"], ["df\0-B1\0--output=avail\0/", "Avail\n1000"],
    ["stat\0-f\0-c\0%T\0/sys/fs/cgroup", "cgroup2fs"], ["timedatectl\0show\0--property=NTPSynchronized\0--value", "yes"],
    ["systemctl\0is-active\0incus.service", "active"], ["incus\0version", "Client version: 6.0.6\nServer version: 6.0.6"],
    ["incus\0query\0/1.0", JSON.stringify(server)], ["incus\0project\0list\0--format=json", "[]"], ["incus\0storage\0list\0--format=json", "[]"],
    ["incus\0network\0list\0--all-projects\0--format=json", "[]"], ["incus\0profile\0list\0--all-projects\0--format=json", "[]"],
    ["incus\0list\0--all-projects\0--format=json", "[]"], ["incus\0config\0trust\0list\0--format=json", "[]"],
    ["ip\0-j\0route\0show\0table\0all", JSON.stringify([{ dst: "192.168.0.0/24" }, { dst: "100.81.181.39" }])],
    ["ip\0-j\0address\0show", JSON.stringify([{ ifname: "lo", addr_info: [{ local: "127.0.0.1" }] }, { ifname: "tailscale0", addr_info: [{ local: "100.81.181.39" }] }])],
    ["incus\0image\0list\0--project=default\0--format=json", "[]"],
  ]);
  let active = 0;
  let maximumActive = 0;
  const calls: string[] = [];
  const inspected = await inspectIncus({ sshTarget: "dev@host", sshIdentityFile: "/key", sshKnownHostsFile: "/known-hosts", sshHostKeySha256: `SHA256:${"A".repeat(43)}` }, {
    capturedAt: "2026-09-22T12:00:00.000Z",
    runner: async argv => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await Bun.sleep(1);
      active--;
      const key = argv.join("\0");
      calls.push(key);
      return output.has(key) ? result(0, output.get(key)) : result(127, "", "unexpected command");
    },
  });
  expect(calls).toHaveLength(output.size);
  expect(maximumActive).toBe(4);
  expect(inspected.server.apiExtensions).toEqual(["etag", "projects_restrictions"]);
  expect(inspected.host.addresses).toEqual(["100.81.181.39", "127.0.0.1"]);
  expect(inspected.routes).toEqual(["100.81.181.39", "192.168.0.0/24"]);
  expect(JSON.stringify(inspected)).not.toContain("must-not-be-retained");
});

describe("Incus setup planning", () => {
  test("checked-in recipe matches advertised presets while legacy LVM/16 GiB does not", () => {
    const advertised = incusManifest.sandboxProviders?.find(provider => provider.id === INCUS_PROVIDER_ID)?.presets ?? [];
    expect(advertised.length).toBeGreaterThan(0);
    const compatibleInventory = inventory({ server: { ...inventory().server, storageDrivers: [{ name: "btrfs", version: "6", remote: false }] } });
    const compatible = createSetupPlan(checkedInRecipe as IncusSetupRecipe, compatibleInventory);
    expect(compatible.blockedReasons.some(reason => reason.startsWith("preset_"))).toBe(false);
    expect(compatible.blockedReasons).toContain("guest_image_artifact_unpinned");
    const plan = createSetupPlan(recipe(), inventory());
    expect(plan.status).toBe("blocked");
    for (const preset of advertised) {
      expect(plan.blockedReasons).toContain(`preset_storage_driver_incompatible:${preset.id}:lvm:requires_${[...preset.requirements.storageDrivers].sort().join("_or_")}`);
      expect(plan.blockedReasons).toContain(`preset_root_disk_too_small:${preset.id}:16GiB:requires_20GiB`);
    }
  });

  test("guest image requires reviewed helper, artifact pins and exact installed alias", () => {
    const image = { alias: "ezharness-guest-0-1-0", fingerprint: "a".repeat(64), sourceFingerprint: "b".repeat(64),
      helperSha256: guestHelperSha256(), user: "sandbox" as const, uid: 1000 as const, gid: 1000 as const,
      pythonPackageVersion: "3.11.2-6+deb12u1", dockerArchiveSha256: "c".repeat(64), composeSha256: "d".repeat(64) };
    expect(() => validateRecipe(recipe({ guestImage: { ...image, helperSha256: "e".repeat(64) } }))).toThrow("guest helper source differs");
    const missing = createSetupPlan(recipe({ guestImage: image }), inventory());
    expect(missing.blockedReasons).toContain("guest_image_missing_or_drifted");
    const present = createSetupPlan(recipe({ guestImage: image }), inventory({ images: [{ fingerprint: image.fingerprint, aliases: [image.alias] }] }));
    expect(present.blockedReasons).not.toContain("guest_image_missing_or_drifted");
    const aliasDrift = createSetupPlan(recipe({ guestImage: image }), inventory({ images: [{ fingerprint: image.fingerprint, aliases: ["other"] }] }));
    expect(aliasDrift.blockedReasons).toContain("guest_image_missing_or_drifted");
  });

  test("is deterministic for reordered equivalent inventory and changes on meaningful input", () => {
    const firstInventory = inventory();
    const reordered = inventory({ routes: [...firstInventory.routes].reverse(), server: { ...firstInventory.server, apiExtensions: [...firstInventory.server.apiExtensions].reverse(), storageDrivers: [...firstInventory.server.storageDrivers].reverse() } });
    const first = createSetupPlan(recipe(), firstInventory);
    const second = createSetupPlan(recipe(), reordered);
    expect(first.status).toBe("blocked");
    expect(second.planDigest).toBe(first.planDigest);
    expect(createSetupPlan(recipe({ server: { httpsAddress: "100.81.181.39:9443" } }), firstInventory).planDigest).not.toBe(first.planDigest);
  });

  test("accepts only its own post-create route, reduced free space, and incomplete approved profile", () => {
    const desired = recipe();
    const pool = { name: "pool", driver: "lvm", description: "", config: { size: "100GiB", "lvm.use_thinpool": "true", "volume.size": "16GiB" }, status: "Created" };
    const network = { name: "bridge", project: "default", type: "bridge", managed: true, description: "", config: desired.network.config, status: "Created" };
    const partialProfile = { name: "compose", project: "project", description: "Bounded", config: { "limits.cpu": "2" }, devices: {} };
    const current = inventory({ host: { ...inventory().host, rootFreeBytes: 50 * 1024 ** 3 },
      storagePools: [pool], networks: [network], profiles: [partialProfile],
      routes: ["10.173.0.0/24"], routeBindings: [{ destination: "10.173.0.0/24", device: "bridge" }] });
    const plan = createSetupPlan(desired, current);
    expect(plan.blockedReasons).not.toContain("insufficient_root_capacity");
    expect(plan.blockedReasons).not.toContain("network_route_conflict:10.173.0.0/24");
    expect(plan.blockedReasons).not.toContain("profile_drift");
    expect(createSetupPlan(desired, { ...current, routeBindings: [{ destination: "10.173.0.0/24", device: "other0" }] }).blockedReasons)
      .toContain("network_route_conflict:10.173.0.0/24");
    expect(createSetupPlan(desired, { ...current, profiles: [{ ...partialProfile, config: { "limits.cpu": "99" } }] }).blockedReasons)
      .toContain("profile_drift");
  });

  test("fails closed on identity, capability, route and existing-resource drift", () => {
    expect(createSetupPlan(recipe(), inventory({ connection: { sshTarget: "dev@host", sshHostKeySha256: `SHA256:${"B".repeat(43)}` } })).blockedReasons).toContain("ssh_host_key_changed");
    expect(createSetupPlan(recipe(), inventory({ server: { ...inventory().server, apiExtensions: ["etag"] } })).blockedReasons).toContain("missing_api_extension:projects_restrictions");
    expect(createSetupPlan(recipe(), inventory({ routes: ["10.173.0.0/25", "100.81.181.39"] })).blockedReasons).toContain("network_route_conflict:10.173.0.0/25");
    expect(createSetupPlan(recipe(), inventory({ host: { ...inventory().host, addresses: ["127.0.0.1"] } })).blockedReasons).toContain("https_bind_address_missing");
    expect(createSetupPlan(recipe(), inventory({ host: { ...inventory().host, cpuThreads: 4 } })).blockedReasons).toContain("resource_limits_exceed_host");
    expect(createSetupPlan(recipe(), inventory({ storagePools: [{ name: "pool", driver: "dir", description: "foreign", config: {}, status: "Created" }] })).blockedReasons).toContain("storage_pool_drift");
    expect(createSetupPlan(recipe(), inventory({ instances: [{ name: "foreign", project: "default", status: "Running", type: "container" }] })).blockedReasons).toContain("instances_present");
    expect(createSetupPlan(recipe(), inventory({ trust: [{ fingerprint: "c".repeat(64), name: "foreign", restricted: false, projects: [], type: "client" }] })).blockedReasons).toContain("unexpected_trust_entry");
    const desiredProject = recipe().project;
    expect(createSetupPlan(recipe(), inventory({ projects: [{ ...desiredProject, config: { ...desiredProject.config, "restricted.devices.unix-char": "allow" } }] })).blockedReasons).toContain("project_drift");
  });

  test("requires a pinned scoped provider certificate and rejects loose recipe fields", () => {
    const { providerClient: _providerClient, ...withoutClient } = recipe();
    expect(createSetupPlan(withoutClient, inventory()).blockedReasons).toContain("provider_client_certificate_missing");
    expect(() => validateRecipe(recipe({ providerClient: { ...recipe().providerClient!, projects: ["other"] } }))).toThrow("restricted to the setup project");
    expect(() => validateRecipe(recipe({ network: { ...recipe().network, config: { ...recipe().network.config, "ipv4.address": "auto" } } }))).toThrow("pin an IPv4 CIDR");
    expect(() => validateRecipe(recipe({ profile: { ...recipe().profile, config: { ...recipe().profile.config, "raw.lxc": "lxc.apparmor.profile=unconfined" } } }))).toThrow("unsupported fields");
  });
});

describe("Incus setup application", () => {
  test("does not inspect or apply the incompatible recipe", async () => {
    const plan = createSetupPlan(recipe(), inventory());
    let calls = 0;
    const receipt = await applySetupPlan(plan, async () => { calls++; return result(0); }, { execute: true, approvedPlanDigest: plan.planDigest });
    expect(receipt.state).toBe("blocked");
    expect(calls).toBe(0);
  });

  test("dry-run executes no mutation and reports every absent step", async () => {
    const plan = syntheticReadyPlan();
    const calls: string[][] = [];
    const receipt = await applySetupPlan(plan, async argv => { calls.push([...argv]); return result(1, "", "not found"); });
    expect(receipt.state).toBe("dry_run");
    expect(receipt.steps.every(step => step.action === "planned")).toBe(true);
    expect(calls).toEqual(plan.steps.map(step => step.inspect.argv));
    expect(calls.some(call => plan.steps.some(step => step.apply.argv === call))).toBe(false);
  });

  test("matching resources are idempotently skipped", async () => {
    const plan = syntheticReadyPlan();
    const byCommand = new Map(plan.steps.map(step => [step.inspect.argv.join("\0"), typeof step.inspect.expected === "string" ? step.inspect.expected : JSON.stringify(step.inspect.expected)]));
    const receipt = await applySetupPlan(plan, async argv => result(0, byCommand.get(argv.join("\0")) ?? ""));
    expect(receipt.state).toBe("dry_run");
    expect(receipt.steps.every(step => step.action === "skipped")).toBe(true);
  });

  test("drift and unapproved execution stop before any effect", async () => {
    const plan = syntheticReadyPlan();
    let calls = 0;
    const drift = await applySetupPlan(plan, async () => { calls++; return result(0, JSON.stringify({ name: "foreign" })); });
    expect(drift.state).toBe("review_required");
    expect(calls).toBe(1);
    await expect(applySetupPlan(plan, async () => result(1), { execute: true, approvedPlanDigest: "wrong" })).rejects.toThrow("exact approved plan digest");
    const changedHost = createSetupPlan(recipe(), inventory({ host: { ...inventory().host, cpuThreads: 4 } }));
    const blocked = await applySetupPlan(plan, async () => result(1), { preflightPlan: changedHost });
    expect(blocked.state).toBe("blocked");
    expect(blocked.blockedReasons).toContain("resource_limits_exceed_host");
  });

  test("an approved effect is inspected afterward and uncertain failures are never repeated", async () => {
    const plan = syntheticReadyPlan();
    const first = plan.steps[0]!;
    const oneStep = { ...plan, steps: [first] };
    const { planDigest: _old, ...payload } = oneStep;
    oneStep.planDigest = (await import("./model")).digest(payload);
    let inspections = 0;
    let effects = 0;
    const receipt = await applySetupPlan(oneStep, async argv => {
      if (argv === first.apply.argv) { effects++; return result(0); }
      inspections++;
      return inspections === 1 ? result(1, "", "not found") : result(0, JSON.stringify(first.inspect.expected));
    }, { execute: true, approvedPlanDigest: oneStep.planDigest });
    expect(receipt.state).toBe("applied");
    expect({ inspections, effects }).toEqual({ inspections: 2, effects: 1 });

    let uncertainEffects = 0;
    inspections = 0;
    const uncertain = await applySetupPlan(oneStep, async argv => {
      if (argv === first.apply.argv) { uncertainEffects++; return { exitCode: 255, stdout: "", stderr: "connection closed", timedOut: true }; }
      return result(1, "", "not found");
    }, { execute: true, approvedPlanDigest: oneStep.planDigest });
    expect(uncertain.state).toBe("reconcile_required");
    expect(uncertainEffects).toBe(1);
  });

  test("classifies only bounded transient failures as retryable", () => {
    expect(classifyApplyResult({ exitCode: 255, stdout: "", stderr: "connection reset" })).toBe("reconcile");
    expect(classifyApplyResult(result(1, "", "resource already exists"))).toBe("reconcile");
    expect(classifyApplyResult(result(1, "", "server is busy; try again"))).toBe("retryable");
    expect(classifyApplyResult(result(1, "", "permission denied"))).toBe("review_required");
  });
});

test("verification names every missing postcondition", () => {
  const setupRecipe = recipe();
  const plan = createSetupPlan(setupRecipe, inventory());
  const failures = verifySetupPlan(plan, setupRecipe, inventory());
  expect(failures).toContain("unverified:storage-pool");
  expect(failures).toContain("unverified:managed-network");
  expect(failures).toContain("unverified:restricted-project");
  expect(failures).toContain("unverified:compose-profile");
  expect(failures).toContain("unverified:https-listener");
  expect(failures).toContain("unverified:provider-client");
});
