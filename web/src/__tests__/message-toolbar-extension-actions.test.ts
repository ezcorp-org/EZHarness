/**
 * Pure-logic tests for the host-side helper that turns
 * `ExtensionToolbarItem` contributions into per-row toolbar actions.
 *
 * The helper encapsulates the load-bearing rules of the SDK surface:
 *   - selection capture is clamped to the row's DOM element
 *   - selections > SELECTION_CAP chars are truncated
 *   - `appliesTo` filters by row role
 *   - the POST payload assembled for `/api/extensions/{name}/events/{event}`
 *     matches the contract documented in the plan (messageId,
 *     conversationId, content, selection)
 *
 * Render-free so they run under `bun:test` without jsdom.
 */

import { describe, test, expect } from "bun:test";
import {
  appliesToRole,
  buildExtensionBulkEventPayload,
  buildExtensionEventPayload,
  buildExtensionEventUrl,
  captureSelection,
  postExtensionEvent,
  selectApplicableContributions,
  selectBulkApplicableContributions,
  SELECTION_CAP,
  type ExtensionToolbarItem,
} from "../lib/chat/extension-toolbar-action.js";

describe("appliesToRole", () => {
  test("undefined defaults to 'both' — matches every role", () => {
    expect(appliesToRole(undefined, "user")).toBe(true);
    expect(appliesToRole(undefined, "assistant")).toBe(true);
  });

  test("'both' matches every role", () => {
    expect(appliesToRole("both", "user")).toBe(true);
    expect(appliesToRole("both", "assistant")).toBe(true);
  });

  test("'user' matches only user rows", () => {
    expect(appliesToRole("user", "user")).toBe(true);
    expect(appliesToRole("user", "assistant")).toBe(false);
  });

  test("'assistant' matches only assistant rows", () => {
    expect(appliesToRole("assistant", "user")).toBe(false);
    expect(appliesToRole("assistant", "assistant")).toBe(true);
  });
});

describe("captureSelection", () => {
  // Mock DOM-shaped objects: just enough for the helper's interface.
  function mkAnchorNode(): { __id: string } {
    return { __id: "anchor" };
  }
  function mkSelection(text: string, anchor: object | null, isCollapsed = false): Selection {
    return {
      isCollapsed,
      anchorNode: anchor as Node | null,
      toString: () => text,
    } as unknown as Selection;
  }
  function mkRow(containsResult: boolean): { contains: (node: Node | null) => boolean } {
    return { contains: () => containsResult };
  }

  test("returns null when selection is null", () => {
    expect(captureSelection(null, mkRow(true))).toBeNull();
  });

  test("returns null for collapsed selections", () => {
    const sel = mkSelection("", null, true);
    expect(captureSelection(sel, mkRow(true))).toBeNull();
  });

  test("returns null when messageEl is null", () => {
    const sel = mkSelection("hello", mkAnchorNode());
    expect(captureSelection(sel, null)).toBeNull();
  });

  test("returns null when anchor is outside the message element", () => {
    const sel = mkSelection("foreign text", mkAnchorNode());
    expect(captureSelection(sel, mkRow(false))).toBeNull();
  });

  test("returns null for empty toString", () => {
    const sel = mkSelection("", mkAnchorNode());
    expect(captureSelection(sel, mkRow(true))).toBeNull();
  });

  test("returns the selection text when anchored inside the row", () => {
    const sel = mkSelection("hello world", mkAnchorNode());
    expect(captureSelection(sel, mkRow(true))).toBe("hello world");
  });

  test("clamps to SELECTION_CAP characters", () => {
    const long = "x".repeat(SELECTION_CAP + 250);
    const sel = mkSelection(long, mkAnchorNode());
    const captured = captureSelection(sel, mkRow(true));
    expect(captured).not.toBeNull();
    expect(captured!.length).toBe(SELECTION_CAP);
  });

  test("preserves the leading characters when clamping", () => {
    // Distinct prefix/suffix proves we slice from the start.
    const text = "PREFIX-" + "a".repeat(SELECTION_CAP);
    const sel = mkSelection(text, mkAnchorNode());
    const captured = captureSelection(sel, mkRow(true));
    expect(captured!.startsWith("PREFIX-")).toBe(true);
    expect(captured!.length).toBe(SELECTION_CAP);
  });
});

