import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INCUS_PROVIDER_ID, incusManifest } from "../../extensions/incus-sandbox/manifest";
import checkedInRecipe from "./recipe.json";
import imageBuildTemplate from "./recipe.template.json";
import { digest, type IncusInventory, type IncusSetupPlan, type IncusSetupRecipe } from "./model";
import { applyImageBootstrapPlan, applySetupPlan, classifyApplyResult, inspectStep } from "./apply";
import { inspectIncus, verifyKnownHostPin } from "./inspect";
import { createImageBootstrapPlan, createSetupPlan, validateRecipe, verifyImageBootstrapPlan, verifySetupPlan } from "./plan";
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
      restricted: "true", "restricted.containers.nesting": "allow", "restricted.devices.nic": "managed", "restricted.images.servers": ",", "restricted.networks.access": "bridge",
    } },
    profile: { name: "compose", description: "Bounded", config: { "limits.cpu": "2", "limits.memory": "8GiB", "limits.memory.enforce": "hard", "limits.processes": "1024", "security.idmap.isolated": "true", "security.nesting": "true", "security.privileged": "false" }, devices: { eth0: { type: "nic", name: "eth0", network: "bridge", "security.port_isolation": "true" }, root: { type: "disk", path: "/", pool: "pool", size: "16GiB" } } },
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

function bootstrapInventory(overrides: Partial<IncusInventory> = {}): IncusInventory {
  const reviewed = checkedInRecipe as IncusSetupRecipe;
  const base = inventory();
  return inventory({
    connection: { ...base.connection, sshHostKeySha256: reviewed.expected.sshHostKeySha256 },
    host: { ...base.host, hostname: reviewed.expected.hostname, rootFreeBytes: reviewed.expected.minimumRootFreeBytes + 1024 ** 3 },
    server: { ...base.server, certificateFingerprint: reviewed.expected.serverCertificateFingerprint,
      storageDrivers: [{ name: reviewed.storage.driver, version: "6", remote: false }], apiExtensions: reviewed.expected.requiredApiExtensions },
    ...overrides,
  });
}

