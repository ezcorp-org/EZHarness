import { test, expect } from "../fixtures/hydration.js";
import { captureEvidence } from "../fixtures/evidence.js";

const digest = "a".repeat(64);
const plan = { status: "ready", planDigest: digest, blockedReasons: [], steps: [
  { id: "storage-pool", description: "Create a bounded Btrfs pool", apply: { argv: ["incus", "storage", "create", "ezharness-btrfs", "btrfs"] } },
  { id: "provider-client", description: "Trust only the scoped engine certificate", inspect: { expected: {
    fingerprint: "b".repeat(64), restricted: true, projects: ["ezharness"], type: "client",
  } }, apply: { argv: ["incus", "config", "trust", "add-certificate", "-"] } },
] };
const base = { id: "setup-1", connectionId: "connection-1", providerInstallationId: "incus-installation",
  providerReleaseId: "release-1", providerGeneration: 2, plan, failures: [], receipt: null };

test("an admin reviews a saved Incus plan before SSH apply and probes only after verification @evidence", async ({ page }, testInfo) => {
  let setup: Record<string, unknown> | null = null;
  const actions: string[] = [];
  await page.route("**/api/infrastructure/incus/setup**", async route => {
    const request = route.request();
    if (request.method() === "GET") {
      return route.fulfill({ json: request.url().includes("installationId=") ? { setup } :
        { installations: [{ id: "incus-installation", releaseId: "release-1", generation: 2 }] } });
    }
    const body = request.postDataJSON() as { action: string; planDigest?: string };
    actions.push(body.action);
    if (body.action === "plan") setup = { ...base, state: "planned" };
    if (body.action === "apply") {
      expect(body.planDigest).toBe(digest);
      setup = { ...base, state: "verified", receipt: { state: "applied", steps: [
        { id: "storage-pool", action: "executed", outcome: "succeeded" },
        { id: "provider-client", action: "executed", outcome: "succeeded" },
      ] } };
    }
    return route.fulfill({ json: body.action === "probe" ? { setup, result: { result: { ok: true } } } : { setup } });
  });

  await page.goto("/extensions/incus-setup");
  await expect(page.getByRole("heading", { name: "Connect an Incus server" })).toBeVisible();
  await page.getByRole("button", { name: "Inspect and make plan" }).click();
  await expect(page.getByText(digest)).toBeVisible();
  await expect(page.getByText("Create a bounded Btrfs pool")).toBeVisible();
  await page.getByText("Verified settings").click();
  await expect(page.getByText('"restricted": true')).toBeVisible();
  const apply = page.getByRole("button", { name: "Apply reviewed plan over SSH" });
  await expect(apply).toBeDisabled();
  await page.getByRole("checkbox", { name: /I reviewed this exact plan/ }).check();
  await apply.click();
  await expect(page.getByRole("heading", { name: "Server result" })).toBeVisible();
  await expect(page.getByText("Server setup verified. Run the provider probe next.")).toBeVisible();
  await page.getByRole("button", { name: "Run read-only probe" }).click();
  await expect(page.locator("pre.probe")).toContainText('"ok": true');
  const contrast = await page.evaluate(() => {
    const brightness = (color: string) => {
      const channels = color.match(/\d+/g)!.slice(0, 3).map(value => {
        const channel = Number(value) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    return [["select", "select"], [".digest code", ".digest"], [".plan-list pre", ".plan-list pre"], ["pre.probe", "pre.probe"]].map(([textSelector, backgroundSelector]) => {
      const foreground = brightness(getComputedStyle(document.querySelector(textSelector!)!).color);
      const background = brightness(getComputedStyle(document.querySelector(backgroundSelector!)!).backgroundColor);
      return { selector: textSelector, ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) };
    });
  });
  for (const item of contrast) expect(item.ratio, item.selector).toBeGreaterThanOrEqual(4.5);
  expect(actions).toEqual(["plan", "apply", "probe"]);
  await captureEvidence(page, testInfo, "incus-operator-verified", { fullPage: true });
});

test("a blocked plan stays read-only and fits a phone viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/infrastructure/incus/setup**", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: route.request().url().includes("installationId=") ? { setup: null } :
      { installations: [{ id: "incus-installation", releaseId: "release-1", generation: 2 }] } });
    return route.fulfill({ json: { setup: { ...base, state: "blocked", plan: { ...plan, status: "blocked", blockedReasons: ["resource_limits_exceed_host"] } } } });
  });
  await page.goto("/extensions/incus-setup");
  await page.getByRole("button", { name: "Inspect and make plan" }).click();
  await expect(page.getByText("resource limits exceed host")).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply reviewed plan over SSH" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await captureEvidence(page, testInfo, "incus-operator-blocked-mobile", { fullPage: true });
});