describe("buildExtensionEventPayload", () => {
  test("assembles the full payload shape", () => {
    const out = buildExtensionEventPayload({
      messageId: "m-1",
      conversationId: "c-1",
      content: "hello",
      selection: "hel",
    });
    expect(out).toEqual({
      messageId: "m-1",
      conversationId: "c-1",
      content: "hello",
      selection: "hel",
    });
  });

  test("preserves null selection (no transformation)", () => {
    const out = buildExtensionEventPayload({
      messageId: "m-1",
      conversationId: "c-1",
      content: "hello",
      selection: null,
    });
    expect(out.selection).toBeNull();
  });
});

describe("buildExtensionEventUrl", () => {
  test("strips the namespace prefix so the URL carries only the bare event suffix", () => {
    // Production bug fixed 2026-05-05: the manifest stores the
    // namespaced bus key (`kokoro-tts:speak`), but the route's
    // `[event]` param regex rejects colons. Server reconstructs the
    // namespace from `${name}:${event}` — so the URL must hold only
    // the suffix.
    expect(buildExtensionEventUrl("kokoro-tts", "kokoro-tts:speak")).toBe(
      "/api/extensions/kokoro-tts/events/speak",
    );
  });

  test("accepts an already-bare event without double-stripping", () => {
    expect(buildExtensionEventUrl("kokoro-tts", "speak")).toBe(
      "/api/extensions/kokoro-tts/events/speak",
    );
  });

  test("a non-matching prefix is preserved (no false positives)", () => {
    // If the event happens to start with a different namespace (e.g.
    // declared by an extension that doesn't own it — a shape the
    // validator rejects but the URL builder shouldn't trust), do not
    // strip.
    expect(buildExtensionEventUrl("kokoro-tts", "other-ext:speak")).toBe(
      "/api/extensions/kokoro-tts/events/other-ext%3Aspeak",
    );
  });

  test("URL-encodes special characters in extension and event names", () => {
    const url = buildExtensionEventUrl("ext space", "evt/with");
    expect(url).toBe("/api/extensions/ext%20space/events/evt%2Fwith");
  });
});

describe("selectApplicableContributions", () => {
  const items: ExtensionToolbarItem[] = [
    { extName: "a", id: "x", icon: "I", tooltip: "T", event: "a:e" }, // appliesTo undefined → both
    { extName: "b", id: "y", icon: "I", tooltip: "T", event: "b:e", appliesTo: "user" },
    { extName: "c", id: "z", icon: "I", tooltip: "T", event: "c:e", appliesTo: "assistant" },
    { extName: "d", id: "w", icon: "I", tooltip: "T", event: "d:e", appliesTo: "both" },
  ];

  test("user row sees 'both' (default + explicit) + 'user'", () => {
    const out = selectApplicableContributions(items, "user");
    expect(out.map((i) => i.extName)).toEqual(["a", "b", "d"]);
  });

  test("assistant row sees 'both' (default + explicit) + 'assistant'", () => {
    const out = selectApplicableContributions(items, "assistant");
    expect(out.map((i) => i.extName)).toEqual(["a", "c", "d"]);
  });

  test("empty input returns empty array", () => {
    expect(selectApplicableContributions([], "user")).toEqual([]);
  });

  test("'bulk'-only items are EXCLUDED from per-message rows", () => {
    const bulkOnly: ExtensionToolbarItem[] = [
      { extName: "x", id: "i", icon: "I", tooltip: "T", event: "x:e", appliesToSelection: "bulk" },
    ];
    expect(selectApplicableContributions(bulkOnly, "user")).toEqual([]);
    expect(selectApplicableContributions(bulkOnly, "assistant")).toEqual([]);
  });

  test("'both' items appear on per-message rows AND in bulk", () => {
    const both: ExtensionToolbarItem[] = [
      { extName: "x", id: "i", icon: "I", tooltip: "T", event: "x:e", appliesToSelection: "both" },
    ];
    expect(selectApplicableContributions(both, "user").map((i) => i.id)).toEqual(["i"]);
    expect(selectBulkApplicableContributions(both).map((i) => i.id)).toEqual(["i"]);
  });
});

