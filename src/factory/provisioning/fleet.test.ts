import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  FACTORY_TEST_IMAGE,
  FACTORY_TEST_RUNNER_PROFILES,
  factoryRejection,
  makeFactoryPrivateRoot,
  removeFactoryPrivateRoot,
  writeModeFile,
} from "../../__tests__/helpers/factory-private-root";
import {
  FACTORY_FLEET_SCHEMA,
  factoryInstallationHostname,
  factoryInstallationPublicOrigin,
  factoryPlatformPaths,
  loadFactoryFleetSettings,
  parseFactoryFleetSettings,
  type FactoryFleetSettings,
} from "./fleet";

const storageDomain = (port: number) => ({ endpoint: `http://127.0.0.1:${port}`, prefix: "ordinary", issuer: { kind: "seeded" as const, serverIdentityPath: "/srv/operator/storage-identity.json" } });

const VALID: FactoryFleetSettings = {
  schemaVersion: FACTORY_FLEET_SCHEMA,
  fleetId: "fleet-a",
  profile: "compose",
  roots: { operator: "/srv/operator", secrets: "/srv/secrets", runtime: "/srv/runtime" },
  control: { databaseUrlPath: "/srv/operator/control-database-url" },
  database: { adminUrlPath: "/srv/operator/admin-database-url", serviceHost: "127.0.0.1", servicePort: 55_432 },
  storage: { ordinary: storageDomain(59_000), archive: { ...storageDomain(59_001), prefix: "archive" }, failureDomain: "host-a" },
  temporal: { port: 57_233, httpPort: 57_244, serverName: "temporal.test" },
  ingress: { address: "127.0.0.1", port: 30_443, domain: "factory.example" },
  installations: { portBase: 40_000, cpuCapacity: 4, interpreterCompatibility: "factory-interpreter-1", runnerProfiles: FACTORY_TEST_RUNNER_PROFILES as never },
  image: { reference: FACTORY_TEST_IMAGE, revision: "c".repeat(40) },
  release: { directory: "/srv/release", bun: "/srv/bin/bun", path: "/usr/bin:/bin" },
};

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
    expect(parseFactoryFleetSettings({ ...VALID, profile: "kubernetes" }).profile).toBe("kubernetes");
  });

  test("accepts boundary values", () => {
    for (const [path, value] of [
      ["fleetId", "ab"], ["fleetId", `a${"b".repeat(30)}c`], ["database.servicePort", 1_024], ["database.servicePort", 65_535], ["installations.cpuCapacity", 1],
      ["storage.ordinary.endpoint", "https://storage.example:9000"], ["ingress.domain", "a"], ["storage.archive.prefix", "a"],
    ] as const) {
      expect(parseFactoryFleetSettings(withField(path, value))).toBeDefined();
    }
  });

  test("a document of the wrong shape is refused as a whole", () => {
    for (const value of [null, "fleet", [], {}, { ...VALID, schemaVersion: "factory.fleet.v2" }, { ...VALID, extra: true }, withField("release", undefined, true)]) {
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
      ["installations.portBase", 1_000, "installations"], ["installations.cpuCapacity", 0, "installations"], ["installations.cpuCapacity", 1.5, "installations"], ["installations.interpreterCompatibility", 1, "installations"],
      ["image.reference", "registry.test/ezcorp:latest", "image"], ["image.revision", "abc", "image"],
      ["release.directory", "release", "release"], ["release.bun", "bun", "release"], ["release.path", ["/usr/bin"], "release"],
    ];
    for (const [path, value, field] of cases) {
      const error = refusal(withField(path, value));
      expect(error.code).toBe("fleet_settings_invalid");
      expect(error.message).toBe(`Fleet settings are invalid: ${field}.`);
    }
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
