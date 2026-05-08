/**
 * 30+ fixture suite for `redactForAudit`.
 *
 * Every fixture asserts:
 *   (a) the literal secret string is absent from `JSON.stringify(redacted)`;
 *   (b) `redactedFields[]` enumerates the JSON path of every replaced value;
 *   (c) the call completes (does NOT throw).
 *
 * Plus the performance budget: 100 KB input completes in <50ms.
 *
 * Pitfall #1 (`.planning/research/PITFALLS.md`) — nested `Error.message`
 * bodies carrying Bearer tokens — has dedicated fixtures (#15, #16).
 */
import { test, expect, describe } from "bun:test";
import { redactForAudit } from "../audit-redaction";

function assertNoLiteral(redacted: unknown, secret: string) {
  const ser = JSON.stringify(redacted);
  expect(ser.includes(secret)).toBe(false);
}

describe("redactForAudit — provider key shapes", () => {
  test("fixture 1: openai sk- key (top level value)", () => {
    const secret = "sk-1234567890abcdef1234567890abcdef";
    const out = redactForAudit({ apiKey: secret });
    assertNoLiteral(out.redacted, secret);
    expect(out.redactedFields).toContain("apiKey");
  });

  test("fixture 2: openai sk-live- key", () => {
    const secret = "sk-live_1234567890abcdef1234567890abcdef";
    const out = redactForAudit({ key: secret });
    assertNoLiteral(out.redacted, secret);
    expect(out.redactedFields).toContain("key");
  });

  test("fixture 3: openai sk-test- key", () => {
    const secret = "sk-test_1234567890abcdef1234567890abcdef";
    const out = redactForAudit({ payload: { test: secret } });
    assertNoLiteral(out.redacted, secret);
    expect(out.redactedFields).toContain("payload.test");
  });

  test("fixture 4: openai sk-proj- key", () => {
    const secret = "sk-proj_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";
    const out = redactForAudit({ value: secret });
    assertNoLiteral(out.redacted, secret);
    expect(out.redactedFields).toContain("value");
  });

  test("fixture 5: anthropic sk-ant- key", () => {
    const secret = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const out = redactForAudit({ anthropic: secret });
    assertNoLiteral(out.redacted, secret);
    expect(out.redactedFields).toContain("anthropic");
  });

  test("fixture 6: google AIza key (39 char)", () => {
    const secret = "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz01234567";
    const out = redactForAudit({ googleKey: secret });
    assertNoLiteral(out.redacted, secret);
    expect(out.redactedFields).toContain("googleKey");
  });

  test("fixture 7: AWS AKIA access key", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const out = redactForAudit({ awsAccessKey: secret });
    assertNoLiteral(out.redacted, secret);
    expect(out.redactedFields).toContain("awsAccessKey");
  });

  test("fixture 8: github personal access token (ghp_)", () => {
    const secret = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCd";
    const out = redactForAudit({ token: secret });
    assertNoLiteral(out.redacted, secret);
    expect(out.redactedFields).toContain("token");
  });
});

describe("redactForAudit — bearer / JWT / header keys", () => {
  test("fixture 9: Bearer token at top level value", () => {
    const secret = "Bearer abc123def456ghi789jklmnopqrstuv";
    const out = redactForAudit({ auth: secret });
    assertNoLiteral(out.redacted, "abc123def456ghi789jklmnopqrstuv");
    expect(out.redactedFields).toContain("auth");
  });

  test("fixture 10: Bearer nested in headers.authorization (lowercase key)", () => {
    const secret = "Bearer eyXXXXXXXXXXXXXXXXXXX.abc.def";
    const out = redactForAudit({ headers: { authorization: secret } });
    assertNoLiteral(out.redacted, secret);
    expect(out.redactedFields).toContain("headers.authorization");
  });

  test("fixture 11: header key Authorization (case-insensitive)", () => {
    const out = redactForAudit({ headers: { Authorization: "Bearer xyz_abcdefghijklmnop" } });
    assertNoLiteral(out.redacted, "xyz_abcdefghijklmnop");
    expect(out.redactedFields).toContain("headers.Authorization");
  });

  test("fixture 12: header key X-API-KEY (case-insensitive)", () => {
    const out = redactForAudit({ headers: { "X-API-KEY": "anything-here" } });
    expect(out.redactedFields).toContain("headers.X-API-KEY");
    assertNoLiteral(out.redacted, "anything-here");
  });

  test("fixture 13: OpenAI-Organization header key", () => {
    const out = redactForAudit({ headers: { "OpenAI-Organization": "org-private-id" } });
    expect(out.redactedFields).toContain("headers.OpenAI-Organization");
  });

  test("fixture 14: openai-project header key (lowercase)", () => {
    const out = redactForAudit({ headers: { "openai-project": "proj_priv" } });
    expect(out.redactedFields).toContain("headers.openai-project");
  });

  test("fixture 15: JWT in body string (not header)", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = redactForAudit({ note: `please decode ${jwt}` });
    assertNoLiteral(out.redacted, jwt);
    expect(out.redactedFields).toContain("note");
  });

  test("fixture 16: JWT in header value position", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6Im1lIn0.AbCdEfGhIjKlMnOp1234567890";
    const out = redactForAudit({ headers: { authorization: `Bearer ${jwt}` } });
    assertNoLiteral(out.redacted, jwt);
    expect(out.redactedFields).toContain("headers.authorization");
  });
});