describe("selectBulkApplicableContributions", () => {
  const items: ExtensionToolbarItem[] = [
    { extName: "single", id: "s1", icon: "I", tooltip: "T", event: "single:e" }, // omitted → "single"
    { extName: "single-explicit", id: "s2", icon: "I", tooltip: "T", event: "single-explicit:e", appliesToSelection: "single" },
    { extName: "bulk", id: "b", icon: "I", tooltip: "T", event: "bulk:e", appliesToSelection: "bulk" },
    { extName: "both", id: "x", icon: "I", tooltip: "T", event: "both:e", appliesToSelection: "both" },
  ];

  test("returns only items with appliesToSelection 'bulk' or 'both'", () => {
    const out = selectBulkApplicableContributions(items);
    expect(out.map((i) => i.extName)).toEqual(["bulk", "both"]);
  });

  test("omitted appliesToSelection defaults to 'single' → excluded", () => {
    // Sanity: the first item in the fixture omits appliesToSelection
    // and must NOT appear in the bulk filter.
    const out = selectBulkApplicableContributions(items);
    expect(out.find((i) => i.extName === "single")).toBeUndefined();
  });

  test("empty input returns empty array", () => {
    expect(selectBulkApplicableContributions([])).toEqual([]);
  });
});

describe("buildExtensionBulkEventPayload", () => {
  test("forwards messageIds + conversationId + content verbatim", () => {
    const out = buildExtensionBulkEventPayload({
      messageIds: ["m1", "m2", "m3"],
      conversationId: "conv-1",
      content: "first\n\nsecond\n\nthird",
    });
    expect(out).toEqual({
      messageIds: ["m1", "m2", "m3"],
      conversationId: "conv-1",
      content: "first\n\nsecond\n\nthird",
    });
  });

  test("omits selection field entirely (bulk has no single highlight)", () => {
    const out = buildExtensionBulkEventPayload({
      messageIds: ["m1"],
      conversationId: "conv-1",
      content: "x",
    });
    expect("selection" in (out as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe("postExtensionEvent — surfaces failures via the toast adder", () => {
  const url = "/api/extensions/kokoro-tts/events/speak";
  const payload = {
    messageId: "m1",
    conversationId: "c1",
    content: "hi",
    selection: null,
  };

  test("non-2xx response → error toast carrying the HTTP status", async () => {
    const calls: Array<{ type: string; message: string }> = [];
    await postExtensionEvent(url, payload, "Read aloud", {
      fetcher: async () => new Response(null, { status: 404 }),
      addToast: (t) => calls.push(t),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type).toBe("error");
    expect(calls[0]!.message).toContain("Read aloud failed");
    expect(calls[0]!.message).toContain("404");
  });

  test("thrown fetch error → error toast carrying the thrown message", async () => {
    const calls: Array<{ type: string; message: string }> = [];
    await postExtensionEvent(url, payload, "Read aloud", {
      fetcher: async () => {
        throw new Error("connection refused");
      },
      addToast: (t) => calls.push(t),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type).toBe("error");
    expect(calls[0]!.message).toContain("connection refused");
  });

  test("non-Error thrown value → 'network error' default", async () => {
    const calls: Array<{ type: string; message: string }> = [];
    await postExtensionEvent(url, payload, "Read aloud", {
      fetcher: async () => {
        throw "weird"; // non-Error throw — defensive default
      },
      addToast: (t) => calls.push(t),
    });
    expect(calls[0]!.message).toContain("network error");
  });

  test("2xx response → silent (no toast on success)", async () => {
    const calls: Array<{ type: string; message: string }> = [];
    await postExtensionEvent(url, payload, "Read aloud", {
      fetcher: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      addToast: (t) => calls.push(t),
    });
    expect(calls).toEqual([]);
  });

  test("posts to the supplied URL with JSON body", async () => {
    const seen: { url: string; init: RequestInit } = { url: "", init: {} };
    await postExtensionEvent(url, payload, "Read aloud", {
      fetcher: async (u, init) => {
        seen.url = u;
        seen.init = init;
        return new Response(null, { status: 200 });
      },
      addToast: () => {},
    });
    expect(seen.url).toBe(url);
    expect(seen.init.method).toBe("POST");
    const headers = seen.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(seen.init.body as string)).toEqual(payload);
  });
});
