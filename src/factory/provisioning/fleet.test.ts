import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  FACTORY_TEST_RUNNER_PROFILES,
  factoryRejection,
  makeFactoryPrivateRoot,
  makeFactoryTestFleetSettings,
  removeFactoryPrivateRoot,
  writeModeFile,
} from "../../__tests__/helpers/factory-private-root";
import {
  factoryInstallationHostname,
  factoryInstallationPublicOrigin,
  factoryPlatformPaths,
  loadFactoryFleetSettings,
  parseFactoryFleetSettings,
  type FactoryFleetSettings,
} from "./fleet";

const VALID: FactoryFleetSettings = makeFactoryTestFleetSettings();

/** A copy of VALID with one dotted path replaced (or removed when `value` is `undefined` and `remove` is set). */
function withField(path: string, value: unknown, remove = false): unknown {
  const copy = JSON.parse(JSON.stringify(VALID)) as Record<string, unknown>;
  const keys = path.split(".");
  let cursor = copy;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  if (remove) delete cursor[keys.at(-1)!];
  else cursor[keys.at(-1)!] = value;
  return copy;
}

function refusal(value: unknown): { code?: string; message: string } {
  try { parseFactoryFleetSettings(value); } catch (error) { return error as { code?: string; message: string }; }
  throw new Error("expected fleet settings to be refused");
}