describe("Incus image bootstrap", () => {
  test("plans only the pinned pool and bridge while full setup stays blocked", async () => {
    const reviewed = checkedInRecipe as IncusSetupRecipe;
    const current = bootstrapInventory();
    const bootstrap = createImageBootstrapPlan(reviewed, current);
    expect(bootstrap.status).toBe("ready");
    expect(bootstrap.steps.map(step => step.id)).toEqual(["storage-pool", "managed-network"]);
    expect(bootstrap.steps.map(step => step.resource)).toEqual(["storage", "network"]);
    expect(createImageBootstrapPlan(reviewed, { ...current, routes: [...current.routes].reverse() }).planDigest).toBe(bootstrap.planDigest);
    expect(createSetupPlan(reviewed, current).status).toBe("blocked");
    expect(createSetupPlan(reviewed, current).blockedReasons).toContain("guest_image_missing_or_drifted");
    expect(createSetupPlan(reviewed, current).blockedReasons).toContain("provider_client_certificate_missing");
    await expect(applySetupPlan(bootstrap, async () => result(1))).rejects.toThrow("image bootstrap plan");
  });

  test("blocks host, pin, route, resource, and approved baseline drift before effects", async () => {
    const reviewed = checkedInRecipe as IncusSetupRecipe;
    const current = bootstrapInventory();
    const approved = createImageBootstrapPlan(reviewed, current);
    const variants = [
      bootstrapInventory({ connection: { ...current.connection, sshTarget: "other@host" } }),
      bootstrapInventory({ server: { ...current.server, certificateFingerprint: "f".repeat(64) } }),
      bootstrapInventory({ host: { ...current.host, rootFreeBytes: 1 } }),
      bootstrapInventory({ routes: [...current.routes, "10.173.0.0/24"] }),
      bootstrapInventory({ storagePools: [{ name: reviewed.storage.name, driver: "dir", description: "foreign", config: {}, status: "Created" }] }),
      bootstrapInventory({ networks: [{ name: reviewed.network.name, project: "default", type: "bridge", managed: true, description: "", config: { "ipv4.address": "10.9.0.1/24" }, status: "Created" }] }),
    ];
    for (const changed of variants) {
      let effects = 0;
      const receipt = await applyImageBootstrapPlan(approved, async argv => { if (argv.includes("create")) effects++; return result(1); },
        { execute: true, approvedPlanDigest: approved.planDigest, preflightPlan: createImageBootstrapPlan(reviewed, changed) });
      expect(receipt.state).toBe("blocked");
      expect(effects).toBe(0);
    }
    const changedSteps = [{ ...approved.steps[0]!, apply: { argv: ["incus", "storage", "delete", reviewed.storage.name] } }, approved.steps[1]!];
    const { planDigest: _oldDigest, ...payload } = approved;
    const changedPayload = { ...payload, steps: changedSteps };
    const forged = { ...changedPayload, planDigest: digest(changedPayload) };
    const rejected = await applyImageBootstrapPlan(forged, async () => { throw new Error("must not run"); },
      { execute: true, approvedPlanDigest: forged.planDigest, preflightPlan: createImageBootstrapPlan(reviewed, current) });
    expect(rejected.state).toBe("blocked");
    expect(rejected.blockedReasons).toContain("bootstrap_preflight_drift");
  });

  test("dry run, exact approval, and readback stop adoption on replay", async () => {
    const reviewed = checkedInRecipe as IncusSetupRecipe;
    const approved = createImageBootstrapPlan(reviewed, bootstrapInventory());
    const present = new Map<string, unknown>();
    let effects = 0;
    const runner = async (argv: readonly string[]) => {
      const step = approved.steps.find(item => item.inspect.argv.join("\0") === argv.join("\0"));
      if (step) return present.has(step.id) ? result(0, JSON.stringify(present.get(step.id))) : result(1, "", "not found");
      const effect = approved.steps.find(item => item.apply.argv.join("\0") === argv.join("\0"));
      if (!effect) throw new Error("unapproved command");
      effects++;
      present.set(effect.id, effect.inspect.expected);
      return result(0);
    };
    const dry = await applyImageBootstrapPlan(approved, runner, { preflightPlan: approved });
    expect(dry.state).toBe("dry_run");
    expect(effects).toBe(0);
    await expect(applyImageBootstrapPlan(approved, runner, { execute: true, approvedPlanDigest: "wrong", preflightPlan: approved })).rejects.toThrow("exact approved plan digest");
    const first = await applyImageBootstrapPlan(approved, runner, { execute: true, approvedPlanDigest: approved.planDigest, preflightPlan: approved });
    expect(first.state).toBe("applied");
    expect(effects).toBe(2);
    const original = bootstrapInventory();
    const current = bootstrapInventory({
      host: { ...original.host, rootFreeBytes: original.host.rootFreeBytes - reviewed.storage.sizeBytes },
      storagePools: [{ ...(present.get("storage-pool") as IncusInventory["storagePools"][number]), description: "", status: "Created" }],
      networks: [{ ...(present.get("managed-network") as IncusInventory["networks"][number]), description: "", status: "Created" }],
      routes: [...original.routes, "10.173.0.0/24"], routeBindings: [{ destination: "10.173.0.0/24", device: reviewed.network.name }],
    });
    const replay = await applyImageBootstrapPlan(approved, runner, { execute: true, approvedPlanDigest: approved.planDigest, preflightPlan: createImageBootstrapPlan(reviewed, current) });
    expect(replay.state).toBe("blocked");
    expect(replay.blockedReasons).toContain("bootstrap_target_ownership_changed");
    expect(effects).toBe(2);
    const partial = { ...current, networks: [], routes: original.routes, routeBindings: [] };
    const partialReplay = await applyImageBootstrapPlan(approved, runner, { execute: true, approvedPlanDigest: approved.planDigest, preflightPlan: createImageBootstrapPlan(reviewed, partial) });
    expect(partialReplay.state).toBe("blocked");
    expect(partialReplay.blockedReasons).toContain("bootstrap_target_ownership_changed");
    expect(effects).toBe(2);
  });

  test("preserves reviewed existing targets and catches a target appearing after preflight", async () => {
    const reviewed = checkedInRecipe as IncusSetupRecipe;
    const absent = createImageBootstrapPlan(reviewed, bootstrapInventory());
    let effects = 0;
    const lateArrival = await applyImageBootstrapPlan(absent, async argv => {
      if (argv.includes("create")) effects++;
      return result(0, JSON.stringify(absent.steps[0]!.inspect.expected));
    }, { execute: true, approvedPlanDigest: absent.planDigest, preflightPlan: absent });
    expect(lateArrival.state).toBe("review_required");
    expect(effects).toBe(0);
    let storageInspections = 0;
    const lateBridge = await applyImageBootstrapPlan(absent, async argv => {
      const step = absent.steps.find(item => item.inspect.argv.join("\0") === argv.join("\0"));
      if (step?.id === "storage-pool") return storageInspections++ === 0 ? result(1, "", "not found") : result(0, JSON.stringify(step.inspect.expected));
      if (step?.id === "managed-network") return result(0, JSON.stringify(step.inspect.expected));
      if (argv.join("\0") === absent.steps[0]!.apply.argv.join("\0")) {
        effects++;
        return result(0);
      }
      throw new Error("unexpected command");
    }, { execute: true, approvedPlanDigest: absent.planDigest, preflightPlan: absent });
    expect(lateBridge.state).toBe("review_required");
    expect(effects).toBe(1);
    effects = 0;

    const original = bootstrapInventory();
    const existing = bootstrapInventory({
      host: { ...original.host, rootFreeBytes: original.host.rootFreeBytes - reviewed.storage.sizeBytes },
      storagePools: [{ ...(absent.steps[0]!.inspect.expected as IncusInventory["storagePools"][number]), description: "", status: "Created" }],
      networks: [{ ...(absent.steps[1]!.inspect.expected as IncusInventory["networks"][number]), description: "", status: "Created" }],
      routes: [...original.routes, "10.173.0.0/24"], routeBindings: [{ destination: "10.173.0.0/24", device: reviewed.network.name }],
    });
    const approvedExisting = createImageBootstrapPlan(reviewed, existing);
    expect(approvedExisting.status).toBe("ready");
    const skipped = await applyImageBootstrapPlan(approvedExisting, async argv => {
      if (argv.includes("create")) { effects++; throw new Error("unexpected effect"); }
      const step = approvedExisting.steps.find(item => item.inspect.argv.join("\0") === argv.join("\0"));
      if (!step) throw new Error("unexpected inspection");
      return result(0, JSON.stringify(step.inspect.expected));
    }, { execute: true, approvedPlanDigest: approvedExisting.planDigest, preflightPlan: createImageBootstrapPlan(reviewed, existing) });
    expect(skipped.state).toBe("applied");
    expect(skipped.steps.map(step => step.action)).toEqual(["skipped", "skipped"]);
    expect(effects).toBe(0);
  });

  test("verifies completed apply with only the bridge gateway and its three owned routes normalized", async () => {
    const reviewed = checkedInRecipe as IncusSetupRecipe;
    const before = bootstrapInventory();
    const approved = createImageBootstrapPlan(reviewed, before);
    const observed = new Set<string>();
    const receipt = await applyImageBootstrapPlan(approved, async argv => {
      const step = approved.steps.find(item => item.inspect.argv.join("\0") === argv.join("\0"));
      if (step) return observed.has(step.id) ? result(0, JSON.stringify(step.inspect.expected)) : result(1, "", "not found");
      const effect = approved.steps.find(item => item.apply.argv.join("\0") === argv.join("\0"));
      if (!effect) throw new Error("unexpected command");
      observed.add(effect.id);
      return result(0);
    }, { execute: true, approvedPlanDigest: approved.planDigest, preflightPlan: approved });
    expect(receipt.state).toBe("applied");
    const bridgeRoutes = ["10.173.0.0/24", "10.173.0.1", "10.173.0.255"];
    const after = bootstrapInventory({
      host: { ...before.host, rootFreeBytes: before.host.rootFreeBytes - reviewed.storage.sizeBytes,
        addresses: [...before.host.addresses, "10.173.0.1"] },
      storagePools: [{ ...(approved.steps[0]!.inspect.expected as IncusInventory["storagePools"][number]), description: "", status: "Created" }],
      networks: [{ ...(approved.steps[1]!.inspect.expected as IncusInventory["networks"][number]), description: "", status: "Created" }],
      routes: [...before.routes, ...bridgeRoutes],
      routeBindings: bridgeRoutes.map(destination => ({ destination, device: reviewed.network.name })),
    });
    expect(verifyImageBootstrapPlan(approved, reviewed, after)).toEqual([]);
    expect(verifyImageBootstrapPlan(approved, reviewed, { ...after, routes: [...after.routes, "10.173.0.2"],
      routeBindings: [...after.routeBindings!, { destination: "10.173.0.2", device: reviewed.network.name }] })).toContain("bootstrap_plan_drift");
    expect(verifyImageBootstrapPlan(approved, reviewed, { ...after, host: { ...after.host, addresses: [...after.host.addresses, "10.173.0.2"] } })).toContain("bootstrap_plan_drift");
  });

  test("uncertain effect stops and requires fresh reconciliation", async () => {
    const approved = createImageBootstrapPlan(checkedInRecipe as IncusSetupRecipe, bootstrapInventory());
    let effects = 0;
    const receipt = await applyImageBootstrapPlan(approved, async argv => {
      if (argv.includes("create")) { effects++; return { exitCode: 255, stdout: "", stderr: "connection closed", timedOut: true }; }
      return result(1, "", "not found");
    }, { execute: true, approvedPlanDigest: approved.planDigest, preflightPlan: approved });
    expect(receipt.state).toBe("reconcile_required");
    expect(effects).toBe(1);
    const thrown = await applyImageBootstrapPlan(approved, async argv => {
      if (argv.includes("create")) throw new Error("SSH process disappeared");
      return result(1, "", "not found");
    }, { execute: true, approvedPlanDigest: approved.planDigest, preflightPlan: approved });
    expect(thrown.state).toBe("reconcile_required");
    expect(thrown.steps[0]?.outcome).toBe("reconcile");
  });
});

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
    expect(run().stderr.toString()).toContain("build storage or network does not match the reviewed recipe");

    await writeFile(recipePath, JSON.stringify({ guestImage: pins,
      storage: checkedInRecipe.storage, network: checkedInRecipe.network, profile: checkedInRecipe.profile }));
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

    const launchCapture = join(directory, "launch-args");
    await writeFile(incus, `#!/bin/sh
if [ "$1" = image ]; then printf '[]\\n'; exit 0; fi
if [ "$1" = launch ]; then printf '%s\\n' "$@" > "$EZH_LAUNCH_CAPTURE"; exit 37; fi
exit 0
`);
    const launched = Bun.spawnSync(["bash", join(import.meta.dir, "build-guest-image.sh"), ...args],
      { env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}`, EZH_LAUNCH_CAPTURE: launchCapture } });
    expect(launched.exitCode).toBe(37);
    const launchArgs = (await readFile(launchCapture, "utf8")).trim().split("\n");
    expect(launchArgs).toContain("--storage");
    expect(launchArgs[launchArgs.indexOf("--storage") + 1]).toBe(checkedInRecipe.storage.name);
    expect(launchArgs).toContain("--network");
    expect(launchArgs[launchArgs.indexOf("--network") + 1]).toBe(checkedInRecipe.network.name);
    expect(launchArgs).toContain("security.nesting=true");
    expect(launchArgs).toContain("security.idmap.isolated=true");
    expect(launchArgs).toContain("security.privileged=false");

    const capture = join(directory, "build-calls");
    await writeFile(incus, `#!/bin/sh
case "$1" in
  image) printf '[]\\n';;
  launch|file|delete) exit 0;;
  exec)
    shift
    while [ "$1" != -- ]; do shift; done
    shift
    if [ "$1" = env ]; then printf '%s\\n' "$*" >> "$EZH_BUILD_CAPTURE"; exit 39; fi
    case "$4" in *'/etc/os-release'*) exit 0;; esac
    guest_script=$(printf '%s\\n' "$4" | sed "s#/etc/apt#$EZH_APT_ROOT#g")
    sh -eu -c "$guest_script" sh "$6";;
