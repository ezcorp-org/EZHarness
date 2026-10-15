import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { factoryScramVerifier } from "./scram";
import { FactoryProvisioningError } from "./steps";

/**
 * RFC 7677 section 3: user "user", password "pencil". The check below is the
 * one the server runs at login: recover ClientKey from the client's proof,
 * compare its hash with StoredKey, and sign with ServerKey.
 */
const RFC7677 = {
  password: "pencil",
  salt: "W22ZaJ0SNY7soEsUEjb6gQ==",
  authMessage: "n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0",
  clientProof: "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=",
  serverSignature: "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
};

function parse(verifier: string): { iterations: number; salt: string; storedKey: Buffer; serverKey: Buffer } {
  const match = /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/.exec(verifier);
  if (!match) throw new Error("verifier does not have PostgreSQL's shape");
  return { iterations: Number(match[1]), salt: match[2]!, storedKey: Buffer.from(match[3]!, "base64"), serverKey: Buffer.from(match[4]!, "base64") };
}

describe("factoryScramVerifier", () => {
  test("the RFC 7677 exchange authenticates against the verifier, as the server checks it", () => {
    const verifier = parse(factoryScramVerifier(RFC7677.password, { salt: Buffer.from(RFC7677.salt, "base64") }));
    expect(verifier.iterations).toBe(4096);
    expect(verifier.salt).toBe(RFC7677.salt);
    const clientSignature = createHmac("sha256", verifier.storedKey).update(RFC7677.authMessage).digest();
    const clientKey = Buffer.from(RFC7677.clientProof, "base64").map((byte, index) => byte ^ clientSignature[index]!);
    expect(createHash("sha256").update(clientKey).digest().equals(verifier.storedKey)).toBe(true);
    expect(createHmac("sha256", verifier.serverKey).update(RFC7677.authMessage).digest("base64")).toBe(RFC7677.serverSignature);
  });

  test("a wrong password does not produce the same keys", () => {
    const salt = Buffer.from(RFC7677.salt, "base64");
    expect(parse(factoryScramVerifier("pencils", { salt })).storedKey.equals(parse(factoryScramVerifier(RFC7677.password, { salt })).storedKey)).toBe(false);
  });

  test("each call draws a fresh 16-byte salt and honours an explicit iteration count", () => {
    const first = parse(factoryScramVerifier("a-generated_password"));
    const second = parse(factoryScramVerifier("a-generated_password", { iterations: 8192 }));
    expect(Buffer.from(first.salt, "base64").byteLength).toBe(16);
    expect(first.salt).not.toBe(second.salt);
    expect(second.iterations).toBe(8192);
  });

  test("a password SASLprep could rewrite is refused, never hashed differently from the server", () => {
    for (const password of ["", "has space", "café", "tab\there"]) {
      const error = (() => { try { factoryScramVerifier(password); return undefined; } catch (caught) { return caught; } })();
      expect(error).toBeInstanceOf(FactoryProvisioningError);
      expect((error as FactoryProvisioningError).code).toBe("database_password_invalid");
    }
  });
});
