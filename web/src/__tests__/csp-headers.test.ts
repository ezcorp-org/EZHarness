/**
 * Asserts the global Content-Security-Policy emitted by `hooks.server.ts`
 * contains the directives required by the in-browser kokoro-tts pipeline:
 *
 *   - `connect-src` allows the Hugging Face hosts the kokoro-js loader
 *     pulls config / tokenizer / model / voice-bin assets from. The
 *     LFS-backed weights redirect across multiple regional CDNs, so
 *     all five fronts are listed.
 *   - `script-src` includes `'wasm-unsafe-eval'`, required by the
 *     onnxruntime-web WASM backend that `@huggingface/transformers`
 *     instantiates.
 *
 * Also pins the OTHER directives so a future edit can't silently
 * regress the rest of the policy while adjusting the kokoro hosts.
 *
 * Imports the exported CSP constants directly (no `handle` execution)
 * to dodge the startup side effects of `hooks.server.ts`.
 */
import { test, expect, describe } from "bun:test";

// CRITICAL: skip ensureInitialized()/startBackgroundTimers() at import.
// Mirrors the guard already used by hooks-server-*.test.ts files.
process.env.PI_SKIP_INIT = "1";

const {
  HUGGINGFACE_CSP_HOSTS,
  ONNX_WASM_CDN_HOSTS,
  CSP_CONNECT_SRC,
  CSP_SCRIPT_SRC,
  CSP_WORKER_SRC,
  CSP_MEDIA_SRC,
  CSP_HEADER_VALUE,
} = await import("../hooks.server");

function getDirective(csp: string, name: string): string | null {
  for (const part of csp.split(";").map((p) => p.trim())) {
    if (part === name) return "";
    if (part.startsWith(`${name} `)) return part.slice(name.length + 1).trim();
  }
  return null;
}

