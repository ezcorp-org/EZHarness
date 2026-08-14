/**
 * `principalId` — the comparable identity a parked permission gate is
 * confined to.
 *
 * The security-relevant properties, and why each is a test rather than a
 * comment:
 *   - Two keys owned by ONE user must not collide, or a narrow leaked key
 *     inherits the consent its sibling earned.
 *   - A key must not collide with its owner's SESSION, or the whole
 *     confinement is a no-op for the only principal it targets.
 *   - Anything the function cannot fully name returns `undefined`, because
 *     every caller reads `undefined` as "cannot be shown to match" — a
 *     partial id would instead be a value two principals could share.
 */

import { test, expect, describe } from "bun:test";
import { principalId } from "../auth/principal-id";

describe("principalId", () => {
  test("cookie session -> session:<userId>", () => {
    expect(principalId({ authMethod: "session", user: { id: "u1" } })).toBe("session:u1");
  });

  test("api key -> api-key:<keyId>", () => {
    expect(
      principalId({ authMethod: "api-key", user: { id: "u1" }, apiKeyId: "k1" }),
    ).toBe("api-key:k1");
  });

  test("internal key -> internal:<keyId>", () => {
    expect(
      principalId({ authMethod: "internal", user: { id: "sys-1" }, apiKeyId: "ik1" }),
    ).toBe("internal:ik1");
  });

  test("two keys of the SAME user are distinguishable", () => {
    const a = principalId({ authMethod: "api-key", user: { id: "u1" }, apiKeyId: "k1" });
    const b = principalId({ authMethod: "api-key", user: { id: "u1" }, apiKeyId: "k2" });
    expect(a).not.toBe(b);
  });

  test("a key never collides with its owner's session, nor an internal key with a user key", () => {
    const session = principalId({ authMethod: "session", user: { id: "u1" } });
    const key = principalId({ authMethod: "api-key", user: { id: "u1" }, apiKeyId: "u1" });
    const internal = principalId({ authMethod: "internal", user: { id: "u1" }, apiKeyId: "u1" });
    expect(session).not.toBe(key);
    expect(key).not.toBe(internal);
  });

  test("no authMethod -> undefined, even with a user present", () => {
    expect(principalId({ user: { id: "u1" } })).toBe(undefined);
  });

  test("session with no user -> undefined", () => {
    expect(principalId({ authMethod: "session" })).toBe(undefined);
  });

  test("key principal with no key id -> undefined, not a bare method name", () => {
    // A `"api-key:"` (or `"api-key"`) id would be shared by every key that
    // failed to stamp one — the single value most likely to match by
    // accident. Refuse to mint it.
    expect(principalId({ authMethod: "api-key", user: { id: "u1" } })).toBe(undefined);
    expect(principalId({ authMethod: "internal", user: { id: "u1" } })).toBe(undefined);
  });

  test("key principal with an EMPTY key id -> undefined", () => {
    expect(
      principalId({ authMethod: "api-key", user: { id: "u1" }, apiKeyId: "" }),
    ).toBe(undefined);
  });

  test("a key principal does not need a user row to be named", () => {
    // The id keys on the KEY, not its owner — so it survives the owner
    // being absent from `locals` for any reason.
    expect(principalId({ authMethod: "api-key", apiKeyId: "k9" })).toBe("api-key:k9");
  });
});
