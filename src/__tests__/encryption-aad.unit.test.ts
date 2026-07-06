import { test, expect, describe } from "bun:test";
import {
  encrypt,
  decrypt,
  encryptWithAad,
  decryptWithAad,
} from "../providers/encryption";

// providers/** is EXCLUDES'd from the coverage gate — this suite is for
// correctness only. It proves the AAD variants bind a ciphertext to its scope
// and that the plain (no-AAD) path is byte-compatible / unaffected.

describe("encryptWithAad / decryptWithAad", () => {
  test("round-trips with the matching aad", () => {
    const aad = "github-projects:proj-123";
    const ct = encryptWithAad("ghp_secretvalue", aad);
    expect(decryptWithAad(ct, aad)).toBe("ghp_secretvalue");
  });

  test("decrypting with a DIFFERENT aad throws (GCM auth-tag mismatch)", () => {
    const ct = encryptWithAad("ghp_secretvalue", "github-projects:proj-123");
    expect(() => decryptWithAad(ct, "github-projects:proj-999")).toThrow();
  });

  test("plain decrypt() of an aad-bound ciphertext throws", () => {
    const ct = encryptWithAad("ghp_secretvalue", "github-projects:proj-123");
    expect(() => decrypt(ct)).toThrow();
  });

  test("decryptWithAad of a plain (no-aad) ciphertext throws", () => {
    const ct = encrypt("ghp_secretvalue");
    expect(() => decryptWithAad(ct, "github-projects:proj-123")).toThrow();
  });

  test("wire format is the same v1:iv:tag:ct shape", () => {
    const ct = encryptWithAad("x", "ext:proj");
    const parts = ct.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
  });
});

describe("plain encrypt / decrypt regression (unchanged by the AAD refactor)", () => {
  test("still round-trips", () => {
    const ct = encrypt("hello world");
    expect(decrypt(ct)).toBe("hello world");
  });

  test("rejects a malformed ciphertext", () => {
    expect(() => decrypt("not-a-valid-format")).toThrow();
  });
});
