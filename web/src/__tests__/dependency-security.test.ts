import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const strykerRequire = createRequire(require.resolve("@stryker-mutator/core"));
const typedRestRequire = createRequire(strykerRequire.resolve("typed-rest-client"));
const kitRequire = createRequire(require.resolve("@sveltejs/kit/package.json"));
const ajvRequire = createRequire(require.resolve("ajv/package.json"));
const jsdomRequire = createRequire(require.resolve("jsdom/package.json"));
const minimatchRequire = createRequire(require.resolve("minimatch/package.json"));
const purifierRequire = createRequire(require.resolve("isomorphic-dompurify/package.json"));

test("Stryker's HTTP client resolves the patched qs and still encodes query parameters", () => {
  const qs = typedRestRequire("qs");
  expect(typedRestRequire("qs/package.json").version).toBe("6.16.0");

  // Each input is a published advisory reproducer for the pinned 6.15.1.
  expect(qs.stringify({ a: [null, "b"] }, { arrayFormat: "comma", encodeValuesOnly: true })).toBe("a=,b");
  expect(() => qs.stringify(qs.parse("x%5Bconstructor%5D%5BisBuffer%5D=y", { plainObjects: true }))).not.toThrow();
  expect(() => qs.parse("a[]=1,2,3,4", { comma: true, arrayLimit: 3, throwOnLimitExceeded: true })).toThrow(RangeError);

  const { getUrl } = typedRestRequire("typed-rest-client/Util.js");
  expect(getUrl("/search", "https://example.test/api/", {
    params: { tag: ["one", "two"], q: "a b" },
  })).toBe("https://example.test/search?tag=one&tag=two&q=a%20b");
});

test("SvelteKit sets, reads, and clears the app session with the patched cookie serializer", async () => {
  const cookie = kitRequire("cookie");
  expect(kitRequire("cookie/package.json").version).toBe("0.7.2");
  expect(() => cookie.serialize("evil;name", "value")).toThrow(TypeError);
  expect(() => cookie.serialize("safe", "value", { path: "/; HttpOnly" })).toThrow(TypeError);
  expect(() => cookie.serialize("safe", "value", { domain: "example.test; Secure" })).toThrow(TypeError);

  const kitRoot = dirname(require.resolve("@sveltejs/kit/package.json"));
  const { get_cookies, add_cookies_to_headers } = await import(
    pathToFileURL(join(kitRoot, "src/runtime/server/cookie.js")).href
  );
  const url = new URL("http://localhost/api/auth/login");
  const issued = get_cookies(new Request(url), url);
  issued.set_trailing_slash("never");
  issued.cookies.set("ezcorp_session", "signed.token", {
    path: "/", httpOnly: true, sameSite: "lax", maxAge: 3600, secure: false,
  });
  const headers = new Headers();
  add_cookies_to_headers(headers, issued.new_cookies.values());
  const setCookie = headers.get("set-cookie");
  expect(setCookie).toContain("ezcorp_session=signed.token");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Lax");

  const followUpUrl = new URL("http://localhost/api/me");
  const followUp = get_cookies(new Request(followUpUrl, { headers: { cookie: setCookie!.split(";")[0] } }), followUpUrl);
  followUp.set_trailing_slash("never");
  expect(followUp.cookies.get("ezcorp_session")).toBe("signed.token");

  followUp.cookies.set("ezcorp_session", "", { path: "/", httpOnly: true, sameSite: "lax", maxAge: 0 });
  const clearedHeaders = new Headers();
  add_cookies_to_headers(clearedHeaders, followUp.new_cookies.values());
  expect(clearedHeaders.get("set-cookie")).toContain("Max-Age=0");
  expect(followUp.cookies.get("ezcorp_session")).toBeUndefined();
});

test("SvelteKit serializes page data with the patched devalue", async () => {
  expect(kitRequire("devalue/package.json").version).toBe("5.9.4");
  const { parse, stringify } = await import(pathToFileURL(kitRequire.resolve("devalue")).href);
  const pageData = { conversations: [{ id: "chat-1", title: "<script>unsafe</script>" }], active: true };
  expect(parse(stringify(pageData))).toEqual(pageData);
  expect(stringify(pageData)).not.toContain("<script>");
});

test("Ajv's patched URI parser treats percent-encoded host letters as equal", () => {
  expect(ajvRequire("fast-uri/package.json").version).toBe("3.1.8");
  const uri = ajvRequire("fast-uri");
  // GHSA-hrr3-gc8f-f4qj: 3.1.7 kept the first host as A.com and equal() returned false.
  expect(uri.parse("//%41.com").host).toBe("a.com");
  expect(uri.equal("//%41.com", "//a.com")).toBe(true);
});

test("jsdom's WebSocket constructor loads the patched undici", () => {
  expect(jsdomRequire("undici/package.json").version).toBe("8.11.2");
  const { JSDOM } = jsdomRequire("jsdom");
  const dom = new JSDOM("", { url: "https://example.test/" });
  try {
    expect(dom.window.WebSocket).toBeDefined();
    expect(() => new dom.window.WebSocket("not-a-websocket-url")).toThrow();
  } finally {
    dom.window.close();
  }
});

test("minimatch expands normal braces with the patched bounded expander", () => {
  expect(minimatchRequire("brace-expansion/package.json").version).toBe("5.0.12");
  const { minimatch } = minimatchRequire("minimatch");
  expect(minimatch("file.ts", "*.{ts,js}")).toBe(true);
  expect(minimatch("file.md", "*.{ts,js}")).toBe(false);
});

test("isomorphic-dompurify removes active markup with the patched sanitizer", () => {
  expect(purifierRequire("dompurify/package.json").version).toBe("3.4.16");
  const purifier = require("isomorphic-dompurify");
  expect(purifier.sanitize('<img src="x" onerror="alert(1)"><b>safe</b>'))
    .toBe('<img src="x"><b>safe</b>');
});
