import { test, expect, describe } from "bun:test";
import {
  isWebSocketUpgrade,
  decideWebSocketUpgrade,
  isAllowedPreviewOrigin,
  type DecideWebSocketUpgradeDeps,
} from "../runtime/preview/preview-ws";
import type { PreviewRegistryRow } from "../runtime/preview/preview-proxy";

const VALID_ID = "abcdefghjkmnpqrstvwxyz0123";
const OTHER_ID = "z0123456789abcdefghjkmnpqr";
const APP_HOST = "ezcorp.example.com";

function hdr(map: Record<string, string>) {
  const h = new Headers(map);
  return { headers: { get: (n: string) => h.get(n) } };
}

describe("isWebSocketUpgrade", () => {
  test("true for Upgrade: websocket + Connection: Upgrade", () => {
    expect(isWebSocketUpgrade(hdr({ Upgrade: "websocket", Connection: "Upgrade" }))).toBe(true);
  });

  test("true with a multi-value Connection header (keep-alive, Upgrade)", () => {
    expect(
      isWebSocketUpgrade(hdr({ Upgrade: "WebSocket", Connection: "keep-alive, Upgrade" })),
    ).toBe(true);
  });

  test("false when not a websocket upgrade", () => {
    expect(isWebSocketUpgrade(hdr({}))).toBe(false);
    expect(isWebSocketUpgrade(hdr({ Upgrade: "h2c", Connection: "Upgrade" }))).toBe(false);
    expect(isWebSocketUpgrade(hdr({ Upgrade: "websocket" }))).toBe(false); // no Connection
  });
});

describe("isAllowedPreviewOrigin (CSWSH defense)", () => {
  test("accepts the matching preview origin (http + https, any port)", () => {
    expect(
      isAllowedPreviewOrigin(`https://${VALID_ID}.preview.${APP_HOST}`, VALID_ID, APP_HOST),
    ).toBe(true);
    expect(
      isAllowedPreviewOrigin(`http://${VALID_ID}.preview.localhost:5173`, VALID_ID, "localhost"),
    ).toBe(true);
    // Case-insensitive host matching.
    expect(
      isAllowedPreviewOrigin(
        `https://${VALID_ID.toUpperCase()}.PREVIEW.${APP_HOST}`,
        VALID_ID,
        APP_HOST,
      ),
    ).toBe(true);
  });

  test("rejects a missing / malformed Origin", () => {
    expect(isAllowedPreviewOrigin(null, VALID_ID, APP_HOST)).toBe(false);
    expect(isAllowedPreviewOrigin("", VALID_ID, APP_HOST)).toBe(false);
    expect(isAllowedPreviewOrigin("not a url", VALID_ID, APP_HOST)).toBe(false);
  });

  test("rejects the app origin itself (cross-site)", () => {
    expect(isAllowedPreviewOrigin(`https://${APP_HOST}`, VALID_ID, APP_HOST)).toBe(false);
  });

  test("rejects a DIFFERENT preview id (sibling cookie-tossing)", () => {
    expect(
      isAllowedPreviewOrigin(`https://${OTHER_ID}.preview.${APP_HOST}`, VALID_ID, APP_HOST),
    ).toBe(false);
  });

  test("rejects a wrong app host (attacker domain)", () => {
    expect(isAllowedPreviewOrigin(`https://${VALID_ID}.preview.evil.com`, VALID_ID, APP_HOST)).toBe(
      false,
    );
  });

  test("rejects a non-http(s) scheme", () => {
    expect(
      isAllowedPreviewOrigin(`ftp://${VALID_ID}.preview.${APP_HOST}`, VALID_ID, APP_HOST),
    ).toBe(false);
  });

  test("fails closed when appHost is null", () => {
    expect(isAllowedPreviewOrigin(`https://${VALID_ID}.preview.${APP_HOST}`, VALID_ID, null)).toBe(
      false,
    );
  });
});

