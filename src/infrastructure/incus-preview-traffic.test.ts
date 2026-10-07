import { expect, test } from "bun:test";
import { createIncusPreviewTrafficDriver } from "./incus-preview-traffic";

const PREVIEW_ID = "abcdefghjkmnpqrstvwxyz0123";
const OTHER_ID = "z0123456789abcdefghjkmnpqr";
const CODE = "a".repeat(64);
const COOKIE = "__ezpreview=header.payload.signature";

function traffic(port: number, previewHost = "localhost") {
  return createIncusPreviewTrafficDriver({ env: {
    EZCORP_PUBLIC_URL: `http://127.0.0.1:${port}`,
    EZCORP_PREVIEW_APP_HOST: previewHost,
  } });
}

test("real Bun app route proves ready, one-time handoff, bounded HTTP and vite-hmr WebSocket", async () => {
  let closed = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      const previewHost = `${PREVIEW_ID}.preview.localhost:${bunServer.port}`;
      if (url.pathname === "/api/ready") return new Response("ready");
      if (request.headers.get("host") !== previewHost) return new Response("wrong preview host", { status: 404 });
      if (url.pathname === "/__open") {
        return url.searchParams.get("c") === CODE
          ? new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": `${COOKIE}; Path=/; HttpOnly; SameSite=Lax` } })
          : new Response("bad code", { status: 404 });
      }
      if (request.headers.get("cookie") !== COOKIE) return new Response("no preview cookie", { status: 403 });
      if (url.pathname === "/hmr" || url.pathname === "/hmr-large") {
        if (request.headers.get("origin") !== `http://${previewHost}`) return new Response("wrong origin", { status: 403 });
        return bunServer.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "vite-hmr" },
          data: { large: url.pathname === "/hmr-large" } })
          ? undefined : new Response("upgrade denied", { status: 400 });
      }
      if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { Location: "https://outside.example/" } });
      if (url.pathname === "/large") return new Response("x".repeat(512 * 1024 + 1));
      return new Response("guest page");
    },
    websocket: { message(socket, message) { socket.send((socket.data as { large?: boolean })?.large
      ? "x".repeat(8 * 1024 + 1) : message); }, close() { closed++; } },
  });
  try {
    const driver = traffic(server.port);
    await driver.ready();
    const handoff = await driver.handoff({ previewId: PREVIEW_ID, code: CODE });
    expect(handoff).toEqual({ status: 302, cookie: COOKIE });
    const page = await driver.http({ previewId: PREVIEW_ID, cookie: handoff.cookie, path: "/page" });
    expect(page.status).toBe(200);
    expect(Buffer.from(page.body).toString()).toBe("guest page");
    expect(page.location).toBeNull();
    const ws = await driver.webSocket({ previewId: PREVIEW_ID, cookie: handoff.cookie,
      path: "/hmr", subprotocol: "vite-hmr", challenge: "hmr-challenge" });
    expect(ws).toEqual({ status: 101, subprotocol: "vite-hmr", reply: "hmr-challenge" });
    for (let attempt = 0; attempt < 50 && closed < 1; attempt++) await Bun.sleep(10);
    expect(closed).toBe(1);
    await expect(driver.webSocket({ previewId: PREVIEW_ID, cookie: handoff.cookie,
      path: "/hmr-large", subprotocol: "vite-hmr", challenge: "hmr-challenge" }))
      .rejects.toThrow("limit");
    for (let attempt = 0; attempt < 50 && closed < 2; attempt++) await Bun.sleep(10);
    expect(closed).toBe(2);
    expect((await driver.handoff({ previewId: PREVIEW_ID, code: "b".repeat(64) })).status).toBe(404);
    expect(await driver.http({ previewId: PREVIEW_ID, cookie: handoff.cookie, path: "/redirect" }))
      .toMatchObject({ status: 302, location: "https://outside.example/" });
    await expect(driver.http({ previewId: PREVIEW_ID, cookie: handoff.cookie, path: "/large" }))
      .rejects.toThrow("limit");
    expect((await driver.http({ previewId: OTHER_ID, cookie: handoff.cookie, path: "/page" })).status).toBe(404);
    expect((await driver.http({ previewId: PREVIEW_ID, cookie: null, path: "/page" })).status).toBe(403);
    expect((await driver.http({ previewId: PREVIEW_ID, cookie: handoff.cookie, path: "/page", wrongHost: true })).status).toBe(404);
    expect((await driver.http({ previewId: PREVIEW_ID, cookie: handoff.cookie, path: "/page", malformedHost: true })).status).toBe(404);
    const denied = await driver.webSocket({ previewId: PREVIEW_ID, cookie: "__ezpreview=wrong", path: "/hmr",
      subprotocol: "vite-hmr", challenge: "no" });
    expect(denied).toEqual({ status: 403, subprotocol: null, reply: "" });
    const wrongOrigin = await driver.webSocket({ previewId: PREVIEW_ID, cookie: handoff.cookie, path: "/hmr",
      subprotocol: "vite-hmr", challenge: "no", wrongOrigin: true });
    expect(wrongOrigin).toEqual({ status: 403, subprotocol: null, reply: "" });
  } finally { server.stop(true); }
});

test("traffic driver refuses missing preview origin and an unready app before any preview action", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => new Response("not ready", { status: 503 }) });
  try {
    await expect(traffic(server.port, "").ready()).rejects.toThrow("not configured");
    const driver = traffic(server.port);
    await expect(driver.ready()).rejects.toThrow("not ready");
    await expect(driver.handoff({ previewId: PREVIEW_ID, code: CODE })).rejects.toThrow("not ready");
  } finally { server.stop(true); }
});

test("traffic driver rejects caller paths, credentials and oversized challenges before network effects", async () => {
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: request => { hits++; return new Response(new URL(request.url).pathname === "/api/ready" ? "ready" : "effect"); } });
  try {
    const driver = traffic(server.port);
    await driver.ready();
    expect(hits).toBe(1);
    await expect(driver.http({ previewId: PREVIEW_ID, cookie: "evil=secret", path: "/page" })).rejects.toThrow("cookie");
    await expect(driver.http({ previewId: PREVIEW_ID, cookie: COOKIE, path: "//outside.example" })).rejects.toThrow("path");
    await expect(driver.http({ previewId: PREVIEW_ID, cookie: COOKIE, path: "/page",
      wrongHost: true, malformedHost: true })).rejects.toThrow("Host mode");
    await expect(driver.handoff({ previewId: PREVIEW_ID, code: "wrong" })).rejects.toThrow("code");
    await expect(driver.webSocket({ previewId: PREVIEW_ID, cookie: COOKIE, path: "/hmr",
      subprotocol: "vite-hmr", challenge: "x".repeat(257) })).rejects.toThrow("challenge");
    await expect(driver.webSocket({ previewId: PREVIEW_ID, cookie: "evil=secret", path: "/hmr",
      subprotocol: "vite-hmr", challenge: "x" })).rejects.toThrow("cookie");
    expect(hits).toBe(1);
  } finally { server.stop(true); }
});
