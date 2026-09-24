import { describe, expect, test } from "bun:test";
import worker from "./worker";

const validEnv: Env = {
  APP_ID: "5049328",
  APP_SLUG: "ezcorp-github-auth",
  APP_CLIENT_ID: "Iv23linp84AzzvCGxstF",
};

function request(path: string, method = "GET", headers?: HeadersInit, env = validEnv): Response {
  return worker.fetch(new Request(`https://directory.example${path}`, { method, headers }), env);
}

describe("public GitHub App directory Worker", () => {
  test("serves only public device-flow metadata and a static help page", async () => {
    const metadata = request("/.well-known/ezcorp-github.json");
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(metadata.headers.get("cache-control")).toBe("no-store");
    expect(await metadata.json()).toEqual({
      schemaVersion: 1,
      flow: "device",
      appId: 5049328,
      appSlug: "ezcorp-github-auth",
      clientId: "Iv23linp84AzzvCGxstF",
    });

    const home = request("/");
    const html = await home.text();
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(home.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(home.headers.get("content-security-policy")).toContain("style-src 'self'");
    expect(home.headers.get("x-frame-options")).toBe("DENY");
    expect(home.headers.get("referrer-policy")).toBe("no-referrer");
    expect(home.headers.has("set-cookie")).toBe(false);
    expect(html).toContain('<main class="shell">');
    expect(html).toContain('href="/style.css"');
    expect(html).toContain('class="hero"');
    expect(html).toContain('class="steps"');
    expect(html).toContain("https://github.com/login/device");
    expect(html).toContain("https://github.com/apps/ezcorp-github-auth");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<style");
    const style = request("/style.css");
    const css = await style.text();
    expect(style.status).toBe(200);
    expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css).toContain("@media(max-width:540px)");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).not.toContain("@import");
    expect(css).not.toContain("url(");
    expect(await request("/health").text()).toBe("ok");
  });

  test("HEAD returns each route's status and headers with no body", async () => {
    for (const path of ["/", "/style.css", "/.well-known/ezcorp-github.json", "/health", "/missing"]) {
      const get = request(path);
      const head = request(path, "HEAD");
      expect(head.status).toBe(get.status);
      expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
      expect(await head.text()).toBe("");
    }
  });

  test("rejects every other method, input-bearing URL, and credential header", async () => {
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const result = request("/", method);
      expect(result.status).toBe(405);
      expect(result.headers.get("allow")).toBe("GET, HEAD");
    }
    for (const path of ["/?code=secret", "/?", "/health?x=1", "/.well-known/ezcorp-github.json?installation_id=42"]) {
      const result = request(path);
      expect(result.status).toBe(400);
      expect(await result.text()).toBe("Bad Request");
    }
    for (const headers of [new Headers({ cookie: "session=secret" }), new Headers({ authorization: "Bearer secret" })]) {
      const result = request("/", "GET", headers);
      expect(result.status).toBe(400);
      expect(await result.text()).toBe("Bad Request");
    }
    expect(request("/token").status).toBe(404);
    expect(request("/callback").status).toBe(404);
  });

  test("fails closed for missing or malformed public configuration without exposing values", async () => {
    const invalid: Env[] = [
      {},
      { ...validEnv, APP_ID: "" },
      { ...validEnv, APP_ID: "0" },
      { ...validEnv, APP_ID: "9007199254740992" },
      { ...validEnv, APP_SLUG: "" },
      { ...validEnv, APP_SLUG: "BAD/slug" },
      { ...validEnv, APP_SLUG: "a".repeat(101) },
      { ...validEnv, APP_CLIENT_ID: "" },
      { ...validEnv, APP_CLIENT_ID: "secret" },
    ];
    for (const env of invalid) {
      for (const path of ["/", "/style.css", "/health", "/.well-known/ezcorp-github.json"]) {
        const result = request(path, "GET", undefined, env);
        expect(result.status).toBe(503);
        expect(await result.text()).toBe("Service Unavailable");
      }
    }
    const head = request("/", "HEAD", undefined, invalid[0]);
    expect(head.status).toBe(503);
    expect(await head.text()).toBe("");
  });
});
