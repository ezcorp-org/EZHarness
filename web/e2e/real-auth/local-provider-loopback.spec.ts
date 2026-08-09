/**
 * The local-inference carve-out, at the real HTTP boundary.
 *
 * `POST /api/providers/local/{models,test}` are the ONLY two paths the
 * settings UI has for registering a local provider, and both used to answer
 * 400 `baseUrl targets a private or loopback address` for
 * `http://localhost:11434` — the exact value the UI auto-fills for a new
 * Ollama provider (CustomModelsSection.svelte, ProvidersSection.svelte). The
 * server refused its own suggestion, so a self-hosted local Ollama could not
 * be registered through the UI at all.
 *
 * This spec is the paired proof the carve-out is exactly as wide as claimed,
 * driven through the real server + real auth (not the handler, not a mock):
 *   - the UI's own auto-filled value is ACCEPTED, and
 *   - cloud metadata / RFC1918 / link-local are STILL refused with the same
 *     400 they always were.
 *
 * Deliberately Ollama-INDEPENDENT. CI has no Ollama, and it does not need
 * one: what changed is whether the request gets past validation at all. Past
 * it, `listModels` reports the endpoint as unreachable with a 200 — a
 * completely different outcome from the 400 this fixes, and the distinction
 * the assertions are written on.
 */
import { test, expect } from "../fixtures/hydration.js";

/** The string web/src/lib/components/settings/CustomModelsSection.svelte
 *  auto-fills when an operator picks the `ollama` provider. */
const UI_AUTOFILLED_OLLAMA_URL = "http://localhost:11434";

const SSRF_TARGETS: Array<[string, string]> = [
  ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
  ["RFC1918 10/8", "http://10.0.0.5:11434"],
  ["RFC1918 192.168/16", "http://192.168.1.1:11434"],
  ["IPv6 ULA", "http://[fc00::1]:11434"],
];

test.describe("local provider registration — loopback carve-out", () => {
  test("the UI's auto-filled Ollama URL is no longer refused as SSRF", async ({ request }) => {
    const res = await request.post("/api/providers/local/models", {
      data: { baseUrl: UI_AUTOFILLED_OLLAMA_URL },
    });
    const text = await res.text();

    // The whole bug: this was a hard 400 with an SSRF message.
    expect(res.status(), text).not.toBe(400);
    expect(text).not.toContain("private or loopback");
    expect(res.status(), text).toBe(200);

    // Past validation, the route reports on the ENDPOINT rather than
    // refusing the request. With no Ollama running that is an empty list
    // plus a reachability error — which is the point: a reachability answer
    // is only possible if the request was allowed through.
    const body = JSON.parse(text) as { models?: unknown[]; error?: string };
    expect(Array.isArray(body.models)).toBe(true);
  });

  test("the /test path accepts the same URL", async ({ request }) => {
    const res = await request.post("/api/providers/local/test", {
      data: { baseUrl: UI_AUTOFILLED_OLLAMA_URL, modelId: "qwen3:1.7b" },
    });
    const text = await res.text();
    expect(res.status(), text).not.toBe(400);
    expect(text).not.toContain("private or loopback");
    expect(res.status(), text).toBe(200);
    const body = JSON.parse(text) as { reachable?: boolean };
    expect(typeof body.reachable).toBe("boolean");
  });

  for (const [label, baseUrl] of SSRF_TARGETS) {
    test(`${label} is STILL refused (carve-out did not widen)`, async ({ request }) => {
      const res = await request.post("/api/providers/local/models", { data: { baseUrl } });
      const text = await res.text();
      expect(res.status(), text).toBe(400);
      expect(text).toContain("private or loopback");
    });
  }

  test("a hostname that resolves to loopback is still refused (rebinding)", async ({ request }) => {
    // `localhost.localtest.me` is a public DNS name whose A record is
    // 127.0.0.1. It is NOT a literal loopback form, so it takes the
    // DNS-pinned path — the case that would prove the carve-out too wide if
    // it ever succeeded. A resolution failure in a sandboxed CI runner is
    // also a refusal, so both 400 messages are accepted; a 200 is not.
    const res = await request.post("/api/providers/local/models", {
      data: { baseUrl: "http://localhost.localtest.me:11434" },
    });
    const text = await res.text();
    expect(res.status(), text).toBe(400);
    expect(text).toMatch(/private\/loopback|could not be resolved/);
  });
});
