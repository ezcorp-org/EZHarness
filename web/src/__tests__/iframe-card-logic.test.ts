/**
 * Unit tests for iframe-card-logic — the security-critical bits of
 * ExtensionIframeCard. Locks down:
 *   - Cross-origin URLs are refused.
 *   - Non-http(s) schemes (javascript:, data:, blob:, file:) are
 *     refused regardless of host.
 *   - SANDBOX_FLAGS_STRICT does not include any escape-hatch flags.
 *   - Extension/event name regex matches the manifest spec.
 *   - URL builder escapes URI meta-chars in the path segments.
 */

import { describe, test, expect } from "bun:test";
import {
  EXT_NAME_REGEX,
  SANDBOX_FLAGS_STRICT,
  buildEventUrl,
  isValidEventName,
  isValidExtensionName,
  validateIframeSrc,
} from "../lib/components/tool-cards/iframe-card-logic";

const ORIGIN = "http://localhost:5173";

// ── SANDBOX_FLAGS_STRICT ───────────────────────────────────────────

describe("SANDBOX_FLAGS_STRICT", () => {
  test("equals 'allow-scripts allow-same-origin'", () => {
    expect(SANDBOX_FLAGS_STRICT).toBe("allow-scripts allow-same-origin");
  });

  test("does NOT include any escape-hatch flags", () => {
    const forbidden = [
      "allow-top-navigation",
      "allow-popups",
      "allow-forms",
      "allow-modals",
      "allow-pointer-lock",
      "allow-presentation",
      "allow-orientation-lock",
      "allow-downloads",
    ];
    for (const flag of forbidden) {
      expect(SANDBOX_FLAGS_STRICT).not.toContain(flag);
    }
  });
});

// ── validateIframeSrc — same-origin enforcement ────────────────────

describe("validateIframeSrc — happy paths", () => {
  test("relative path starting with / is same-origin", () => {
    expect(validateIframeSrc("/api/extensions/x/data/draft.html", ORIGIN)).toEqual({
      ok: true,
    });
  });

  test("relative path starting with ./ is same-origin", () => {
    expect(validateIframeSrc("./local.html", ORIGIN)).toEqual({ ok: true });
  });

  test("absolute http URL on the same origin is allowed", () => {
    expect(validateIframeSrc(`${ORIGIN}/draft.html`, ORIGIN)).toEqual({ ok: true });
  });

  test("https origin works the same way", () => {
    expect(validateIframeSrc("https://app.example.com/x", "https://app.example.com")).toEqual({
      ok: true,
    });
  });
});

describe("validateIframeSrc — rejection paths", () => {
  test("empty src → Missing iframe URL", () => {
    expect(validateIframeSrc("", ORIGIN)).toEqual({
      ok: false,
      reason: "Missing iframe URL",
    });
  });

  test("undefined src → Missing iframe URL", () => {
    expect(validateIframeSrc(undefined, ORIGIN)).toEqual({
      ok: false,
      reason: "Missing iframe URL",
    });
  });

  test("null src → Missing iframe URL", () => {
    expect(validateIframeSrc(null, ORIGIN)).toEqual({
      ok: false,
      reason: "Missing iframe URL",
    });
  });

  test("cross-origin URL is refused", () => {
    const result = validateIframeSrc("http://evil.example.com/x", ORIGIN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("Cross-origin iframe URLs are not allowed");
    }
  });

  test("cross-origin same-host different-port is refused", () => {
    const result = validateIframeSrc("http://localhost:9999/x", ORIGIN);
    expect(result.ok).toBe(false);
  });

  test("cross-origin same-host different-scheme is refused", () => {
    const result = validateIframeSrc("https://localhost:5173/x", ORIGIN);
    expect(result.ok).toBe(false);
  });

  test("javascript: scheme is refused", () => {
    const result = validateIframeSrc("javascript:alert(1)", ORIGIN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Unsupported scheme");
    }
  });

  test("data: scheme is refused", () => {
    const result = validateIframeSrc("data:text/html,<script>alert(1)</script>", ORIGIN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Unsupported scheme");
    }
  });

  test("blob: scheme is refused", () => {
    const result = validateIframeSrc("blob:http://localhost/abc", ORIGIN);
    expect(result.ok).toBe(false);
  });

  test("file: scheme is refused", () => {
    const result = validateIframeSrc("file:///etc/passwd", ORIGIN);
    expect(result.ok).toBe(false);
  });

  test("malformed origin returns Invalid page origin", () => {
    const result = validateIframeSrc("/x", "not-a-url");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("Invalid page origin");
    }
  });
});

// ── isValidExtensionName / isValidEventName ────────────────────────

describe("name regex", () => {
  test("EXT_NAME_REGEX accepts canonical examples", () => {
    expect(EXT_NAME_REGEX.test("claude-design")).toBe(true);
    expect(EXT_NAME_REGEX.test("a")).toBe(true);
    expect(EXT_NAME_REGEX.test("ext_with_underscores")).toBe(true);
    expect(EXT_NAME_REGEX.test("ext.with.dots")).toBe(true);
  });

  test("EXT_NAME_REGEX rejects invalid characters", () => {
    expect(EXT_NAME_REGEX.test("Bad Name")).toBe(false);
    expect(EXT_NAME_REGEX.test("UPPER")).toBe(false);
    expect(EXT_NAME_REGEX.test("")).toBe(false);
    expect(EXT_NAME_REGEX.test("-leading-hyphen")).toBe(false);
    expect(EXT_NAME_REGEX.test("a".repeat(65))).toBe(false);
  });

  test("isValidExtensionName narrows the type", () => {
    expect(isValidExtensionName("ok")).toBe(true);
    expect(isValidExtensionName(42)).toBe(false);
    expect(isValidExtensionName(null)).toBe(false);
    expect(isValidExtensionName(undefined)).toBe(false);
    expect(isValidExtensionName({})).toBe(false);
  });

  test("isValidEventName rejects names with colons (would re-namespace)", () => {
    expect(isValidEventName("ok-event")).toBe(true);
    expect(isValidEventName("ext:nested")).toBe(false);
  });
});

// ── buildEventUrl ──────────────────────────────────────────────────

describe("buildEventUrl", () => {
  test("builds /api/extensions/<name>/events/<event>", () => {
    expect(buildEventUrl("claude-design", "knob-change")).toBe(
      "/api/extensions/claude-design/events/knob-change",
    );
  });

  test("URI-encodes both segments (defense-in-depth — regex would reject)", () => {
    expect(buildEventUrl("a/b", "c?d")).toBe("/api/extensions/a%2Fb/events/c%3Fd");
  });
});