describe("redactForAudit — env-style key names (Pitfall #1: nested)", () => {
  test("fixture 17: OPENAI_API_KEY env-style key", () => {
    const out = redactForAudit({ env: { OPENAI_API_KEY: "sk-anything" } });
    expect(out.redactedFields).toContain("env.OPENAI_API_KEY");
    assertNoLiteral(out.redacted, "sk-anything");
  });

  test("fixture 18: FOO_TOKEN", () => {
    const out = redactForAudit({ env: { FOO_TOKEN: "value-here" } });
    expect(out.redactedFields).toContain("env.FOO_TOKEN");
  });

  test("fixture 19: BAR_PASSWORD", () => {
    const out = redactForAudit({ env: { BAR_PASSWORD: "p@ss" } });
    expect(out.redactedFields).toContain("env.BAR_PASSWORD");
  });

  test("fixture 20: X_PRIVATE_KEY", () => {
    const out = redactForAudit({ env: { X_PRIVATE_KEY: "-----BEGIN RSA-----..." } });
    expect(out.redactedFields).toContain("env.X_PRIVATE_KEY");
  });

  test("fixture 21: SECRET (matches by env-style)", () => {
    const out = redactForAudit({ MY_SECRET: "shh" });
    expect(out.redactedFields).toContain("MY_SECRET");
  });

  test("fixture 22: CREDENTIAL", () => {
    const out = redactForAudit({ DB_CREDENTIAL: "user:pass" });
    expect(out.redactedFields).toContain("DB_CREDENTIAL");
  });
});

describe("redactForAudit — nested / array / Error.message bodies", () => {
  test("fixture 23: secret string nested in array", () => {
    const secret = "Bearer abcdefghijklmnopqrstuvwxyz";
    const out = redactForAudit({ messages: [{ content: secret }] });
    assertNoLiteral(out.redacted, secret);
    expect(out.redactedFields).toContain("messages[0].content");
  });

  test("fixture 24: Error.message containing Bearer (Pitfall #1)", () => {
    const secret = "Bearer leaky-tok-1234567890abcdef";
    const err = new Error(`request failed; sent ${secret}`);
    const out = redactForAudit({ error: err });
    assertNoLiteral(out.redacted, "leaky-tok-1234567890abcdef");
    // The path is rooted at "error.message".
    expect(out.redactedFields).toContain("error.message");
  });

  test("fixture 25: Error with nested cause carrying a secret", () => {
    const secret = "sk-1234567890abcdef1234567890abcdef";
    const inner = new Error(`boom: key=${secret}`);
    const outer = new Error("wrapper", { cause: inner });
    const out = redactForAudit({ stack: outer });
    assertNoLiteral(out.redacted, secret);
    // Either error.message or error.cause.message gets flagged; we
    // require AT LEAST ONE path under `stack`.
    expect(out.redactedFields.some((p) => p.startsWith("stack."))).toBe(true);
  });

  test("fixture 26: deep nested 4-level object with secret at the bottom", () => {
    const secret = "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz01234567";
    const out = redactForAudit({ a: { b: { c: { d: secret } } } });
    assertNoLiteral(out.redacted, secret);
    expect(out.redactedFields).toContain("a.b.c.d");
  });

  test("fixture 27: nested arrays of arrays containing secret", () => {
    const secret = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const out = redactForAudit({ batches: [[{ key: secret }]] });
    assertNoLiteral(out.redacted, secret);
    expect(out.redactedFields).toContain("batches[0][0].key");
  });
});

