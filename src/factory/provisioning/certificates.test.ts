import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeFactoryPrivateRoot, removeFactoryPrivateRoot, writeModeFile } from "../../__tests__/helpers/factory-private-root";
import {
  createFactoryCertificateAuthority,
  factoryCertificateExtensions,
  factorySpawnRunner,
  issueFactoryCertificate,
  type FactoryCertificateAuthorityPaths,
  type FactoryCommandRunner,
  type FactoryIssuedCertificate,
} from "./certificates";
import { FactoryProvisioningError } from "./steps";

const CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

async function rejection(work: Promise<unknown>): Promise<FactoryProvisioningError> {
  try { await work; }
  catch (error) { return error as FactoryProvisioningError; }
  throw new Error("expected a rejection");
}

function refusal(work: () => unknown): FactoryProvisioningError {
  try { work(); }
  catch (error) { return error as FactoryProvisioningError; }
  throw new Error("expected a refusal");
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

describe("factoryCertificateExtensions", () => {
  test("client, server, and peer usages map to their extended key usages", () => {
    expect(factoryCertificateExtensions({ subject: "tenant-01.temporal", usage: "client" })).toBe("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n");
    expect(factoryCertificateExtensions({ subject: "gateway", usage: "server" })).toContain("extendedKeyUsage=serverAuth\n");
    expect(factoryCertificateExtensions({ subject: "temporal-node", usage: "peer" })).toContain("extendedKeyUsage=serverAuth,clientAuth\n");
  });

  test("lists DNS names before IP addresses and omits the SAN line when there are none", () => {
    const text = factoryCertificateExtensions({ subject: "svc", usage: "server", dnsNames: ["svc.local", "localhost"], ipAddresses: ["127.0.0.1"] });
    expect(text.split("\n")).toContain("subjectAltName=DNS:svc.local,DNS:localhost,IP:127.0.0.1");
    expect(factoryCertificateExtensions({ subject: "svc", usage: "server", dnsNames: [], ipAddresses: [] })).not.toContain("subjectAltName");
  });

  test("refuses subjects that could inject into the openssl subject or config", () => {
    for (const subject of ["", "-leading", "has space", "a/CN=evil", "a,b", `a${"b".repeat(63)}`, "a\nb"]) {
      const error = refusal(() => factoryCertificateExtensions({ subject, usage: "client" }));
      expect(error).toBeInstanceOf(FactoryProvisioningError);
      expect(error.code).toBe("certificate_subject_invalid");
    }
    expect(factoryCertificateExtensions({ subject: `a${"b".repeat(62)}`, usage: "client" })).toContain("clientAuth");
  });

  test("refuses malformed DNS names and IP addresses", () => {
    for (const request of [{ dnsNames: ["bad name"] }, { dnsNames: ["-lead"] }, { dnsNames: ["trail."] }, { dnsNames: ["a,DNS:evil"] }, { ipAddresses: ["::1"] }, { ipAddresses: ["1.2.3"] }, { ipAddresses: ["1.2.3.4,IP:5.6.7.8"] }]) {
      const error = refusal(() => factoryCertificateExtensions({ subject: "svc", usage: "server", ...request }));
      expect(error.code).toBe("certificate_subject_invalid");
      expect(error.message).toBe("Certificate subject alternative name is invalid.");
    }
  });
});

describe("with the real openssl", () => {
  let root: string;
  let authority: FactoryCertificateAuthorityPaths;
  let ca: FactoryIssuedCertificate;
  let caCertificate: X509Certificate;

  beforeAll(async () => {
    root = await makeFactoryPrivateRoot();
    ca = await createFactoryCertificateAuthority("w16-test-ca");
    authority = { certificatePath: await writeModeFile(join(root, "ca.crt"), ca.certificatePem), keyPath: await writeModeFile(join(root, "ca.key"), ca.privateKeyPem) };
    caCertificate = new X509Certificate(ca.certificatePem);
  });

  afterAll(async () => { await removeFactoryPrivateRoot(root); });

  test("creates a self-signed CA whose key matches its certificate", () => {
    expect(caCertificate.subject).toBe("CN=w16-test-ca");
    expect(caCertificate.issuer).toBe("CN=w16-test-ca");
    expect(caCertificate.ca).toBe(true);
    expect(caCertificate.verify(caCertificate.publicKey)).toBe(true);
    expect(caCertificate.checkPrivateKey(createPrivateKey(ca.privateKeyPem))).toBe(true);
    expect(ca.privateKeyPem).toContain("PRIVATE KEY");
  });

  test("issues a client certificate signed by the CA with clientAuth only", async () => {
    const issued = await issueFactoryCertificate(authority, { subject: "tenant-01.fleet-a", usage: "client" });
    const certificate = new X509Certificate(issued.certificatePem);
    expect(certificate.subject).toBe("CN=tenant-01.fleet-a");
    expect(certificate.ca).toBe(false);
    expect(certificate.issuer).toBe(caCertificate.subject);
    expect(certificate.verify(caCertificate.publicKey)).toBe(true);
    expect(certificate.checkPrivateKey(createPrivateKey(issued.privateKeyPem))).toBe(true);
    expect(certificate.keyUsage).toEqual([CLIENT_AUTH]);
    expect(certificate.subjectAltName).toBeUndefined();
  });

  test("issues a server certificate with its SANs and the requested lifetime", async () => {
    const issued = await issueFactoryCertificate(authority, { subject: "gateway", usage: "server", dnsNames: ["gateway.tenant-01.local", "localhost"], ipAddresses: ["127.0.0.1"], days: 2 });
    const certificate = new X509Certificate(issued.certificatePem);
    expect(certificate.subject).toBe("CN=gateway");
    expect(certificate.keyUsage).toEqual([SERVER_AUTH]);
    expect(certificate.subjectAltName).toBe("DNS:gateway.tenant-01.local, DNS:localhost, IP Address:127.0.0.1");
    expect(certificate.checkHost("gateway.tenant-01.local")).toBe("gateway.tenant-01.local");
    expect(certificate.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(certificate.checkHost("other.local")).toBeUndefined();
    const days = (certificate.validToDate.getTime() - certificate.validFromDate.getTime()) / 86_400_000;
    expect(days).toBe(2);
  });

  test("issues a peer certificate with both usages and a 90-day default lifetime", async () => {
    const issued = await issueFactoryCertificate(authority, { subject: "temporal-node", usage: "peer", dnsNames: ["temporal"] });
    const certificate = new X509Certificate(issued.certificatePem);
    expect([...certificate.keyUsage!].sort()).toEqual([SERVER_AUTH, CLIENT_AUTH].sort());
    expect(certificate.subjectAltName).toBe("DNS:temporal");
    expect((certificate.validToDate.getTime() - certificate.validFromDate.getTime()) / 86_400_000).toBe(90);
  });

  test("concurrent issues get distinct keys and serial numbers", async () => {
    const issued = await Promise.all(Array.from({ length: 4 }, (_, index) => issueFactoryCertificate(authority, { subject: `svc-${index}`, usage: "server" })));
    const certificates = issued.map((entry) => new X509Certificate(entry.certificatePem));
    expect(new Set(certificates.map((certificate) => certificate.serialNumber)).size).toBe(4);
    expect(new Set(issued.map((entry) => entry.privateKeyPem)).size).toBe(4);
    expect(certificates.every((certificate) => certificate.verify(caCertificate.publicKey))).toBe(true);
  });

  test("a certificate from another authority does not verify against this one", async () => {
    const other = await createFactoryCertificateAuthority("w16-other-ca");
    expect(new X509Certificate(other.certificatePem).verify(caCertificate.publicKey)).toBe(false);
  });

  test("a missing CA key fails with certificate_issue_failed", async () => {
    const error = await rejection(issueFactoryCertificate({ certificatePath: authority.certificatePath, keyPath: join(root, "absent.key") }, { subject: "svc", usage: "client" }));
    expect(error.code).toBe("certificate_issue_failed");
    expect(error.message).toStartWith("openssl x509 exited 1: ");
  });
});

describe("injected command runner", () => {
  test("an invalid CA subject is refused before any command runs", async () => {
    const calls: string[][] = [];
    const run: FactoryCommandRunner = async (command, args) => { calls.push([command, ...args]); };
    expect((await rejection(createFactoryCertificateAuthority("bad subject", run))).code).toBe("certificate_subject_invalid");
    expect((await rejection(issueFactoryCertificate({ certificatePath: "/ca.crt", keyPath: "/ca.key" }, { subject: "svc", usage: "client", ipAddresses: ["x"] }, run))).code).toBe("certificate_subject_invalid");
    expect(calls).toEqual([]);
  });

  test("a failing runner propagates its error and the scratch directory is removed", async () => {
    const outputs: string[] = [];
    const failing: FactoryCommandRunner = async (_command, args) => {
      outputs.push(args[args.indexOf("-out") + 1]!);
      throw new FactoryProvisioningError("certificate_issue_failed", "simulated failure");
    };
    const error = await rejection(createFactoryCertificateAuthority("ca", failing));
    expect(error.code).toBe("certificate_issue_failed");
    const leafError = await rejection(issueFactoryCertificate({ certificatePath: "/ca.crt", keyPath: "/ca.key" }, { subject: "svc", usage: "server" }, failing));
    expect(leafError.message).toBe("simulated failure");
    expect(outputs).toHaveLength(2);
    for (const output of outputs) expect(await exists(dirname(output))).toBe(false);
  });

  test("the runner receives the exact openssl steps and the CA paths", async () => {
    const calls: string[][] = [];
    const run: FactoryCommandRunner = async (command, args) => { calls.push([command, ...args]); };
    // No command writes an output, so reading the certificate fails after all three steps ran.
    const error = await rejection(issueFactoryCertificate({ certificatePath: "/ops/ca.crt", keyPath: "/ops/ca.key" }, { subject: "svc", usage: "client", days: 5 }, run));
    expect((error as unknown as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(calls.map((call) => call.slice(0, 2))).toEqual([["openssl", "genpkey"], ["openssl", "req"], ["openssl", "x509"]]);
    const x509 = calls[2]!;
    expect(x509[x509.indexOf("-CA") + 1]).toBe("/ops/ca.crt");
    expect(x509[x509.indexOf("-CAkey") + 1]).toBe("/ops/ca.key");
    expect(x509[x509.indexOf("-days") + 1]).toBe("5");
    expect(x509[x509.indexOf("-set_serial") + 1]).toMatch(/^0x[0-9a-f]{32}$/);
    expect(await exists(dirname(x509[x509.indexOf("-out") + 1]!))).toBe(false);
  });
});

describe("factorySpawnRunner", () => {
  test("resolves when the command exits 0", async () => {
    await expect(factorySpawnRunner(process.execPath, ["-e", "process.exit(0)"])).resolves.toBeUndefined();
  });

  test("a non-zero exit fails with certificate_issue_failed and the last stderr line", async () => {
    const error = await rejection(factorySpawnRunner(process.execPath, ["-e", "console.error('first'); console.error('last line'); process.exit(3)"]));
    expect(error).toBeInstanceOf(FactoryProvisioningError);
    expect(error.code).toBe("certificate_issue_failed");
    expect(error.message).toBe(`${process.execPath} -e exited 3: last line`);
  });

  test("a non-zero exit with no stderr still names the command", async () => {
    const error = await rejection(factorySpawnRunner(process.execPath, ["-e", "process.exit(2)"]));
    expect(error.message).toBe(`${process.execPath} -e exited 2: `);
  });

  test("a command that does not exist fails with certificate_tool_unavailable", async () => {
    const error = await rejection(factorySpawnRunner("w16-no-such-command-anywhere", ["--version"]));
    expect(error).toBeInstanceOf(FactoryProvisioningError);
    expect(error.code).toBe("certificate_tool_unavailable");
    expect(error.message).toStartWith("w16-no-such-command-anywhere could not start: ");
  });
});