describe("parseFactoryFleetSettings", () => {
  test("accepts a complete document and returns a frozen, detached copy", () => {
    const parsed = parseFactoryFleetSettings(VALID);
    expect(parsed).toEqual(VALID);
    expect(parsed).not.toBe(VALID);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test("accepts boundary values", () => {
    for (const [path, value] of [
      ["fleetId", "ab"], ["fleetId", `a${"b".repeat(30)}c`], ["database.servicePort", 1_024], ["database.servicePort", 65_535], ["resources.cpuCapacity", 1],
      ["storage.ordinary.endpoint", "https://storage.example:9000"], ["ingress.domain", "a"], ["storage.archive.prefix", "a"],
    ] as const) {
      expect(parseFactoryFleetSettings(withField(path, value))).toBeDefined();
    }
  });

  test("a document of the wrong shape is refused as a whole", () => {
    for (const value of [null, "fleet", [], {}, { ...VALID, schemaVersion: "factory.fleet.v2" }, { ...VALID, extra: true }, withField("release", undefined, true), withField("resources", undefined, true)]) {
      const error = refusal(value);
      expect(error.code).toBe("fleet_settings_invalid");
      expect(error.message).toBe("Fleet settings are invalid: document.");
    }
  });

  test("each invalid field is named", () => {
    const cases: readonly (readonly [string, unknown, string])[] = [
      ["fleetId", "A-fleet", "fleetId"], ["fleetId", "a", "fleetId"], ["fleetId", "fleet-", "fleetId"], ["fleetId", 7, "fleetId"], ["fleetId", `a${"b".repeat(31)}c`, "fleetId"],
      ["profile", "helm", "profile"],
      ["roots.operator", "relative", "roots"], ["roots.runtime", "/srv/../srv/runtime", "roots"], ["roots", { operator: "/a", secrets: "/b" }, "roots"], ["roots", null, "roots"],
      ["control.databaseUrlPath", "", "control"], ["control", { databaseUrlPath: "/a", extra: 1 }, "control"],
      ["database.adminUrlPath", "admin", "database"], ["database.serviceHost", 5, "database"], ["database.servicePort", 1_023, "database"], ["database.servicePort", 65_536, "database"], ["database.servicePort", "5432", "database"],
      ["storage.ordinary.endpoint", "ftp://127.0.0.1:1", "storage.ordinary"], ["storage.ordinary.endpoint", "not a url", "storage.ordinary"], ["storage.ordinary.prefix", "Ordinary", "storage.ordinary"],
      ["storage.ordinary.issuer.kind", "minted", "storage.ordinary"], ["storage.ordinary.issuer.serverIdentityPath", "id.json", "storage.ordinary"], ["storage.ordinary.issuer", null, "storage.ordinary"],
      ["storage.archive", "archive", "storage.archive"], ["storage.archive.prefix", `a${"b".repeat(63)}`, "storage.archive"],
      ["storage.failureDomain", "", "storage"], ["storage.failureDomain", 1, "storage"],
      ["temporal.port", 80, "temporal"], ["temporal.serverName", null, "temporal"],
      // The read-only HTTP route needs its own port: a missing, invalid, or shared one is refused.
      ["temporal.httpPort", undefined, "temporal"], ["temporal.httpPort", 80, "temporal"], ["temporal.httpPort", "57244", "temporal"], ["temporal.httpPort", 57_233, "temporal"],
      ["ingress.address", "localhost", "ingress"], ["ingress.port", 443.5, "ingress"], ["ingress.domain", "Factory.example", "ingress"],
      ["installations.portBase", 1_000, "installations"], ["installations.cpuCapacity", 4, "installations"],
      ["resources.cpuCapacity", 0, "resources"], ["resources.cpuCapacity", 1.5, "resources"], ["resources.profile", "gpus", "resources"], ["resources.gpuProfilesPath", "/srv/operator/gpu.json", "resources"],
      ["resources", { profile: "gpu", cpuCapacity: 2 }, "resources"], ["resources", { profile: "gpu", cpuCapacity: 2, gpuProfilesPath: "gpu.json" }, "resources"], ["resources", null, "resources"], ["installations.interpreterCompatibility", 1, "installations"],
      ["image.reference", "registry.test/ezcorp:latest", "image"], ["image.revision", "abc", "image"],
      ["release.directory", "release", "release"], ["release.bun", "bun", "release"], ["release.path", ["/usr/bin"], "release"],
    ];
    for (const [path, value, field] of cases) {
      const error = refusal(withField(path, value));
      expect(error.code).toBe("fleet_settings_invalid");
      expect(error.message).toBe(`Fleet settings are invalid: ${field}.`);
    }
  });

  test("the resource profile is a fleet setting: cpu-only, or gpu with a private profile file", () => {
    const gpu = { profile: "gpu", cpuCapacity: 2, gpuProfilesPath: "/srv/operator/gpu-host-profiles.json" };
    expect(parseFactoryFleetSettings(withField("resources", gpu)).resources).toEqual(gpu as never);
    expect(parseFactoryFleetSettings(VALID).resources).toEqual({ profile: "cpu-only", cpuCapacity: 4 });
  });

  test("a runner profile that asks for a GPU host is refused under cpu-only and accepted under gpu", () => {
    const [cpu] = FACTORY_TEST_RUNNER_PROFILES.profiles;
    const runnerProfiles = { ...FACTORY_TEST_RUNNER_PROFILES, profiles: [cpu, { ...cpu, runner: { ...cpu!.runner, export: "gpu" }, resourceClass: "gpu", allocation: { ...cpu!.allocation, resources: { "gpu-host": 1 } } }] };
    const value = withField("installations.runnerProfiles", runnerProfiles) as Record<string, unknown>;
    const error = refusal(value);
    expect(error.code).toBe("fleet_settings_invalid");
    expect(error.message).toBe("Fleet settings are invalid: resources.");
    value.resources = { profile: "gpu", cpuCapacity: 2, gpuProfilesPath: "/srv/operator/gpu-host-profiles.json" };
    expect(parseFactoryFleetSettings(value).installations.runnerProfiles.profiles).toHaveLength(2);
  });

  test("the hosted profile names its cluster by reference and how its pods see the fleet's services (W4H-35)", () => {
    const kubernetes = {
      kubectl: "/nix/store/kubectl/bin/kubectl", kubeconfigPath: "/srv/operator/kubeconfig", systemNamespace: "ezcorp-factory-fleet-a",
      runAsUser: 10_001, runtimeSocketPath: "/run/podman/podman.sock", nodeSelector: {}, ingress: { listenPort: 8443, nodePort: 30443 },
      egressCidrs: ["10.89.0.0/24"], egressPorts: [5432, 8333, 32001],
      services: { databaseHost: "10.89.0.2", databasePort: 5432, ordinaryEndpoint: "http://10.89.0.3:8333", archiveEndpoint: "http://10.89.0.4:8333", temporalAddress: "10.89.0.5:7233", temporalHttpEndpoint: "https://10.89.0.5:7244" },
    };
    const hosted = { ...VALID, profile: "kubernetes", kubernetes };
    expect(parseFactoryFleetSettings(hosted).kubernetes).toEqual(kubernetes);
    expect(refusal({ ...VALID, profile: "kubernetes" }).message).toBe("Fleet settings are invalid: kubernetes.");
    expect(refusal({ ...VALID, kubernetes }).message).toBe("Fleet settings are invalid: kubernetes.");
    for (const [field, value] of [
      ["kubectl", "kubectl"], ["kubeconfigPath", ""], ["systemNamespace", "Bad_Name"], ["runAsUser", 0], ["runtimeSocketPath", "podman.sock"], ["nodeSelector", []],
      ["ingress", { listenPort: 80, nodePort: 30443 }], ["ingress", { listenPort: 8443, nodePort: 1 }], ["egressCidrs", ["10.0.0.0"]], ["egressPorts", [0]],
      ["services", { ...kubernetes.services, databasePort: "5432" }], ["services", { ...kubernetes.services, ordinaryEndpoint: "s3://x" }], ["extra", 1],
    ] as const) expect(refusal({ ...hosted, kubernetes: { ...kubernetes, [field]: value } }).message).toBe("Fleet settings are invalid: kubernetes.");
    // A GPU fleet's supervisor runs only on the nodes it declares.
    const gpu = { profile: "gpu", cpuCapacity: 2, gpuProfilesPath: "/srv/operator/gpu-host-profiles.json" };
    expect(refusal({ ...hosted, resources: gpu }).message).toBe("Fleet settings are invalid: kubernetes.");
    expect(parseFactoryFleetSettings({ ...hosted, resources: gpu, kubernetes: { ...kubernetes, nodeSelector: { "ezcorp.io/gpu": "true" } } }).kubernetes!.nodeSelector).toEqual({ "ezcorp.io/gpu": "true" });
  });

  test("a missing storage section names both domains and the section", () => {
    expect(refusal(withField("storage", null)).message).toBe("Fleet settings are invalid: storage.ordinary, storage.archive, storage.");
  });

  test("several mistakes are named at once, in document order", () => {
    const value = withField("fleetId", "BAD") as Record<string, unknown>;
    (value.temporal as Record<string, unknown>).port = 1;
    (value.image as Record<string, unknown>).revision = "short";
    expect(refusal(value).message).toBe("Fleet settings are invalid: fleetId, temporal, image.");
  });

  test("a release declaration is accepted exactly when the block the deployer writes from it passes the startup parser", () => {
    const profile = { adapter: { package: "@ezcorp/s3-immutable-publish", manifestName: "s3-immutable-publish", version: "1.0.0", digest: `sha256:${"e".repeat(64)}`, export: "publish" }, action: "factory.release.publish", destination: "installation-s3", estimatedSpendMicros: 1_000 };
    const github = { repository: "ezcorp-org/factory-platform-publication-tests", tokenPath: "/srv/operator/github-release-token" };
    for (const release of [{ profiles: [profile] }, { github, profiles: [profile, { ...profile, adapter: { ...profile.adapter, package: "@ezcorp/github-release", export: "releasePullRequest" }, destination: "github" }] }]) {
      expect(parseFactoryFleetSettings(withField("installations.release", release)).installations.release).toEqual(release as never);
    }
    for (const release of [
      { profiles: [] }, { profiles: [{ ...profile, destination: "github" }] }, { profiles: [profile, profile] }, { profiles: [{ ...profile, estimatedSpendMicros: -1 }] },
      { github: { ...github, tokenPath: "token" }, profiles: [profile] }, { github: { repository: "not a repository", tokenPath: github.tokenPath }, profiles: [profile] },
      { github: { ...github, extra: 1 }, profiles: [profile] }, { profiles: [profile], extra: 1 }, { profiles: "all" }, null,
    ]) {
      const error = refusal(withField("installations.release", release));
      expect(error.code).toBe("fleet_settings_invalid");
      expect(error.message).toBe("Fleet settings are invalid: installations.release.");
    }
    expect(refusal(withField("installations.extra", 1)).message).toBe("Fleet settings are invalid: installations.");
  });

  test("an installation model pin is carried for the profiles that pin it, and judged by the startup parser (W4H-28)", () => {
    const pin = { provider: "openai", model: "gpt-6-luna", credentialKind: "oauth" };
    expect(parseFactoryFleetSettings(withField("installations.modelProvider", pin)).installations.modelProvider).toEqual(pin as never);
    for (const broken of [{ provider: "openai" }, { ...pin, credentialKind: "password" }]) {
      expect(refusal(withField("installations.modelProvider", broken)).message).toBe("Fleet settings are invalid: installations.runnerProfiles.");
    }
  });

  test("runner profiles are judged by the startup document's parser", () => {
    const profile = FACTORY_TEST_RUNNER_PROFILES.profiles[0]!;
    for (const runnerProfiles of [
      { ...FACTORY_TEST_RUNNER_PROFILES, profiles: [] },
      { ...FACTORY_TEST_RUNNER_PROFILES, brokerAudience: "" },
      { ...FACTORY_TEST_RUNNER_PROFILES, profiles: [{ ...profile, runner: { ...profile.runner, digest: "sha256:short" } }] },
      { ...FACTORY_TEST_RUNNER_PROFILES, profiles: [profile, profile] },
      "profiles",
    ]) {
      const error = refusal(withField("installations.runnerProfiles", runnerProfiles));
      expect(error.code).toBe("fleet_settings_invalid");
      expect(error.message).toBe("Fleet settings are invalid: installations.runnerProfiles.");
    }
  });
});

describe("loadFactoryFleetSettings", () => {
  let root: string;
  beforeAll(async () => { root = await makeFactoryPrivateRoot(); });
  afterAll(async () => { await removeFactoryPrivateRoot(root); });

  test("loads and validates a settings file", async () => {
    const path = await writeModeFile(join(root, "fleet.json"), JSON.stringify(VALID), 0o644);
    expect(await loadFactoryFleetSettings(path)).toEqual(VALID);
  });

  test("an unreadable or non-JSON file is refused, naming the path", async () => {
    const garbage = await writeModeFile(join(root, "garbage.json"), "{ not json");
    for (const path of [join(root, "absent.json"), garbage, root]) {
      const error = await factoryRejection(loadFactoryFleetSettings(path));
      expect(error.code).toBe("fleet_settings_invalid");
      expect(error.message).toBe(`Fleet settings at ${path} are not readable JSON.`);
    }
  });

  test("a readable file with invalid settings names the field", async () => {
    const path = await writeModeFile(join(root, "invalid.json"), JSON.stringify(withField("profile", "nomad")));
    expect((await factoryRejection(loadFactoryFleetSettings(path))).message).toBe("Fleet settings are invalid: profile.");
  });
});

describe("installation addresses", () => {
  test("the hostname is the tenant under the fleet's ingress domain", () => {
    expect(factoryInstallationHostname(VALID, "tenant-01")).toBe("tenant-01.factory.example");
    expect(factoryInstallationHostname(VALID, "tenant-02")).not.toBe(factoryInstallationHostname(VALID, "tenant-01"));
  });

  test("the public origin omits the port only for 443", () => {
    expect(factoryInstallationPublicOrigin(VALID, { hostname: "tenant-01.factory.example" })).toBe("https://tenant-01.factory.example:30443");
    expect(factoryInstallationPublicOrigin({ ...VALID, ingress: { ...VALID.ingress, port: 443 } }, { hostname: "tenant-01.factory.example" })).toBe("https://tenant-01.factory.example");
  });

  test("the re-exported platform paths place the ingress authority under the operator root, outside the mounted ingress root", () => {
    const { ingress } = factoryPlatformPaths(VALID.roots.operator);
    expect(ingress).toEqual({ root: "/srv/operator/platform/ingress", caCertificatePath: "/srv/operator/platform/ingress-ca/ca.crt", caKeyPath: "/srv/operator/platform/ingress-ca/ca.key" });
    expect(ingress.caKeyPath.startsWith(`${ingress.root}/`)).toBe(false);
  });
});