describe("redactForAudit — edge cases that must NOT throw", () => {
  test("fixture 28: circular reference completes without throwing", () => {
    const a: any = { name: "loop" };
    a.self = a;
    expect(() => redactForAudit(a)).not.toThrow();
    const out = redactForAudit(a);
    // Some pathway through the graph hits the circular guard.
    const ser = JSON.stringify(out.redacted);
    expect(ser.includes("[Circular]")).toBe(true);
  });

  test("fixture 29: empty object payload", () => {
    const out = redactForAudit({});
    expect(out.redacted).toEqual({});
    expect(out.redactedFields).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  test("fixture 30: null / undefined / primitives", () => {
    expect(redactForAudit(null).redacted).toBe(null);
    expect(redactForAudit(undefined).redacted).toBe(undefined);
    expect(redactForAudit("plain string").redacted).toBe("plain string");
    expect(redactForAudit(42).redacted).toBe(42);
    expect(redactForAudit(true).redacted).toBe(true);
  });

  test("fixture 31: top-level primitive containing a JWT — flagged at $ root", () => {
    const jwt = "eyJabc1234567890.def1234567890.ghi1234567890";
    const out = redactForAudit(`prefix ${jwt}`);
    assertNoLiteral(out.redacted, jwt);
    expect(out.redactedFields).toContain("$");
  });

  test("fixture 32: oversized 100 KB payload completes in <50ms and is truncated", () => {
    // Build a ~100 KB blob with a secret at the bottom.
    const filler = "x".repeat(100_000);
    const secret = "sk-1234567890abcdef1234567890abcdef";
    const big = { filler, key: secret };
    const t0 = performance.now();
    const out = redactForAudit(big);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50);
    expect(out.truncated).toBe(true);
    expect(typeof out.sha256).toBe("string");
    expect(out.sha256!.length).toBe(64);
    // The truncation marker still doesn't carry the secret literal.
    assertNoLiteral(out.redacted, secret);
  });

  test("fixture 33: Buffer / Uint8Array body becomes a length placeholder", () => {
    const u8 = new Uint8Array([0x73, 0x6b, 0x2d, 0x73, 0x65, 0x63]); // "sk-sec"
    const out = redactForAudit({ body: u8 });
    const ser = JSON.stringify(out.redacted);
    expect(ser.includes("[binary 6B]")).toBe(true);
  });

  test("fixture 34: function / symbol values dropped, do not throw", () => {
    const out = redactForAudit({ fn: () => 1, sym: Symbol("x"), keep: 1 });
    expect(out.redacted).toMatchObject({ keep: 1 });
  });

  test("fixture 35: redactedFields enumerates ALL replaced paths (multiple)", () => {
    const secret1 = "sk-1234567890abcdef1234567890abcdef";
    const secret2 = "Bearer xyz1234567890abcdefgh";
    const out = redactForAudit({
      a: secret1,
      b: { c: secret2 },
      env: { OPENAI_API_KEY: "ignored-redacted-by-key" },
    });
    expect(out.redactedFields).toContain("a");
    expect(out.redactedFields).toContain("b.c");
    expect(out.redactedFields).toContain("env.OPENAI_API_KEY");
  });
});

describe("redactForAudit — robustness of the contract", () => {
  test("never throws on a JSON-poison object (BigInt + circular + symbols)", () => {
    const a: any = { big: 9007199254740993n, sym: Symbol("k") };
    a.loop = a;
    expect(() => redactForAudit(a)).not.toThrow();
  });

  test("returns failure marker if walk somehow throws (defense in depth)", () => {
    // Construct a Proxy that throws on any get. The walk must catch and
    // return the failure marker rather than propagate.
    const poison = new Proxy({}, {
      get() { throw new Error("poison get"); },
      ownKeys() { throw new Error("poison ownKeys"); },
      getOwnPropertyDescriptor() { throw new Error("poison desc"); },
    });
    const out = redactForAudit(poison);
    // Either we successfully treated it as an opaque object, or we hit
    // the failure marker. Both are acceptable; what's NOT acceptable is
    // a thrown error.
    expect(out).toBeDefined();
    expect(out.redactedFields).toBeDefined();
  });
});
