/**
 * Unit tests for the provider connection-error translator.
 *
 * Regression guard for the "Error: Was there a typo in the url or port?"
 * chat bubble: a fresh project whose remembered model points at an
 * unreachable Ollama/custom endpoint used to leak the runtime's raw fetch
 * error verbatim. `friendlyProviderError` must recognise that class of
 * failure — even after pi-agent-core flattens it to a bare message string —
 * and rewrite it into a clear, actionable message.
 */

import { describe, expect, test } from "bun:test";
import {
  isProviderConnectionError,
  friendlyProviderError,
} from "../providers/provider-error";

// The exact strings the runtime surfaces. The "typo in the url or port"
// variant is the one the user actually saw (Bun 1.3.x ConnectionRefused).
const CONNECTION_MESSAGES = [
  "Was there a typo in the url or port?",
  "Unable to connect. Is the computer able to access the url?",
  "Unable to connect. Is the computer able to access the url? Was there a typo in the url or port?",
  "ConnectionRefused",
  "connect ECONNREFUSED 127.0.0.1:11434",
  "getaddrinfo ENOTFOUND ollama",
  "fetch failed",
  "The socket connection was closed unexpectedly",
  "connection refused",
  "connection timed out",
];

const NON_CONNECTION_MESSAGES = [
  "401 Unauthorized: invalid API key",
  "rate limit exceeded",
  "model not found: gemma4:31b",
  "Bad Request: messages array is empty",
  "Something else entirely went wrong",
];

describe("isProviderConnectionError", () => {
  for (const msg of CONNECTION_MESSAGES) {
    test(`detects connection failure: "${msg.slice(0, 40)}"`, () => {
      expect(isProviderConnectionError(new Error(msg))).toBe(true);
      // Plain string (not wrapped in Error) must work too.
      expect(isProviderConnectionError(msg)).toBe(true);
    });
  }

  for (const msg of NON_CONNECTION_MESSAGES) {
    test(`ignores unrelated error: "${msg.slice(0, 40)}"`, () => {
      expect(isProviderConnectionError(new Error(msg))).toBe(false);
    });
  }

  test("detects via error code even when message is opaque", () => {
    const err = Object.assign(new Error("boom"), { code: "ConnectionRefused" });
    expect(isProviderConnectionError(err)).toBe(true);
  });

  test("detects via error name even when message is opaque", () => {
    const err = Object.assign(new Error("boom"), { name: "ECONNREFUSED" });
    expect(isProviderConnectionError(err)).toBe(true);
  });

  test("null / undefined are not connection errors", () => {
    expect(isProviderConnectionError(null)).toBe(false);
    expect(isProviderConnectionError(undefined)).toBe(false);
  });
});

describe("friendlyProviderError", () => {
  test("returns null for non-connection errors (caller falls back to raw)", () => {
    expect(friendlyProviderError(new Error("401 Unauthorized"))).toBeNull();
  });

  test("rewrites the raw Bun message and never echoes it back", () => {
    const out = friendlyProviderError(
      new Error("Was there a typo in the url or port?"),
      { provider: "ollama", model: "gemma4:31b", baseUrl: "http://localhost:11434/v1" },
    );
    expect(out).not.toBeNull();
    expect(out).not.toContain("typo in the url");
    expect(out).toContain("ollama");
    expect(out).toContain("gemma4:31b");
    expect(out).toContain("http://localhost:11434/v1");
    expect(out!.toLowerCase()).toContain("network/dns");
    expect(out!.toLowerCase()).toContain("base url and port");
  });

  test("degrades gracefully when provider/model/baseUrl are unknown", () => {
    const out = friendlyProviderError(new Error("ECONNREFUSED"));
    expect(out).toContain("the model provider");
    // No dangling "at " / "for model" fragments when fields are absent.
    expect(out).not.toContain(" at ");
    expect(out).not.toContain('for model "');
  });

  test("includes only the fields that are present", () => {
    const out = friendlyProviderError(new Error("fetch failed"), {
      provider: "ollama",
    });
    expect(out).toContain("the ollama endpoint");
    expect(out).not.toContain(" at ");
    expect(out).not.toContain('for model "');
  });
});
