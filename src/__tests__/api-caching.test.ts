import { test, expect, describe } from "bun:test";
import { etagFor, cacheableResponse } from "../lib/cache-utils";

describe("etagFor", () => {
  test("returns a quoted hex string", async () => {
    const etag = await etagFor({ foo: "bar" });
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
  });

  test("returns the same ETag for the same data", async () => {
    const data = { users: [1, 2, 3] };
    const etag1 = await etagFor(data);
    const etag2 = await etagFor(data);
    expect(etag1).toBe(etag2);
  });

  test("returns a different ETag for different data", async () => {
    const etag1 = await etagFor({ a: 1 });
    const etag2 = await etagFor({ a: 2 });
    expect(etag1).not.toBe(etag2);
  });
});

describe("etagFor edge cases", () => {
  test("handles large data arrays", async () => {
    const largeData = Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `item-${i}` }));
    const etag = await etagFor(largeData);
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
  });

  test("handles null", async () => {
    const etag = await etagFor(null);
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
  });

  test("handles empty array", async () => {
    const etag = await etagFor([]);
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
  });

  test("handles empty object", async () => {
    const etag = await etagFor({});
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
  });
});

describe("cacheableResponse", () => {
  test("returns ETag and Cache-Control headers", async () => {
    const req = new Request("http://localhost/api/test");
    const res = await cacheableResponse(req, { items: [1] });
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]+"$/);
    expect(res.headers.get("Cache-Control")).toContain("max-age=");
    expect(res.headers.get("Cache-Control")).toContain("stale-while-revalidate=");
    expect(res.status).toBe(200);
  });

  test("returns 304 when If-None-Match matches ETag", async () => {
    const data = { items: [1, 2] };
    const etag = await etagFor(data);
    const req = new Request("http://localhost/api/test", {
      headers: { "If-None-Match": etag },
    });
    const res = await cacheableResponse(req, data);
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  test("returns 200 with body when If-None-Match does not match", async () => {
    const data = { items: [1, 2] };
    const req = new Request("http://localhost/api/test", {
      headers: { "If-None-Match": '"stale-etag"' },
    });
    const res = await cacheableResponse(req, data);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(data);
  });

  test("respects custom maxAge option", async () => {
    const req = new Request("http://localhost/api/test");
    const res = await cacheableResponse(req, { x: 1 }, { maxAge: 120 });
    expect(res.headers.get("Cache-Control")).toContain("max-age=120");
  });

  test("respects custom staleWhileRevalidate option", async () => {
    const req = new Request("http://localhost/api/test");
    const res = await cacheableResponse(req, { x: 1 }, { staleWhileRevalidate: 600 });
    expect(res.headers.get("Cache-Control")).toContain("stale-while-revalidate=600");
  });

  test("response body JSON matches input data on cache miss", async () => {
    const data = { agents: ["a", "b"], count: 2 };
    const req = new Request("http://localhost/api/test");
    const res = await cacheableResponse(req, data);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(data);
  });

  test("304 response has no body", async () => {
    const data = { items: [1] };
    const etag = await etagFor(data);
    const req = new Request("http://localhost/api/test", {
      headers: { "If-None-Match": etag },
    });
    const res = await cacheableResponse(req, data);
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
  });

  test("Content-Type is application/json on 200", async () => {
    const req = new Request("http://localhost/api/test");
    const res = await cacheableResponse(req, { ok: true });
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("handles null data", async () => {
    const req = new Request("http://localhost/api/test");
    const res = await cacheableResponse(req, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  test("handles empty array data", async () => {
    const req = new Request("http://localhost/api/test");
    const res = await cacheableResponse(req, []);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