describe("decideWebSocketUpgrade — same access gates as HTTP + port pin + CSWSH", () => {
  const dynRow: PreviewRegistryRow = {
    id: VALID_ID,
    userId: "u1",
    kind: "dynamic",
    staticPath: null,
    targetPort: 5173,
  };
  const GOOD_ORIGIN = `https://${VALID_ID}.preview.${APP_HOST}`;

  function deps(over: Partial<DecideWebSocketUpgradeDeps> = {}): DecideWebSocketUpgradeDeps {
    return {
      isValidPreviewId: (id) => id === VALID_ID,
      verifyToken: async (t) => (t === "good" ? { previewId: VALID_ID, userId: "u1" } : null),
      getServable: async (id, userId) => (id === VALID_ID && userId === "u1" ? dynRow : undefined),
      ...over,
    };
  }

  function input(over: Record<string, unknown> = {}) {
    return {
      previewId: VALID_ID,
      requestPath: "/",
      cookieToken: "good",
      origin: GOOD_ORIGIN,
      appHost: APP_HOST,
      ...over,
    };
  }

  test("accepts + pins ws://127.0.0.1:<port> with path + search preserved", async () => {
    const d = await decideWebSocketUpgrade(
      input({ requestPath: "/__vite_hmr", search: "?token=x" }),
      deps(),
    );
    expect(d).toEqual({
      accept: true,
      port: 5173,
      upstreamUrl: "ws://127.0.0.1:5173/__vite_hmr?token=x",
    });
  });

  test("rejects a malformed id", async () => {
    const d = await decideWebSocketUpgrade(input({ previewId: "bad" }), deps());
    expect(d.accept).toBe(false);
  });

  test("rejects a cross-site Origin (CSWSH) BEFORE consulting the token", async () => {
    let tokenChecked = false;
    const d = await decideWebSocketUpgrade(
      input({ origin: `https://${OTHER_ID}.preview.${APP_HOST}` }),
      deps({
        verifyToken: async () => {
          tokenChecked = true;
          return { previewId: VALID_ID, userId: "u1" };
        },
      }),
    );
    expect(d.accept).toBe(false);
    if (!d.accept) expect(d.reason).toBe("cross-site origin");
    expect(tokenChecked).toBe(false); // gate ran before the token
  });

  test("rejects a missing Origin", async () => {
    const d = await decideWebSocketUpgrade(input({ origin: null }), deps());
    expect(d.accept).toBe(false);
  });

  test("rejects when no token", async () => {
    const d = await decideWebSocketUpgrade(input({ cookieToken: null }), deps());
    expect(d.accept).toBe(false);
  });

  test("rejects an invalid token", async () => {
    const d = await decideWebSocketUpgrade(input({ cookieToken: "bad" }), deps());
    expect(d.accept).toBe(false);
  });

  test("rejects a token minted for a different preview", async () => {
    const d = await decideWebSocketUpgrade(
      input(),
      deps({ verifyToken: async () => ({ previewId: "other", userId: "u1" }) }),
    );
    expect(d.accept).toBe(false);
  });

  test("rejects when the row is not servable (wrong user / revoked)", async () => {
    const d = await decideWebSocketUpgrade(input(), deps({ getServable: async () => undefined }));
    expect(d.accept).toBe(false);
  });

  test("rejects a static row (only dynamic upgrades)", async () => {
    const staticRow: PreviewRegistryRow = {
      ...dynRow,
      kind: "static",
      targetPort: null,
      staticPath: "/x",
    };
    const d = await decideWebSocketUpgrade(input(), deps({ getServable: async () => staticRow }));
    expect(d.accept).toBe(false);
  });

  test("rejects a dynamic row with no target port", async () => {
    const d = await decideWebSocketUpgrade(
      input(),
      deps({ getServable: async () => ({ ...dynRow, targetPort: 0 }) }),
    );
    expect(d.accept).toBe(false);
  });
});
