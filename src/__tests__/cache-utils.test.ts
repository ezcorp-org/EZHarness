import { describe, test, expect } from "bun:test";
import { etagFor, cacheableResponse } from "../lib/cache-utils";

// ── etagFor ───────────────────────────────────────────────────────────

describe("etagFor", () => {
  test("returns a quoted hex string", async () => {
    const etag = await etagFor({ foo: "bar" });
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
  });

  test("same data produces the same ETag", async () => {
    const data = { name: "Alice", items: [1, 2, 3] };
    const a = await etagFor(data);
    const b = await etagFor(data);
    expect(a).toBe(b);
  });

  test("different data produces different ETags", async () => {
    const a = await etagFor({ version: 1 });
    const b = await etagFor({ version: 2 });
    expect(a).not.toBe(b);
  });

  test("works with arrays", async () => {
    const etag = await etagFor([1, 2, 3]);
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
  });

  test("works with primitives — string", async () => {
    const etag = await etagFor("hello");
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
  });

  test("works with primitives — number", async () => {
    const etag = await etagFor(42);
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
  });

  test("works with null", async () => {
    const etag = await etagFor(null);
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
  });

  test("empty object and non-empty object produce different ETags", async () => {
    const a = await etagFor({});
    const b = await etagFor({ key: "value" });
    expect(a).not.toBe(b);
  });

  test("key order in object affects ETag (JSON.stringify is order-sensitive)", async () => {
    const a = await etagFor({ x: 1, y: 2 });
    const b = await etagFor({ y: 2, x: 1 });
    // JSON.stringify preserves insertion order, so these differ
    expect(a).not.toBe(b);
  });
});

// ── cacheableResponse ─────────────────────────────────────────────────

describe("cacheableResponse", () => {
  function makeRequest(headers: Record<string, string> = {}): Request {
    return new Request("http://localhost/api/data", { headers });
  }

  test("returns 200 with ETag and body on fresh request", async () => {
    const data = { agents: ["alice", "bob"] };
    const req = makeRequest();

    const res = await cacheableResponse(req, data);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(data);
  });

  test("includes ETag header on 200 response", async () => {
    const data = { version: 1 };
    const req = makeRequest();

    const res = await cacheableResponse(req, data);

    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{16}"$/);
  });

  test("ETag header matches etagFor() output", async () => {
    const data = { items: [1, 2, 3] };
    const req = makeRequest();

    const [res, expectedEtag] = await Promise.all([
      cacheableResponse(req, data),
      etagFor(data),
    ]);

    expect(res.headers.get("ETag")).toBe(expectedEtag);
  });

  test("returns 304 when If-None-Match matches current ETag", async () => {
    const data = { status: "ok" };
    const etag = await etagFor(data);
    const req = makeRequest({ "if-none-match": etag });

    const res = await cacheableResponse(req, data);

    expect(res.status).toBe(304);
    // 304 has no body
    const text = await res.text();
    expect(text).toBe("");
  });

  test("returns 200 when If-None-Match does not match", async () => {
    const data = { status: "ok" };
    const req = makeRequest({ "if-none-match": '"stale-etag-value"' });

    const res = await cacheableResponse(req, data);

    expect(res.status).toBe(200);
  });

  test("includes default Cache-Control header (max-age=60, swr=300)", async () => {
    const req = makeRequest();
    const res = await cacheableResponse(req, { x: 1 });

    const cc = res.headers.get("Cache-Control");
    expect(cc).toBe("private, max-age=60, stale-while-revalidate=300");
  });

  test("respects custom maxAge option", async () => {
    const req = makeRequest();
    const res = await cacheableResponse(req, { x: 1 }, { maxAge: 120 });

    const cc = res.headers.get("Cache-Control");
    expect(cc).toContain("max-age=120");
  });

  test("respects custom staleWhileRevalidate option", async () => {
    const req = makeRequest();
    const res = await cacheableResponse(req, { x: 1 }, { staleWhileRevalidate: 600 });

    const cc = res.headers.get("Cache-Control");
    expect(cc).toContain("stale-while-revalidate=600");
  });

  test("respects both custom maxAge and staleWhileRevalidate together", async () => {
    const req = makeRequest();
    const res = await cacheableResponse(req, { x: 1 }, { maxAge: 30, staleWhileRevalidate: 900 });

    const cc = res.headers.get("Cache-Control");
    expect(cc).toBe("private, max-age=30, stale-while-revalidate=900");
  });

  test("content-type is application/json on 200", async () => {
    const req = makeRequest();
    const res = await cacheableResponse(req, { hello: "world" });

    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("data changes produce different ETags (cache invalidation)", async () => {
    const v1 = { version: 1 };
    const v2 = { version: 2 };
    const req = makeRequest();

    const res1 = await cacheableResponse(req, v1);
    const res2 = await cacheableResponse(req, v2);

    expect(res1.headers.get("ETag")).not.toBe(res2.headers.get("ETag"));
  });

  test("stale If-None-Match gets 200 with updated data", async () => {
    const oldData = { items: ["a"] };
    const newData = { items: ["a", "b"] };
    const oldEtag = await etagFor(oldData);
    const req = makeRequest({ "if-none-match": oldEtag });

    const res = await cacheableResponse(req, newData);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(newData);
  });
});
