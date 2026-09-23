import { execFile } from "node:child_process";
import { createPublicKey, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface IncusClientIdentity {
  certificatePem: string;
  privateKeyPem: string;
  fingerprint: string;
}

/** The private key stays on the host. Only certificatePem may be shown to an operator. */
export async function issueIncusClientIdentity(connectionId: string): Promise<IncusClientIdentity> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(connectionId)) {
    throw new Error("Invalid Incus connection identity");
  }
  const directory = await mkdtemp(join(tmpdir(), "ezharness-incus-client-"));
  const keyPath = join(directory, "client.key");
  const certificatePath = join(directory, "client.crt");
  try {
    try {
      await run("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
        "-sha256", "-days", "365", "-nodes", "-subj", `/CN=ezharness-${connectionId}`,
        "-keyout", keyPath, "-out", certificatePath], { timeout: 15_000, maxBuffer: 4096 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("OpenSSL is required on the EZHarness engine host");
      throw new Error("Incus client identity generation failed");
    }
    const [certificatePem, privateKeyPem] = await Promise.all([
      readFile(certificatePath, "utf8"), readFile(keyPath, "utf8"),
    ]);
    const certificate = new X509Certificate(certificatePem);
    const certificateKey = certificate.publicKey.export({ type: "spki", format: "der" });
    const privatePublicKey = createPublicKey(privateKeyPem).export({ type: "spki", format: "der" });
    if (!Buffer.from(certificateKey).equals(Buffer.from(privatePublicKey))) {
      throw new Error("Incus client certificate and key do not match");
    }
    return { certificatePem, privateKeyPem, fingerprint: certificate.fingerprint256.replaceAll(":", "").toLowerCase() };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
