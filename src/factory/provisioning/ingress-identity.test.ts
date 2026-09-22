import { describe, expect, test } from "bun:test";
import {
  FACTORY_INSTALLATION_HEADER,
  factoryIngressIdentityFromEnv,
  factoryIngressRefusal,
  factoryIngressResponse,
  type FactoryIngressIdentity,
} from "./ingress-identity";

const identity: FactoryIngressIdentity = { hostname: "tenant-01.factory.example", installationId: "inst-1" };

function probe(pathname: string, headers: Record<string, string>) {
  return { pathname, headers: new Headers(headers) };
}

describe("factoryIngressIdentityFromEnv", () => {
  test("no hostname means an unprovisioned installation", () => {
    expect(factoryIngressIdentityFromEnv({})).toBeNull();
    expect(factoryIngressIdentityFromEnv({ EZCORP_INSTALLATION_HOSTNAME: "   ", EZCORP_INSTALLATION_ID: "inst-1" })).toBeNull();
  });

  test("normalizes hostname case and trims both values", () => {
    const result = factoryIngressIdentityFromEnv({ EZCORP_INSTALLATION_HOSTNAME: " Tenant-01.Factory.Example ", EZCORP_INSTALLATION_ID: " inst-1 " });
    expect(result).toEqual(identity);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("a hostname without an installation ID is a configuration error", () => {
    expect(() => factoryIngressIdentityFromEnv({ EZCORP_INSTALLATION_HOSTNAME: "a.example" })).toThrow("EZCORP_INSTALLATION_HOSTNAME is set without EZCORP_INSTALLATION_ID.");
    expect(() => factoryIngressIdentityFromEnv({ EZCORP_INSTALLATION_HOSTNAME: "a.example", EZCORP_INSTALLATION_ID: "  " })).toThrow("without EZCORP_INSTALLATION_ID");
  });
});

describe("factoryIngressRefusal", () => {
  const good = { host: "tenant-01.factory.example", [FACTORY_INSTALLATION_HEADER]: "inst-1" };

  test("an unprovisioned installation refuses nothing", () => {
    expect(factoryIngressRefusal(null, probe("/api/anything", {}))).toBeNull();
  });

  test("health and readiness are exempt", () => {
    expect(factoryIngressRefusal(identity, probe("/api/health", {}))).toBeNull();
    expect(factoryIngressRefusal(identity, probe("/api/ready", { host: "127.0.0.1:3000" }))).toBeNull();
    expect(factoryIngressRefusal(identity, probe("/api/ready/extra", {}))).toBe("host");
  });

  test("the right host and installation header proceed, with any port and case", () => {
    expect(factoryIngressRefusal(identity, probe("/", good))).toBeNull();
    expect(factoryIngressRefusal(identity, probe("/", { ...good, host: " TENANT-01.factory.example:8443 " }))).toBeNull();
    expect(factoryIngressRefusal(identity, probe("/", { ...good, "x-forwarded-host": "tenant-01.factory.example:443" }))).toBeNull();
  });

  test("a missing or foreign host is refused as host", () => {
    expect(factoryIngressRefusal(identity, probe("/", { [FACTORY_INSTALLATION_HEADER]: "inst-1" }))).toBe("host");
    expect(factoryIngressRefusal(identity, probe("/", { ...good, host: "127.0.0.1:3000" }))).toBe("host");
    expect(factoryIngressRefusal(identity, probe("/", { ...good, host: "tenant-02.factory.example" }))).toBe("host");
  });

  test("a foreign forwarded host is refused even when Host matches", () => {
    expect(factoryIngressRefusal(identity, probe("/", { ...good, "x-forwarded-host": "evil.example" }))).toBe("host");
  });

  test("bracketed IPv6 hosts keep their brackets and drop the port", () => {
    const v6: FactoryIngressIdentity = { hostname: "[::1]", installationId: "inst-1" };
    expect(factoryIngressRefusal(v6, probe("/", { host: "[::1]:8080", [FACTORY_INSTALLATION_HEADER]: "inst-1" }))).toBeNull();
    expect(factoryIngressRefusal(v6, probe("/", { host: "[::2]", [FACTORY_INSTALLATION_HEADER]: "inst-1" }))).toBe("host");
  });

  test("a missing or different installation header is refused as installation", () => {
    expect(factoryIngressRefusal(identity, probe("/", { host: good.host }))).toBe("installation");
    expect(factoryIngressRefusal(identity, probe("/", { ...good, [FACTORY_INSTALLATION_HEADER]: "inst-2" }))).toBe("installation");
    expect(factoryIngressRefusal(identity, probe("/", { ...good, [FACTORY_INSTALLATION_HEADER]: "INST-1" }))).toBe("installation");
  });
});

describe("factoryIngressResponse", () => {
  const env = { EZCORP_INSTALLATION_HOSTNAME: "tenant-01.factory.example", EZCORP_INSTALLATION_ID: "inst-1" };

  test("returns null for a correctly routed request", () => {
    const request = new Request("http://tenant-01.factory.example/api/runs", { headers: { host: "tenant-01.factory.example", [FACTORY_INSTALLATION_HEADER]: "inst-1" } });
    expect(factoryIngressResponse(request, env)).toBeNull();
  });

  test("returns a 421 JSON body naming the refusal reason", async () => {
    const response = factoryIngressResponse(new Request("http://127.0.0.1:3000/api/runs", { headers: { host: "127.0.0.1:3000" } }), env);
    expect(response?.status).toBe(421);
    expect(response?.headers.get("content-type")).toBe("application/json");
    expect(await response?.json()).toEqual({ error: "misdirected_request", reason: "host" });

    const wrongInstallation = factoryIngressResponse(new Request("http://tenant-01.factory.example/", { headers: { host: "tenant-01.factory.example", [FACTORY_INSTALLATION_HEADER]: "inst-9" } }), env);
    expect(await wrongInstallation?.json()).toEqual({ error: "misdirected_request", reason: "installation" });
  });

  test("re-reads the identity when the environment changes", () => {
    const request = () => new Request("http://tenant-01.factory.example/", { headers: { host: "tenant-01.factory.example", [FACTORY_INSTALLATION_HEADER]: "inst-1" } });
    expect(factoryIngressResponse(request(), env)).toBeNull();
    expect(factoryIngressResponse(request(), { ...env, EZCORP_INSTALLATION_ID: "inst-2" })?.status).toBe(421);
    expect(factoryIngressResponse(request(), {})).toBeNull();
    expect(factoryIngressResponse(request(), env)).toBeNull();
  });

  test("defaults to process.env", () => {
    const saved = { hostname: process.env.EZCORP_INSTALLATION_HOSTNAME, id: process.env.EZCORP_INSTALLATION_ID };
    try {
      process.env.EZCORP_INSTALLATION_HOSTNAME = "tenant-05.factory.example";
      process.env.EZCORP_INSTALLATION_ID = "inst-5";
      expect(factoryIngressResponse(new Request("http://127.0.0.1/", { headers: { host: "127.0.0.1" } }))?.status).toBe(421);
    } finally {
      if (saved.hostname === undefined) delete process.env.EZCORP_INSTALLATION_HOSTNAME; else process.env.EZCORP_INSTALLATION_HOSTNAME = saved.hostname;
      if (saved.id === undefined) delete process.env.EZCORP_INSTALLATION_ID; else process.env.EZCORP_INSTALLATION_ID = saved.id;
    }
  });

  test("a misconfigured environment throws instead of serving", () => {
    expect(() => factoryIngressResponse(new Request("http://x/"), { EZCORP_INSTALLATION_HOSTNAME: "x.example" })).toThrow("without EZCORP_INSTALLATION_ID");
  });
});
