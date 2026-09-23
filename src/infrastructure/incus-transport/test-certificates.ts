import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Make disposable TLS identities for the loopback transport test. No private
 * key is kept in the repository or shared with a production connection. */
export function makeTestCertificates(): { read(name: string): string; dispose(): void } {
  const directory = mkdtempSync(join(tmpdir(), "ez-incus-tls-test-"));
  const path = (name: string) => join(directory, name);
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
  const createSelfSigned = (prefix: string, name: string, extensions: string[]) => {
    openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", `${prefix}-key.pem`, "-out", `${prefix}-cert.pem`, "-days", "1", "-sha256",
      "-subj", `/CN=${name}`, ...extensions.flatMap(value => ["-addext", value]));
  };
  const createSigned = (prefix: string, name: string, issuer: string, extensions: string) => {
    openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", `${prefix}-key.pem`, "-out", `${prefix}.csr`, "-subj", `/CN=${name}`);
    writeFileSync(path(`${prefix}.ext`), extensions);
    openssl("x509", "-req", "-in", `${prefix}.csr`, "-CA", `${issuer}-cert.pem`,
      "-CAkey", `${issuer}-key.pem`, "-CAcreateserial", "-out", `${prefix}-cert.pem`,
      "-days", "1", "-sha256", "-extfile", `${prefix}.ext`);
  };
  try {
    createSelfSigned("server", "127.0.0.1", [
      "subjectAltName=IP:127.0.0.1", "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,digitalSignature,keyCertSign",
    ]);
    createSelfSigned("other-server", "wrong.example", [
      "subjectAltName=DNS:wrong.example", "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,digitalSignature,keyCertSign",
    ]);
    createSigned("substitute-server", "127.0.0.1", "server",
      "subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n");
    createSelfSigned("client-ca", "test-client-ca", [
      "basicConstraints=critical,CA:TRUE", "keyUsage=critical,keyCertSign,digitalSignature",
    ]);
    createSigned("client", "approved-test-client", "client-ca",
      "basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=clientAuth\n");
    createSelfSigned("wrong-client", "unapproved-test-client", [
      "basicConstraints=critical,CA:FALSE", "keyUsage=digitalSignature", "extendedKeyUsage=clientAuth",
    ]);
    return {
      read: name => readFileSync(path(name), "utf8"),
      dispose: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