esac
`);
    const aptRoot = join(directory, "apt");
    await mkdir(join(aptRoot, "sources.list.d"), { recursive: true });
    await writeFile(join(aptRoot, "sources.list.d", "debian.sources"), "Types: deb\nURIs: http://mirror.example/debian\nSuites: stable\nComponents: main\n");
    await writeFile(join(directory, "ip"), "#!/bin/sh\nif [ \"$EZH_IPV4\" = yes ]; then printf '2: eth0 inet 10.173.0.2/24 scope global eth0\\n'; fi\n");
    await writeFile(join(directory, "getent"), "#!/bin/sh\n[ \"$EZH_DNS\" = yes ]\n");
    await writeFile(join(directory, "sleep"), "#!/bin/sh\nexit 0\n");
    await Promise.all(["ip", "getent", "sleep"].map(file => chmod(join(directory, file), 0o755)));
    const networkRun = (ipv4: string, dns: string) => Bun.spawnSync(["bash", join(import.meta.dir, "build-guest-image.sh"), ...args],
      { env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}`, EZH_IPV4: ipv4, EZH_DNS: dns, EZH_BUILD_CAPTURE: capture, EZH_APT_ROOT: aptRoot } });
    const noIpv4 = networkRun("no", "yes");
    expect(noIpv4.stderr.toString()).toContain(`no global IPv4 on eth0; check DHCP and host firewall rules for reviewed bridge ${checkedInRecipe.network.name}`);
    expect(noIpv4.stderr.toString()).toContain("image build stopped before APT");
    const noDns = networkRun("yes", "no");
    expect(noDns.stderr.toString()).toContain(`DNS cannot resolve configured APT mirror mirror.example; check DNS and host firewall rules for reviewed bridge ${checkedInRecipe.network.name}`);
    expect(await Bun.file(capture).exists()).toBe(false);
    const ready = networkRun("yes", "yes");
    expect(ready.exitCode).toBe(39);
    expect(await readFile(capture, "utf8")).toContain("apt-get update");

    const published = "a".repeat(64);
    const aliasCounter = join(directory, "alias-count");
    const publishMarker = join(directory, "published-marker");
    const hygieneScript = join(directory, "hygiene-script");
    const serviceScript = join(directory, "service-script");
    await writeFile(incus, `#!/bin/sh
case "$1" in
  image)
    if [ "$2" = alias ]; then
      count=$(cat "$EZH_ALIAS_COUNT")
      count=$((count + 1))
      printf '%s\\n' "$count" > "$EZH_ALIAS_COUNT"
      if [ "$EZH_SECOND_ALIAS" = yes ] && [ "$count" -eq 2 ]; then printf '[{"name":"%s"}]\\n' "$EZH_ALIAS"; else printf '[]\\n'; fi
    elif [ "$2" = list ]; then
      if [ ! -f "$EZH_PUBLISH_MARKER" ]; then printf '[]\\n'
      elif [ "$EZH_QUERY_MODE" = no_new ]; then printf '[]\\n'
      elif [ "$EZH_QUERY_MODE" = ambiguous ]; then printf '[{"fingerprint":"%s"},{"fingerprint":"%s"}]\\n' "$EZH_PUBLISHED" "$EZH_WRONG_TARGET"
      else printf '[{"fingerprint":"%s"}]\\n' "$EZH_PUBLISHED"; fi
    fi;;
  launch|file|delete) exit 0;;
  stop) printf 'stop\\n' >> "$EZH_BUILD_CAPTURE"; exit 0;;
  exec)
    shift
    while [ "$1" != -- ]; do shift; done
    shift
    if [ "$1" = env ]; then printf '%s\\n' "$*" >> "$EZH_BUILD_CAPTURE"; exit 0; fi
    case "$4" in
      *'guest has no APT source files'*) guest_script=$(printf '%s\\n' "$4" | sed "s#/etc/apt#$EZH_APT_ROOT#g"); sh -eu -c "$guest_script" sh "$6";;
      *'/etc/os-release'*) exit 0;;
      *'ExecStart=/usr/local/bin/dockerd'*) printf '%s\\n' "$4" > "$EZH_SERVICE_SCRIPT"; exit 0;;
      *'setpriv --reuid=1000 --regid=1000 --clear-groups'*) printf 'sandbox-docker-check\\n' >> "$EZH_BUILD_CAPTURE"; [ "$EZH_SANDBOX_DOCKER_READY" = yes ];;
      *'docker info'*) printf 'docker-check\\n' >> "$EZH_BUILD_CAPTURE"; [ "$EZH_DOCKER_READY" = yes ];;
      *'rm -rf -- /var/lib/docker /var/lib/containerd'*) printf 'hygiene\\n' >> "$EZH_BUILD_CAPTURE"; printf '%s\\n' "$4" > "$EZH_HYGIENE_SCRIPT"; [ "$EZH_HYGIENE_READY" = yes ];;
      *) exit 0;;
    esac;;
  publish)
    printf 'publish %s\\n' "$*" >> "$EZH_BUILD_CAPTURE"
    touch "$EZH_PUBLISH_MARKER"
    printf 'Instance published with fingerprint: %s\\n' "$EZH_PUBLISHED" >&2;;
  query)
    endpoint=
    for argument in "$@"; do endpoint=$argument; done
    if [ "$2" = -X ]; then
      printf 'retention %s\\n' "$*" >> "$EZH_BUILD_CAPTURE"
      [ "$EZH_QUERY_MODE" != retention_fails ]; exit $?
    fi
    case "$endpoint" in
      /1.0/images/aliases/*)
        if [ "$EZH_QUERY_MODE" = alias_changed ] && grep -q '^retention ' "$EZH_BUILD_CAPTURE"; then
          printf '{"description":"","name":"%s","target":"%s","type":"container"}\\n' "$EZH_ALIAS" "$EZH_WRONG_TARGET"
          exit 0
        fi
        case "$EZH_QUERY_MODE" in
          missing) printf '{"description":"","name":"%s","type":"container"}\\n' "$EZH_ALIAS";;
          wrong) printf '{"description":"","name":"%s","target":"%s","type":"container"}\\n' "$EZH_ALIAS" "$EZH_WRONG_TARGET";;
          *) printf '{"description":"","name":"%s","target":"%s","type":"container"}\\n' "$EZH_ALIAS" "$EZH_PUBLISHED";;
        esac;;
      *)
        if [ "$EZH_QUERY_MODE" = expiring ] || ! grep -q '^retention ' "$EZH_BUILD_CAPTURE"; then expiry=2026-10-23T00:00:00Z
        else expiry=2099-12-31T00:00:00Z; fi
        printf '{"fingerprint":"%s","expires_at":"%s","public":false,"auto_update":false,"properties":{"os":"Debian"},"profiles":["default"]}\\n' "$EZH_PUBLISHED" "$expiry";;
    esac;;
esac
`);
    const publishRun = async (mode: string, secondAlias = false, dockerReady = true, hygieneReady = true, sandboxDockerReady = true) => {
      await Promise.all([writeFile(aliasCounter, "0\n"), writeFile(capture, ""), rm(publishMarker, { force: true })]);
      const runResult = Bun.spawnSync(["bash", join(import.meta.dir, "build-guest-image.sh"), ...args],
        { env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}`, EZH_IPV4: "yes", EZH_DNS: "yes",
          EZH_APT_ROOT: aptRoot, EZH_BUILD_CAPTURE: capture, EZH_ALIAS_COUNT: aliasCounter, EZH_ALIAS: pins.alias,
          EZH_SECOND_ALIAS: secondAlias ? "yes" : "no", EZH_DOCKER_READY: dockerReady ? "yes" : "no",
          EZH_SANDBOX_DOCKER_READY: sandboxDockerReady ? "yes" : "no",
          EZH_HYGIENE_READY: hygieneReady ? "yes" : "no", EZH_HYGIENE_SCRIPT: hygieneScript, EZH_SERVICE_SCRIPT: serviceScript,
          EZH_PUBLISHED: published, EZH_WRONG_TARGET: "b".repeat(64), EZH_QUERY_MODE: mode,
          EZH_PUBLISH_MARKER: publishMarker } });
      return { runResult, calls: await readFile(capture, "utf8") };
    };
    const directAlias = await publishRun("direct");
    expect(directAlias.runResult.exitCode).toBe(0);
    expect(directAlias.runResult.stdout.toString().trim()).toBe(published);
    expect(directAlias.calls).toContain("publish");
    expect(directAlias.calls).toContain("iptables=1.8.9-2");
    expect(directAlias.calls).toContain("nftables=1.0.6-2+deb12u2");
    expect(directAlias.calls).toContain("docker-check");
    expect(directAlias.calls).toContain("sandbox-docker-check");
    expect(directAlias.calls).toContain("hygiene");
    const stages = directAlias.calls.trim().split("\n");
    expect(stages.indexOf("docker-check")).toBeLessThan(stages.indexOf("sandbox-docker-check"));
    expect(stages.indexOf("sandbox-docker-check")).toBeLessThan(stages.indexOf("hygiene"));
    const installedService = await readFile(serviceScript, "utf8");
    expect(installedService).toContain("--group=sandbox --storage-driver=vfs");
    expect(installedService).not.toContain("usermod -aG docker sandbox");
    expect(stages.indexOf("hygiene")).toBeLessThan(stages.indexOf("stop"));
    expect(stages.indexOf("stop")).toBeLessThan(stages.findIndex(stage => stage.startsWith("publish ")));
    const cleanup = await readFile(hygieneScript, "utf8");
    expect(cleanup).toContain("systemctl stop ezh-docker.service ezh-containerd.service");
    expect(cleanup).toContain("rm -rf -- /var/lib/docker /var/lib/containerd");
    expect(cleanup).toContain(": > /etc/machine-id");
    expect(cleanup).toContain("ln -s /etc/machine-id /var/lib/dbus/machine-id");
    expect(directAlias.calls).toContain("--expire 2099-12-31T00:00:00Z");
    expect(directAlias.calls).toContain('retention query -X PUT -d {"public":false,"auto_update":false,"properties":{"os":"Debian"},"profiles":["default"],"expires_at":"2099-12-31T00:00:00Z"}');
    expect(directAlias.calls.indexOf("publish")).toBeLessThan(directAlias.calls.indexOf("retention query"));
    const wrongTarget = await publishRun("wrong");
    expect(wrongTarget.runResult.exitCode).not.toBe(0);
    expect(wrongTarget.runResult.stderr.toString()).toContain("alias target differs from the published fingerprint");
    expect(wrongTarget.calls).not.toContain("retention query");
    const missingTarget = await publishRun("missing");
    expect(missingTarget.runResult.exitCode).not.toBe(0);
    expect(missingTarget.runResult.stderr.toString()).toContain("alias has no exact fingerprint target");
    const expiring = await publishRun("expiring");
    expect(expiring.runResult.exitCode).not.toBe(0);
    expect(expiring.runResult.stderr.toString()).toContain("durable retention readback differs");
    const noNew = await publishRun("no_new");
    expect(noNew.runResult.exitCode).not.toBe(0);
    expect(noNew.runResult.stderr.toString()).toContain("exactly one new fingerprint");
    expect(noNew.calls).not.toContain("retention query");
    const ambiguous = await publishRun("ambiguous");
    expect(ambiguous.runResult.exitCode).not.toBe(0);
    expect(ambiguous.runResult.stderr.toString()).toContain("exactly one new fingerprint");
    expect(ambiguous.calls).not.toContain("retention query");
    const retentionFails = await publishRun("retention_fails");
    expect(retentionFails.runResult.exitCode).not.toBe(0);
    const aliasChanged = await publishRun("alias_changed");
    expect(aliasChanged.runResult.exitCode).not.toBe(0);
    expect(aliasChanged.runResult.stderr.toString()).toContain("alias changed during retention update");
    const appearedAlias = await publishRun("direct", true);
    expect(appearedAlias.runResult.exitCode).not.toBe(0);
    expect(appearedAlias.runResult.stderr.toString()).toContain("image alias already exists");
    expect(appearedAlias.calls).not.toContain("publish");
    const failedDocker = await publishRun("direct", false, false);
    expect(failedDocker.runResult.exitCode).not.toBe(0);
    expect(failedDocker.runResult.stderr.toString()).toContain("nested Docker daemon did not become ready");
    expect(failedDocker.calls).toContain("docker-check");
    expect(failedDocker.calls).not.toContain("hygiene");
    expect(failedDocker.calls).not.toContain("publish");
    const failedSandboxDocker = await publishRun("direct", false, true, true, false);
    expect(failedSandboxDocker.runResult.exitCode).not.toBe(0);
    expect(failedSandboxDocker.runResult.stderr.toString()).toContain("sandbox identity cannot access the nested Docker socket");
    expect(failedSandboxDocker.calls).toContain("docker-check");
    expect(failedSandboxDocker.calls).toContain("sandbox-docker-check");
    expect(failedSandboxDocker.calls).not.toContain("hygiene");
    expect(failedSandboxDocker.calls).not.toContain("publish");
    const failedHygiene = await publishRun("direct", false, true, false);
    expect(failedHygiene.runResult.exitCode).not.toBe(0);
    expect(failedHygiene.calls).toContain("hygiene");
    expect(failedHygiene.calls).not.toContain("stop");
    expect(failedHygiene.calls).not.toContain("publish");
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
  test("container-only template requires only features available on the pinned Incus 6.0 server", () => {
    const reviewed = checkedInRecipe as IncusSetupRecipe;
    expect(reviewed.expected.incusVersion).toBe("6.0.6");
    expect(reviewed.project.config["limits.virtual-machines"]).toBe("0");
    expect(reviewed.project.config).not.toHaveProperty("restricted.virtual-machines.nesting");
    expect(reviewed.project.config).not.toHaveProperty("restricted.storage-pools.access");
    expect(reviewed.expected.requiredApiExtensions).toContain("projects_restricted_image_servers");
    expect(reviewed.expected.requiredApiExtensions).toContain("projects_limits_disk_pool");
    expect(() => validateRecipe(reviewed)).not.toThrow();
    const missingImageRestriction = createSetupPlan(reviewed, inventory({ server: {
      ...inventory().server,
      apiExtensions: reviewed.expected.requiredApiExtensions.filter(extension => extension !== "projects_restricted_image_servers"),
    } }));
    expect(missingImageRestriction.blockedReasons).toContain("missing_api_extension:projects_restricted_image_servers");
  });

  test("checked-in recipe matches advertised presets while legacy LVM/16 GiB does not", () => {
    const advertised = incusManifest.sandboxProviders?.find(provider => provider.id === INCUS_PROVIDER_ID)?.presets ?? [];
    expect(advertised.length).toBeGreaterThan(0);
    const compatibleInventory = inventory({ server: { ...inventory().server, storageDrivers: [{ name: "btrfs", version: "6", remote: false }] } });
    const compatible = createSetupPlan(checkedInRecipe as IncusSetupRecipe, compatibleInventory);
    expect(compatible.blockedReasons.some(reason => reason.startsWith("preset_"))).toBe(false);
    expect(compatible.blockedReasons).toContain("guest_image_missing_or_drifted");
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

  test("reviewed recipe and active release require the same published image and helper", () => {
    const reviewed = checkedInRecipe as IncusSetupRecipe;
    const presets = incusManifest.sandboxProviders!.find(provider => provider.id === INCUS_PROVIDER_ID)!.presets;
    const fingerprint = "2f8868763f6cbec0452ab0d4db82ecb315c4aff1b9a3d2d1777cd878017e9fa1";
    expect(reviewed.guestImage?.fingerprint).toBe(fingerprint);
    expect(presets.every(preset => preset.imageDigest === fingerprint &&
      JSON.stringify(preset.helperDigests) === JSON.stringify([reviewed.guestImage!.helperSha256]))).toBe(true);
    const withClient = { ...reviewed, providerClient: { name: "engine", certificateFingerprint: "b".repeat(64),
      certificatePem: pem, projects: [reviewed.project.name], restricted: true as const } };
    const current = bootstrapInventory({ images: [{ fingerprint, aliases: [reviewed.guestImage!.alias] }] });
    expect(createSetupPlan(withClient, current, presets).status).toBe("ready");
    expect(createSetupPlan(withClient, bootstrapInventory(), presets).blockedReasons).toContain("guest_image_missing_or_drifted");
    expect(createSetupPlan(withClient, current, presets.map(preset => ({ ...preset, imageDigest: "0".repeat(64) }))).blockedReasons)
      .toContain(`preset_image_digest_mismatch:${presets[0]!.id}`);
    expect(createSetupPlan(withClient, current, presets.map(preset => ({ ...preset, imageDigest: "a".repeat(64) }))).blockedReasons)
      .toContain(`preset_image_digest_mismatch:${presets[0]!.id}`);
    expect(createSetupPlan(withClient, current, presets.map(preset => ({ ...preset, helperDigests: ["a".repeat(64)] }))).blockedReasons)
      .toContain(`preset_helper_digest_mismatch:${presets[0]!.id}`);
    expect(createSetupPlan({ ...withClient, guestImage: { ...reviewed.guestImage!, fingerprint: "a".repeat(64) } }, current, presets).blockedReasons)
      .toContain(`preset_image_digest_mismatch:${presets[0]!.id}`);
    expect(createSetupPlan({ ...withClient, expected: { ...reviewed.expected, incusVersion: "6.1.0" } }, current, presets).blockedReasons)
      .toContain("incus_version_mismatch");
    expect(createSetupPlan(imageBuildTemplate as IncusSetupRecipe, current, presets).blockedReasons).toContain("guest_image_artifact_unpinned");
  });

  test("every feature NIC requires isolated bridge ports in recipe, plan, and profile readback", async () => {
    const reviewed = checkedInRecipe as IncusSetupRecipe;
    const nic = reviewed.profile.devices.eth0!;
    expect(nic["security.port_isolation"]).toBe("true");
    expect((imageBuildTemplate as IncusSetupRecipe).profile.devices.eth0!["security.port_isolation"]).toBe("true");
    const changedNic = (value: Record<string, string>) => ({ ...reviewed, profile: { ...reviewed.profile,
      devices: { ...reviewed.profile.devices, eth0: value } } });
    const { "security.port_isolation": _isolation, ...withoutIsolation } = nic;
    expect(() => validateRecipe(changedNic(withoutIsolation))).toThrow("eth0 device must define every supported setting");
    expect(() => validateRecipe(changedNic({ ...nic, "security.port_isolation": "false" }))).toThrow("port isolation");
    const approvedProfile = { ...reviewed.profile, project: reviewed.project.name };
    const current = bootstrapInventory({ profiles: [approvedProfile] });
    expect(createSetupPlan(reviewed, current).blockedReasons).not.toContain("profile_drift");
    for (const weakNic of [withoutIsolation, { ...nic, "security.port_isolation": "false" }]) {
      const drifted = { ...approvedProfile, devices: { ...approvedProfile.devices, eth0: weakNic } };
      expect(createSetupPlan(reviewed, bootstrapInventory({ profiles: [drifted] })).blockedReasons).toContain("profile_drift");
    }
    const deviceStep = createSetupPlan(reviewed, bootstrapInventory()).steps.find(step => step.id === "profile-device-eth0")!;
    expect(deviceStep.apply.argv).toContain("security.port_isolation=true");
    expect(deviceStep.inspect.argv).toContain("security.port_isolation");
    expect(await inspectStep(deviceStep, async () => result(0, "true\n"))).toBe("match");
    expect(await inspectStep(deviceStep, async () => result(0, "false\n"))).toBe("drift");
    expect(await inspectStep(deviceStep, async () => result(0, ""))).toBe("absent");
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
    expect(createSetupPlan(recipe(), inventory({ storagePools: [{ name: "other", driver: "lvm", description: "foreign", config: {}, status: "Created" }] })).blockedReasons).toContain("unrestricted_storage_pools_present");
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
    expect(() => validateRecipe(recipe({ project: { ...recipe().project, config: { ...recipe().project.config,
      "restricted.images.servers": "images.linuxcontainers.org" } } }))).toThrow("closed restriction policy");
    expect((checkedInRecipe as IncusSetupRecipe).project.config["restricted.images.servers"]).toBe(",");
    expect((imageBuildTemplate as IncusSetupRecipe).project.config["restricted.images.servers"]).toBe(",");
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
    expect(classifyApplyResult({ exitCode: 0, stdout: "", stderr: "", timedOut: true })).toBe("reconcile");
  });

  test("unsupported-key diagnostics require an exact key in the reviewed project command", async () => {
    const planned = syntheticReadyPlan();
    const project = planned.steps.find(step => step.id === "restricted-project")!;
    const payload = { ...planned, steps: [project] };
    const { planDigest: _oldDigest, ...withoutDigest } = payload;
    const oneStep = { ...withoutDigest, planDigest: digest(withoutDigest) };
    const secret = "secret-in-stderr-do-not-echo";
    const notReviewed = await applySetupPlan(oneStep, async argv => argv === project.apply.argv
      ? result(1, "", `Error: Invalid project configuration key "secret.key"\n${secret}`)
      : result(1, "", "not found"), { execute: true, approvedPlanDigest: oneStep.planDigest });
    expect(notReviewed.state).toBe("review_required");
    expect(notReviewed.steps[0]?.diagnostic).toBeUndefined();
    expect(JSON.stringify(notReviewed)).not.toContain(secret);

    const knownKey = project.apply.argv.find((arg, index) => project.apply.argv[index - 1] === "--config")!.split("=")[0]!;
    const uncertain = await applySetupPlan(oneStep, async argv => argv === project.apply.argv
      ? { ...result(255, "", `Error: Invalid project configuration key "${knownKey}"\nconnection closed\n${secret}`), timedOut: true }
      : result(1, "", "not found"), { execute: true, approvedPlanDigest: oneStep.planDigest });
    expect(uncertain.state).toBe("reconcile_required");
    expect(uncertain.steps[0]?.diagnostic).toBeUndefined();
    expect(JSON.stringify(uncertain)).not.toContain(secret);
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
