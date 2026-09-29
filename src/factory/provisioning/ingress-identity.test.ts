import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeFactoryPrivateRoot, removeFactoryPrivateRoot, writeModeFile } from "../../__tests__/helpers/factory-private-root";
import {
  FACTORY_INGRESS_PROOF_HEADER,
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

describe("factoryIngressRefusal with an ingress proof", () => {
  const proofed: FactoryIngressIdentity = { ...identity, proofPath: "/unused" };
  const good = { host: "tenant-01.factory.example", [FACTORY_INSTALLATION_HEADER]: "inst-1" };

  test("the matching proof proceeds", () => {
    expect(factoryIngressRefusal(proofed, probe("/", { ...good, [FACTORY_INGRESS_PROOF_HEADER]: "p".repeat(43) }), "p".repeat(43))).toBeNull();
  });

  test("a missing, wrong, or differently sized proof is refused as proof", () => {
    expect(factoryIngressRefusal(proofed, probe("/", good), "p".repeat(43))).toBe("proof");
    expect(factoryIngressRefusal(proofed, probe("/", { ...good, [FACTORY_INGRESS_PROOF_HEADER]: "q".repeat(43) }), "p".repeat(43))).toBe("proof");
    expect(factoryIngressRefusal(proofed, probe("/", { ...good, [FACTORY_INGRESS_PROOF_HEADER]: "p" }), "p".repeat(43))).toBe("proof");
  });

  test("a configured proof that could not be read refuses even a request that presents one", () => {
    expect(factoryIngressRefusal(proofed, probe("/", { ...good, [FACTORY_INGRESS_PROOF_HEADER]: "p".repeat(43) }), undefined)).toBe("proof");
  });

  test("exempt paths need no proof", () => {
    expect(factoryIngressRefusal(proofed, probe("/api/health", {}), undefined)).toBeNull();
  });
});

describe("factoryIngressIdentityFromEnv with a proof file", () => {
  test("carries the trimmed proof path", () => {
    expect(factoryIngressIdentityFromEnv({ ...{ EZCORP_INSTALLATION_HOSTNAME: "a.example", EZCORP_INSTALLATION_ID: "i" }, EZCORP_INGRESS_PROOF_FILE: " /run/p " })).toEqual({ hostname: "a.example", installationId: "i", proofPath: "/run/p" });
  });
});

describe("factoryIngressResponse", () => {
  const env = { EZCORP_INSTALLATION_HOSTNAME: "tenant-01.factory.example", EZCORP_INSTALLATION_ID: "inst-1" };
  const routed = (extra: Record<string, string> = {}) => new Request("http://tenant-01.factory.example/api/runs", { headers: { host: "tenant-01.factory.example", [FACTORY_INSTALLATION_HEADER]: "inst-1", ...extra } });

  test("returns null for a correctly routed request", async () => {
    expect(await factoryIngressResponse(routed(), env)).toBeNull();
  });

  test("returns a 421 JSON body naming the refusal reason", async () => {
    const response = await factoryIngressResponse(new Request("http://127.0.0.1:3000/api/runs", { headers: { host: "127.0.0.1:3000" } }), env);
    expect(response?.status).toBe(421);
    expect(response?.headers.get("content-type")).toBe("application/json");
    expect(await response?.json()).toEqual({ error: "misdirected_request", reason: "host" });

    const wrongInstallation = await factoryIngressResponse(new Request("http://tenant-01.factory.example/", { headers: { host: "tenant-01.factory.example", [FACTORY_INSTALLATION_HEADER]: "inst-9" } }), env);
    expect(await wrongInstallation?.json()).toEqual({ error: "misdirected_request", reason: "installation" });
  });

  test("re-reads the identity when the environment changes", async () => {
    expect(await factoryIngressResponse(routed(), env)).toBeNull();
    expect((await factoryIngressResponse(routed(), { ...env, EZCORP_INSTALLATION_ID: "inst-2" }))?.status).toBe(421);
    expect(await factoryIngressResponse(routed(), {})).toBeNull();
    expect(await factoryIngressResponse(routed(), env)).toBeNull();
  });

  test("defaults to process.env", async () => {
    const saved = { hostname: process.env.EZCORP_INSTALLATION_HOSTNAME, id: process.env.EZCORP_INSTALLATION_ID };
    try {
      process.env.EZCORP_INSTALLATION_HOSTNAME = "tenant-05.factory.example";
      process.env.EZCORP_INSTALLATION_ID = "inst-5";
      expect((await factoryIngressResponse(new Request("http://127.0.0.1/", { headers: { host: "127.0.0.1" } })))?.status).toBe(421);
    } finally {
      if (saved.hostname === undefined) delete process.env.EZCORP_INSTALLATION_HOSTNAME; else process.env.EZCORP_INSTALLATION_HOSTNAME = saved.hostname;
      if (saved.id === undefined) delete process.env.EZCORP_INSTALLATION_ID; else process.env.EZCORP_INSTALLATION_ID = saved.id;
    }
  });

  test("a misconfigured environment rejects instead of serving", async () => {
    await expect(factoryIngressResponse(new Request("http://x/"), { EZCORP_INSTALLATION_HOSTNAME: "x.example" })).rejects.toThrow("without EZCORP_INSTALLATION_ID");
  });

  describe("with a delivered proof file", () => {
    let root: string;
    const proof = "A".repeat(43);
    beforeAll(async () => {
      root = await makeFactoryPrivateRoot();
      await mkdir(join(root, "deliver"), { mode: 0o700 });
      await writeModeFile(join(root, "deliver", "ingress-proof"), `${proof}\n`);
      await mkdir(join(root, "open"), { mode: 0o700 });
      await writeModeFile(join(root, "open", "ingress-proof"), `${proof}\n`, 0o644);
    });
    afterAll(async () => { await removeFactoryPrivateRoot(root); });
    const proofEnv = () => ({ ...env, EZCORP_INGRESS_PROOF_FILE: join(root, "deliver", "ingress-proof") });

    test("the ingress's proof proceeds, and a request with a missing or wrong proof is refused 421 proof", async () => {
      expect(await factoryIngressResponse(routed({ [FACTORY_INGRESS_PROOF_HEADER]: proof }), proofEnv())).toBeNull();
      expect(await (await factoryIngressResponse(routed(), proofEnv()))?.json()).toEqual({ error: "misdirected_request", reason: "proof" });
      expect(await (await factoryIngressResponse(routed({ [FACTORY_INGRESS_PROOF_HEADER]: "B".repeat(43) }), proofEnv()))?.json()).toEqual({ error: "misdirected_request", reason: "proof" });
      // Read once, then kept: a second request answers from the cached proof.
      expect(await factoryIngressResponse(routed({ [FACTORY_INGRESS_PROOF_HEADER]: proof }), proofEnv())).toBeNull();
    });

    test("health needs no proof even when the proof is unreadable", async () => {
      const request = new Request("http://127.0.0.1/api/health", { headers: { host: "127.0.0.1" } });
      expect(await factoryIngressResponse(request, { ...env, EZCORP_INGRESS_PROOF_FILE: join(root, "missing", "ingress-proof") })).toBeNull();
    });

    test("a proof that is absent or not private refuses every request, the correct proof included", async () => {
      for (const path of [join(root, "deliver", "absent"), join(root, "open", "ingress-proof")]) {
        const response = await factoryIngressResponse(routed({ [FACTORY_INGRESS_PROOF_HEADER]: proof }), { ...env, EZCORP_INGRESS_PROOF_FILE: path });
        expect(await response?.json()).toEqual({ error: "misdirected_request", reason: "proof" });
      }
    });
  });
});