describe("CSP header — kokoro-tts allowlist", () => {
  test("connect-src includes 'self'", () => {
    const cs = getDirective(CSP_HEADER_VALUE, "connect-src");
    expect(cs).not.toBeNull();
    expect(cs!.split(/\s+/)).toContain("'self'");
  });

  test("connect-src includes every Hugging Face host", () => {
    const cs = getDirective(CSP_HEADER_VALUE, "connect-src");
    expect(cs).not.toBeNull();
    const tokens = cs!.split(/\s+/);
    for (const host of HUGGINGFACE_CSP_HOSTS) {
      expect(tokens).toContain(host);
    }
  });

  test("connect-src exposes the canonical huggingface.co origin", () => {
    // The kokoro-js voice-bin loader hits this host directly:
    //   `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${voice}.bin`
    expect(HUGGINGFACE_CSP_HOSTS).toContain("https://huggingface.co");
  });

  test("connect-src lists the LFS / Xet CDN fronts that HF redirects to", () => {
    // Region-dependent — HF picks one based on caller geography +
    // bucket-migration state, so we allow all of them.
    expect(HUGGINGFACE_CSP_HOSTS).toContain("https://cdn-lfs.huggingface.co");
    expect(HUGGINGFACE_CSP_HOSTS).toContain("https://cdn-lfs-us-1.huggingface.co");
    expect(HUGGINGFACE_CSP_HOSTS).toContain("https://cdn-lfs-eu-1.huggingface.co");
    expect(HUGGINGFACE_CSP_HOSTS).toContain("https://cas-bridge.xethub.hf.co");
  });

  test("script-src includes 'wasm-unsafe-eval'", () => {
    const ss = getDirective(CSP_HEADER_VALUE, "script-src");
    expect(ss).not.toBeNull();
    expect(ss!.split(/\s+/)).toContain("'wasm-unsafe-eval'");
  });

  test("script-src still includes 'self' and 'unsafe-inline'", () => {
    // Pre-patch baseline — adding 'wasm-unsafe-eval' must not displace
    // the existing tokens svelte-kit's inlined boot scripts depend on.
    const ss = getDirective(CSP_HEADER_VALUE, "script-src");
    const tokens = ss!.split(/\s+/);
    expect(tokens).toContain("'self'");
    expect(tokens).toContain("'unsafe-inline'");
  });

  test("script-src AND connect-src include the onnxruntime-web jsDelivr CDN", () => {
    // onnxruntime-web (transformers.js v3.8.1) dynamically imports
    // `https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/ort-wasm-simd-threaded.jsep.mjs`
    // when no same-origin `wasmPaths` is set. Dynamic `import()` is
    // gated by `script-src`; the underlying network fetch by
    // `connect-src`. Both must allow the host or the model fails to
    // initialize after the HF JSON manifests succeed.
    const ss = getDirective(CSP_HEADER_VALUE, "script-src");
    const cs = getDirective(CSP_HEADER_VALUE, "connect-src");
    const ssTokens = ss!.split(/\s+/);
    const csTokens = cs!.split(/\s+/);
    for (const host of ONNX_WASM_CDN_HOSTS) {
      expect(ssTokens).toContain(host);
      expect(csTokens).toContain(host);
    }
    expect(ONNX_WASM_CDN_HOSTS).toContain("https://cdn.jsdelivr.net");
  });

  test("CSP_SCRIPT_SRC and CSP_CONNECT_SRC are wired into CSP_HEADER_VALUE", () => {
    expect(CSP_HEADER_VALUE).toContain(`script-src ${CSP_SCRIPT_SRC}`);
    expect(CSP_HEADER_VALUE).toContain(`connect-src ${CSP_CONNECT_SRC}`);
  });

  test("worker-src includes 'self' (so the kokoro-tts worker can be spawned same-origin)", () => {
    const ws = getDirective(CSP_HEADER_VALUE, "worker-src");
    expect(ws).not.toBeNull();
    expect(ws!.split(/\s+/)).toContain("'self'");
  });

  test("worker-src includes 'blob:' (so Vite's dev-mode inline-worker fallback isn't blocked)", () => {
    const ws = getDirective(CSP_HEADER_VALUE, "worker-src");
    expect(ws).not.toBeNull();
    expect(ws!.split(/\s+/)).toContain("blob:");
  });

  test("CSP_WORKER_SRC is wired into CSP_HEADER_VALUE", () => {
    expect(CSP_HEADER_VALUE).toContain(`worker-src ${CSP_WORKER_SRC}`);
  });

  test("media-src includes 'self' and 'blob:' (so the kokoro-tts <audio> can play synthesized blob URLs)", () => {
    // The card renders `<audio src="blob:...">` against the WAV
    // ArrayBuffer the worker transfers back, BEFORE the upload +
    // finalize chain swaps in the persisted /api/attachments/{id} URL.
    // Without an explicit media-src, browsers fall back to default-src
    // 'self' and refuse the blob URL.
    const ms = getDirective(CSP_HEADER_VALUE, "media-src");
    expect(ms).not.toBeNull();
    const tokens = ms!.split(/\s+/);
    expect(tokens).toContain("'self'");
    expect(tokens).toContain("blob:");
  });

  test("CSP_MEDIA_SRC is wired into CSP_HEADER_VALUE", () => {
    expect(CSP_HEADER_VALUE).toContain(`media-src ${CSP_MEDIA_SRC}`);
  });
});

describe("CSP header — pinned baseline (regression guard)", () => {
  // These are the directives that existed BEFORE the kokoro-tts
  // patch. None of them should change as part of this feature —
  // if one does, the test forces an explicit decision.
  test("default-src is 'self'", () => {
    expect(getDirective(CSP_HEADER_VALUE, "default-src")).toBe("'self'");
  });

  test("style-src is 'self' 'unsafe-inline'", () => {
    expect(getDirective(CSP_HEADER_VALUE, "style-src")).toBe("'self' 'unsafe-inline'");
  });

  test("img-src is 'self' data: blob: https:", () => {
    expect(getDirective(CSP_HEADER_VALUE, "img-src")).toBe("'self' data: blob: https:");
  });

  test("font-src is 'self'", () => {
    expect(getDirective(CSP_HEADER_VALUE, "font-src")).toBe("'self'");
  });

  test("frame-ancestors is 'none'", () => {
    expect(getDirective(CSP_HEADER_VALUE, "frame-ancestors")).toBe("'none'");
  });

  test("base-uri is 'self'", () => {
    expect(getDirective(CSP_HEADER_VALUE, "base-uri")).toBe("'self'");
  });

  test("form-action is 'self'", () => {
    expect(getDirective(CSP_HEADER_VALUE, "form-action")).toBe("'self'");
  });
});
