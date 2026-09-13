import { expect, test } from "bun:test";
import { authorize } from "./factory-temporal-authorizer.mjs";

const token = (claims: Record<string, unknown>) => `Bearer x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`;
const headers = (claims: Record<string, unknown>, certificate = "tenant-01") => new Headers({ authorization: token(claims), "x-forwarded-client-cert": `By=spiffe;Subject="CN=${certificate}"` });
const valid = { sub: "tenant-01", iss: "ezcorp-factory-local", aud: "ezcorp-temporal", exp: Math.floor(Date.now() / 1000) + 60, permissions: ["admin:tenant-01"] };

test("accepts only aligned certificate and signed-token claims", () => { expect(authorize(headers(valid))).toBeTrue(); });
test("rejects issuer, audience, expiry, certificate, and foreign namespace permissions", () => {
  expect(authorize(headers({ ...valid, iss: "wrong" }))).toBeFalse();
  expect(authorize(headers({ ...valid, aud: "wrong" }))).toBeFalse();
  expect(authorize(headers({ ...valid, exp: 0 }))).toBeFalse();
  expect(authorize(headers(valid, "tenant-02"))).toBeFalse();
  expect(authorize(headers({ ...valid, permissions: ["admin:tenant-02"] }))).toBeFalse();
});
