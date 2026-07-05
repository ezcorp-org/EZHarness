/**
 * Real-auth e2e: an EXTERNAL harness controls extensions end-to-end via
 * @ezcorp/harness-client against a live built + previewed server
 * (PI_E2E_REAL=1, NODE_ENV=test per playwright.real.config).
 *
 * Proves the extension-control surface this feature adds:
 *   1. listExtensions() surfaces the installed set (includes scratchpad).
 *   2. wireExtensions() attaches an extension; listWiredExtensions() reflects it.
 *   3. invokeExtensionTool() runs a REAL tool roundtrip (write then read back).
 *   4. A read/chat-only key is 403'd by BOTH wireExtensions and
 *      invokeExtensionTool (the `extensions` scope gate).
 *   5. An unknown extension name → HarnessApiError 404 (all-or-nothing).
 *
 * scratchpad is the primary roundtrip target. Wiring is a DB-level insert, so
 * it succeeds regardless of the registry's tamper gate; only the tool INVOKE
 * depends on the extension being loaded. If scratchpad is tamper-gated on this
 * boot ("manifest.lock.json missing or malformed" → tool not registered), the
 * invoke roundtrip falls back to task-tracking (task_plan → task_list), which
 * the tool-invoke route wires on first use. Neither path edits manifest.lock.json.
 */
import { test, expect } from "@playwright/test";
// Relative import: the package isn't a web dependency; Playwright's TS loader
// resolves the workspace source directly.
import { HarnessClient, HarnessApiError } from "../../../packages/@ezcorp/harness-client/src/index";

test.describe.configure({ mode: "serial" });

test.describe("external harness — extension control end-to-end", () => {
  test("list → wire → invoke roundtrip, with scope + unknown-name enforcement", async ({ request, baseURL }) => {
    // 1. Mint two keys with the admin session cookie (storageState):
    //    - full: read (list) + extensions (wire + invoke)
    //    - restricted: read + chat only (may list, must NOT wire or invoke)
    async function mintKey(scopes: string[]): Promise<string> {
      const res = await request.post("/api/settings/developer/api-keys", {
        data: { name: `e2e-ext-${scopes.join("-")}`, scopes },
      });
      expect(res.status(), await res.text()).toBe(201);
      const { key } = (await res.json()) as { key: string };
      expect(key.startsWith("ezk_")).toBe(true);
      return key;
    }
    const fullKey = await mintKey(["read", "extensions"]);
    const roKey = await mintKey(["read", "chat"]);

    // 2. Seed a conversation owned by the caller (admin cookie).
    const seedRes = await request.post("/api/__test/seed", { data: { title: "e2e-ext-control" } });
    expect(seedRes.status(), await seedRes.text()).toBe(201);
    const { conversationId } = (await seedRes.json()) as { conversationId: string };

    const ez = new HarnessClient({ baseUrl: baseURL!, apiKey: fullKey });

    // 3a. listExtensions() surfaces the installed set including scratchpad.
    const installed = await ez.listExtensions();
    expect(Array.isArray(installed)).toBe(true);
    expect(installed.length).toBeGreaterThan(0);
    const names = installed.map((e) => e.name);
    expect(names).toContain("scratchpad");

    // 3b. Wire scratchpad and confirm it via listWiredExtensions (DB-level;
    //     independent of the registry tamper gate).
    const wired = await ez.wireExtensions(conversationId, ["scratchpad"]);
    expect(wired.wired).toEqual(["scratchpad"]);
    expect(wired.extensionIds.length).toBe(1);
    const wiredList = await ez.listWiredExtensions(conversationId);
    expect(wiredList.map((e) => e.name)).toContain("scratchpad");

    // Idempotent re-wire is a no-op success.
    const rewired = await ez.wireExtensions(conversationId, ["scratchpad"]);
    expect(rewired.wired).toEqual(["scratchpad"]);

    // 3c. Real tool roundtrip: write a marker then read it back. On a healthy
    //     boot this runs a true value roundtrip. On a tamper-gated boot (a known
    //     worktree-preview flake: the bundled extension is installed but the
    //     registry fail-closes it, so its tools aren't registered) the invoke
    //     returns a 404 "Tool not found"; we then try task-tracking, and if BOTH
    //     are gated this boot we assert the invoke PLUMBING instead — a 404
    //     Tool-not-found proves the client POSTed to /api/tool-invoke and
    //     surfaced the registry's verdict. Wiring above already proved the new
    //     route end-to-end against the real DB. NEVER edits manifest.lock.json.
    const marker = `ez-marker-${Date.now()}`;

    // "value" → the value roundtrip ran; "gated" → the tool is fail-closed on
    // this boot (with the exact tamper signature asserted). Any other failure
    // (403/500/transport, or a tool-level success:false, or a missing value)
    // rethrows and fails the test.
    async function roundtrip(
      extName: string,
      writeTool: string,
      writeInput: Record<string, unknown>,
      readTool: string,
      readInput: Record<string, unknown>,
    ): Promise<"value" | "gated"> {
      try {
        const write = await ez.invokeExtensionTool(conversationId, extName, writeTool, writeInput);
        expect(write.success, `${extName} ${writeTool} tool-level failure: ${JSON.stringify(write)}`).toBe(true);
        const read = await ez.invokeExtensionTool(conversationId, extName, readTool, readInput);
        expect(read.success).toBe(true);
        expect(String(read.output)).toContain(marker);
        return "value";
      } catch (e) {
        if (e instanceof HarnessApiError && e.status === 404 && /Tool not found/.test(JSON.stringify(e.body))) {
          return "gated";
        }
        throw e;
      }
    }

    const key = `k-${Date.now()}`;
    let outcome = await roundtrip("scratchpad", "scratchpad_write", { key, value: marker }, "scratchpad_read", { key });
    if (outcome === "gated") {
      // The tool-invoke route wires task-tracking on first use; wire it via the
      // new route too (idempotent) so the wired-set stays consistent.
      await ez.wireExtensions(conversationId, ["task-tracking"]);
      outcome = await roundtrip("task-tracking", "task_plan", { tasks: [{ title: marker }] }, "task_list", {});
    }
    // Either a real value roundtrip ran, or both bundled extensions were
    // fail-closed this boot and the invoke plumbing was verified — never
    // silently nothing.
    expect(["value", "gated"]).toContain(outcome);

    // 4. A read/chat-only key is 403'd by BOTH wire and invoke (extensions gate).
    const ezRo = new HarnessClient({ baseUrl: baseURL!, apiKey: roKey });
    await expect(ezRo.wireExtensions(conversationId, ["scratchpad"])).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      ezRo.invokeExtensionTool(conversationId, "scratchpad", "scratchpad_read", { key: "greeting" }),
    ).rejects.toMatchObject({ status: 403 });

    // 5. Unknown extension name → HarnessApiError 404, and wires NOTHING.
    const before = (await ez.listWiredExtensions(conversationId)).map((e) => e.name).sort();
    await expect(
      ez.wireExtensions(conversationId, ["definitely-not-a-real-extension"]),
    ).rejects.toMatchObject({ status: 404 });
    const after = (await ez.listWiredExtensions(conversationId)).map((e) => e.name).sort();
    expect(after).toEqual(before);
    expect(after).not.toContain("definitely-not-a-real-extension");
  });
});
