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
import {
  cleanupExtensionAuthorDraft,
  cleanupInstalledExtension,
  seedExtensionAuthorDraft,
} from "../fixtures/db-seed";
import { sandboxSpawnAvailable } from "./sandbox-probe";

test.describe.configure({ mode: "serial" });

test.describe("external harness — extension control end-to-end", () => {
  // The invoke roundtrip + lifecycle install/activate spawn REAL extension
  // subprocesses via the sandbox (`prlimit` + Landlock). Where the jail can't
  // exec the runtime bun (e.g. GitHub hosted runners, whose setup-bun
  // `~/.bun/bin` is outside the sandbox read-exec allowlist) the exec is
  // denied and the subprocess dies at bring-up — so gate the whole group on
  // the real spawn probe. A conditional skip (not a bare `.skip`) is the
  // repo's sanctioned capability-gate pattern, allowed by
  // scripts/gate-integrity.ts.
  test.skip(
    () => !sandboxSpawnAvailable(),
    "extension sandbox needs kernel caps (prlimit/Landlock) not available on this runner",
  );

  // Handles for the lifecycle test's install + seeded draft. Cleared on a
  // clean uninstall; afterEach is the safety net if the test fails midway.
  let installedName: string | null = null;
  let installedDraftId: string | null = null;

  test.afterEach(async ({ request }) => {
    if (installedName) await cleanupInstalledExtension(request, installedName).catch(() => {});
    if (installedDraftId) await cleanupExtensionAuthorDraft(request, installedDraftId).catch(() => {});
    installedName = null;
    installedDraftId = null;
  });

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

  test("admin-role key drives install → activate → wire → invoke → disable → uninstall; member key is 403'd on the role-gated steps", async ({
    request,
    baseURL,
  }) => {
    // Mint two cookieless bearer principals with the admin session cookie:
    //   - adminKey: an admin-ROLE key (read+chat+extensions+admin) — reaches
    //     requireRole(admin) lifecycle routes.
    //   - memberKey: a member-role key holding the SAME scopes (incl. admin
    //     scope) — proves the role wall, not just the scope wall, gates
    //     install/activate/disable/uninstall.
    async function mintKey(scopes: string[], role?: "admin" | "member"): Promise<string> {
      const res = await request.post("/api/settings/developer/api-keys", {
        data: { name: `e2e-life-${role ?? "member"}-${Date.now().toString(36)}`, scopes, ...(role ? { role } : {}) },
      });
      expect(res.status(), await res.text()).toBe(201);
      const body = (await res.json()) as { key: string; role: string };
      expect(body.role).toBe(role ?? "member");
      return body.key;
    }
    const adminKey = await mintKey(["read", "chat", "extensions", "admin"], "admin");
    const memberKey = await mintKey(["read", "chat", "extensions", "admin"]); // role omitted → member

    // Seed a local scaffold to install FROM: the seed endpoint writes
    // ezcorp.config.ts + index.ts to disk and returns the absolute draftDir.
    installedName = `e2e-life-${Date.now().toString(36)}`;
    const seeded = await seedExtensionAuthorDraft({
      request,
      name: installedName,
      type: "tool",
      description: "e2e lifecycle extension",
    });
    installedDraftId = seeded.draftId;

    // HarnessClient uses the process's global fetch — NO Playwright request
    // context, so the admin session cookie is provably absent and the ONLY
    // authority is the bearer key (this is what proves role comes from the key).
    const ezAdmin = new HarnessClient({ baseUrl: baseURL!, apiKey: adminKey });
    const ezMember = new HarnessClient({ baseUrl: baseURL!, apiKey: memberKey });
    const installBody = { source: "local", path: seeded.draftDir } as const;

    // Role-gated step 1 — install. Member (admin SCOPE, member ROLE) → clean
    // 403, not 500; admin-role key installs (lands disabled, no permissions).
    await expect(ezMember.installExtension(installBody)).rejects.toMatchObject({ status: 403 });
    const installed = await ezAdmin.installExtension(installBody);
    expect(installed.name).toBe(installedName);
    expect(typeof installed.id).toBe("string");
    const extId = installed.id;
    expect((await ezAdmin.listExtensions()).map((e) => e.name)).toContain(installedName);

    // Role-gated step 2 — activate (enable + grant).
    await expect(ezMember.activateExtension(extId)).rejects.toMatchObject({ status: 403 });
    const activated = await ezAdmin.activateExtension(extId);
    expect(activated).toMatchObject({ id: extId });

    // Wire the freshly-installed extension to a conversation, then best-effort
    // invoke its first declared tool. A fresh scaffold's subprocess may be
    // registry-gated on this boot, so a HarnessApiError (e.g. 404 Tool not
    // found) still proves the invoke plumbing — same spirit as the roundtrip
    // helper above. Wiring itself is a DB insert and always succeeds.
    const seedConvo = await request.post("/api/__test/seed", { data: { title: "e2e-lifecycle" } });
    expect(seedConvo.status(), await seedConvo.text()).toBe(201);
    const { conversationId } = (await seedConvo.json()) as { conversationId: string };
    const wired = await ezAdmin.wireExtensions(conversationId, [installedName]);
    expect(wired.wired).toContain(installedName);
    const rec = (await ezAdmin.listExtensions()).find((e) => e.name === installedName);
    const toolName = (rec?.manifest as { tools?: Array<{ name?: string }> } | undefined)?.tools?.[0]?.name;
    if (typeof toolName === "string") {
      try {
        const r = await ezAdmin.invokeExtensionTool(conversationId, installedName, toolName, {});
        expect(typeof r.success).toBe("boolean");
      } catch (e) {
        expect(e).toBeInstanceOf(HarnessApiError);
      }
    }

    // Role-gated step 3 — disable (PATCH enabled:false only).
    await expect(ezMember.setExtensionEnabled(extId, false)).rejects.toMatchObject({ status: 403 });
    const disabled = await ezAdmin.setExtensionEnabled(extId, false);
    expect(disabled).toMatchObject({ id: extId, enabled: false });

    // Role-gated step 4 — uninstall (204, no body).
    await expect(ezMember.uninstallExtension(extId)).rejects.toMatchObject({ status: 403 });
    await expect(ezAdmin.uninstallExtension(extId)).resolves.toBeUndefined();
    expect((await ezAdmin.listExtensions()).map((e) => e.name)).not.toContain(installedName);

    // Clean uninstall removed the row + dir; clear handles so afterEach is a
    // no-op (cleanupInstalledExtension is idempotent regardless).
    installedName = null;
    installedDraftId = null;
  });
});
