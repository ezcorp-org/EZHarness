import { describe, expect, test } from "bun:test";
import { verifiedObservation } from "./incus-create-noeffect-recovery";

const expected = { project: "ezharness", instance: "ezh-0123456789abcdef0123456789abcdef",
  oldCertificateSha256: "a".repeat(64) };
const valid = { version: 1, ...expected, absent: true, activeOperations: [], oldCertificateRevoked: true };
const reply = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value) });

describe("independent no-effect observer reply", () => {
  test("accepts only the pinned, revoked, empty observation", () => {
    expect(verifiedObservation(reply(valid), expected)).toEqual({ absent: true, activeOperations: [] });
  });

  test("rejects malformed and stale replies", () => {
    for (const result of [
      { status: 0, stdout: "{" },
      reply(null),
      reply({ ...valid, version: 0 }),
      reply({ ...valid, oldCertificateRevoked: false }),
      reply({ ...valid, extra: "unreviewed" }),
      reply({ ...valid, activeOperations: ["/1.0/operations/in-flight"] }),
      reply({ ...valid, project: "other" }),
      reply({ ...valid, instance: "ezh-previous" }),
      reply({ ...valid, oldCertificateSha256: "b".repeat(64) }),
    ]) {
      expect(() => verifiedObservation(result, expected)).toThrow("independent Incus observation");
    }
  });

  test("rejects SSH failure even if stdout contains a successful old reply", () => {
    expect(() => verifiedObservation({ status: 255, stdout: JSON.stringify(valid) }, expected))
      .toThrow("independent Incus observation failed");
    expect(() => verifiedObservation({ status: null, error: new Error("timeout"),
      stdout: JSON.stringify(valid) }, expected)).toThrow("independent Incus observation failed");
  });
});
