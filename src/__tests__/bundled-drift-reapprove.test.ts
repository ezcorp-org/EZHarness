import { describe, expect, test } from "bun:test";
import type { ExtensionManifestV4 } from "@ezcorp/extension-contract";
import { hasExactReleaseGrants, requestedReleaseGrants } from "../extensions/bundled-drift-reapprove";
import { createLifecycleAuthorization } from "../extensions/extension-lifecycle-service";
import { actor, installation, lookup, release } from "./helpers/lifecycle-policy-fixture";

describe("production lifecycle authorization", () => {
  test("only active human administrators approve", async () => {
    const policy = createLifecycleAuthorization(lookup());
    await expect(policy.authorize(actor, "approve", release, [])).rejects.toMatchObject({ code: "human_admin_required" });
    await expect(policy.authorize({ ...actor, principalId: "admin" }, "approve", release, [])).rejects.toMatchObject({ code: "human_admin_required" });
    await policy.authorize({ ...actor, principalId: "admin", kind: "human" }, "approve", release, []);
    const inactive = createLifecycleAuthorization(lookup({ async user(id) { return { id, role: "admin", status: "inactive" }; } }));
    await expect(inactive.authorize({ ...actor, principalId: "admin", kind: "human" }, "approve", release, [])).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("admin approval cannot reactivate a deleted or inactive owner", async () => {
    const policy = createLifecycleAuthorization(lookup({ async user(id) { return id === "admin" ? { id, role: "admin", status: "active" } : undefined; } }));
    await expect(policy.authorize({ ...actor, principalId: "admin", kind: "human" }, "approve", release, [])).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("exact grants cannot omit or add a permission", async () => {
    const policy = createLifecycleAuthorization(lookup());
    const granted = { ...release, manifest: { ...release.manifest, permissions: { network: ["https://example.com"] } } };
    await expect(policy.authorize(actor, "activate", granted, [])).rejects.toMatchObject({ code: "grant_mismatch" });
    await policy.authorize(actor, "activate", granted, requestedReleaseGrants(granted.manifest));
    await expect(policy.authorize(actor, "activate", granted, [...requestedReleaseGrants(granted.manifest), "shell"])).rejects.toMatchObject({ code: "grant_mismatch" });
  });

  test("another owner cannot read state or activate by a known ID", async () => {
    const policy = createLifecycleAuthorization(lookup());
    await expect(policy.authorizeAccess!({ ...actor, principalId: "other" }, installation)).rejects.toMatchObject({ code: "not_found" });
    await expect(policy.authorize({ ...actor, principalId: "other" }, "activate", release, [])).rejects.toMatchObject({ code: "not_found" });
    await policy.authorizeAccess!({ ...actor, principalId: "admin", kind: "human" }, installation);
  });

  test("name takeover and namespace rename fail before activation", async () => {
    const collision = createLifecycleAuthorization(lookup({ async projectionByName() { return { id: "other", name: "fixture", creatorUserId: "other", modifiable: false }; } }));
    await expect(collision.authorize(actor, "activate", release, [])).rejects.toMatchObject({ code: "extension_name_in_use" });
    const rename = createLifecycleAuthorization(lookup({ async projectionById() { return { id: installation.id, name: "original", creatorUserId: "owner", modifiable: true }; } }));
    await expect(rename.authorize(actor, "activate", release, [])).rejects.toMatchObject({ code: "extension_name_changed" });
  });

  test("legacy modifiable does not block owner candidates, while scope and approval remain enforced", async () => {
    const fixed = createLifecycleAuthorization(lookup({ async projectionById() { return { id: installation.id, name: "fixture", creatorUserId: "owner", modifiable: false }; } }));
    await fixed.authorize(actor, "activate", release, []);
    await fixed.authorize({ principalId: "admin", scope: "global", kind: "human" }, "approve", release, []);
    await expect(fixed.authorize({ ...actor, principalId: "stranger" }, "activate", release, [])).rejects.toMatchObject({ code: "not_found" });
    await expect(fixed.authorize(actor, "approve", release, [])).rejects.toMatchObject({ code: "human_admin_required" });
    const mismatchedOwner = createLifecycleAuthorization(lookup({ async projectionById() { return { id: installation.id, name: "fixture", creatorUserId: "stranger", modifiable: true }; } }));
    await expect(mismatchedOwner.authorize(actor, "activate", release, [])).rejects.toMatchObject({ code: "ownership_mismatch" });
    const scoped = createLifecycleAuthorization(lookup());
    await expect(scoped.authorize({ ...actor, scope: "project:private" }, "workspace")).rejects.toMatchObject({ code: "forbidden" });
    await expect(scoped.authorize({ ...actor, scope: "caller-forged-scope" }, "workspace")).rejects.toMatchObject({ code: "invalid_scope" });
  });
});

function manifestWith(permissions: ExtensionManifestV4["permissions"]): ExtensionManifestV4 {
  return { ...release.manifest, permissions };
}

describe("immutable release grant comparison", () => {
  test("a release without capabilities needs no grants", () => {
    const manifest = manifestWith({});
    expect(requestedReleaseGrants(manifest)).toEqual([]);
    expect(hasExactReleaseGrants(manifest, [])).toBe(true);
    expect(hasExactReleaseGrants(manifest, ['["storage",true]'])).toBe(false);
  });

  test("the request contains each declared capability with its exact value", () => {
    const manifest = manifestWith({ storage: true, network: ["https://example.com"] });
    expect(requestedReleaseGrants(manifest)).toEqual(['["network",["https://example.com"]]', '["storage",true]']);
    expect(hasExactReleaseGrants(manifest, ['["storage",true]', '["network",["https://example.com"]]'])).toBe(true);
    expect(hasExactReleaseGrants(manifest, ['["storage",true]'])).toBe(false);
  });

  test("changing a network destination needs a different grant", () => {
    const original = manifestWith({ network: ["https://approved.example"] });
    const changed = manifestWith({ network: ["https://different.example"] });
    const grants = requestedReleaseGrants(original);
    expect(hasExactReleaseGrants(original, grants)).toBe(true);
    expect(hasExactReleaseGrants(changed, grants)).toBe(false);
    expect(requestedReleaseGrants(changed)).toEqual(['["network",["https://different.example"]]']);
  });

  test("a new capability cannot use a previous grant set", () => {
    const original = manifestWith({ storage: true });
    const changed = manifestWith({ storage: true, search: "inherit" });
    expect(hasExactReleaseGrants(changed, requestedReleaseGrants(original))).toBe(false);
    expect(hasExactReleaseGrants(changed, requestedReleaseGrants(changed))).toBe(true);
    expect(requestedReleaseGrants(changed)).toContain('["search","inherit"]');
  });

  test("removing a capability also requires exact review", () => {
    const original = manifestWith({ storage: true, search: "inherit" });
    const changed = manifestWith({ storage: true });
    expect(hasExactReleaseGrants(changed, requestedReleaseGrants(original))).toBe(false);
    expect(hasExactReleaseGrants(changed, requestedReleaseGrants(changed))).toBe(true);
    expect(requestedReleaseGrants(changed)).not.toContain('["search","inherit"]');
  });

  test("grant ordering and repeated identical grants do not create authority", () => {
    const manifest = manifestWith({ storage: true, network: ["https://example.com"] });
    const grants = requestedReleaseGrants(manifest);
    expect(hasExactReleaseGrants(manifest, [...grants].reverse())).toBe(true);
    expect(hasExactReleaseGrants(manifest, [...grants, ...grants])).toBe(true);
    expect(hasExactReleaseGrants(manifest, [...grants, '["shell",true]'])).toBe(false);
  });

  test("permission object ordering has one canonical representation", () => {
    const first = manifestWith({ storage: true, llm: { providers: ["openai"], maxCallsPerHour: 3 } });
    const second = manifestWith({ llm: { maxCallsPerHour: 3, providers: ["openai"] }, storage: true });
    expect(requestedReleaseGrants(first)).toEqual(requestedReleaseGrants(second));
    expect(hasExactReleaseGrants(second, requestedReleaseGrants(first))).toBe(true);
    expect(requestedReleaseGrants(first)).toContain('["llm",{"maxCallsPerHour":3,"providers":["openai"]}]');
  });

  test("changing a nested limit invalidates the previous grant", () => {
    const original = manifestWith({ llm: { providers: ["openai"], maxCallsPerHour: 3 } });
    const widened = manifestWith({ llm: { providers: ["openai"], maxCallsPerHour: 4 } });
    expect(hasExactReleaseGrants(widened, requestedReleaseGrants(original))).toBe(false);
    expect(hasExactReleaseGrants(original, requestedReleaseGrants(widened))).toBe(false);
    expect(hasExactReleaseGrants(widened, requestedReleaseGrants(widened))).toBe(true);
  });

  test("caller capabilities are part of the approved grant set", () => {
    const manifest = { ...manifestWith({}), acceptsCallerCaps: true };
    expect(requestedReleaseGrants(manifest)).toEqual(['["acceptsCallerCaps",true]']);
    expect(hasExactReleaseGrants(manifest, [])).toBe(false);
    expect(hasExactReleaseGrants(manifest, ['["acceptsCallerCaps",true]'])).toBe(true);
  });

  test("child capability escalation has its own explicit grant", () => {
    const manifest = { ...manifestWith({}), escalateChildCaps: true };
    expect(requestedReleaseGrants(manifest)).toEqual(['["escalateChildCaps",true]']);
    expect(hasExactReleaseGrants(manifest, ['["acceptsCallerCaps",true]'])).toBe(false);
    expect(hasExactReleaseGrants(manifest, ['["escalateChildCaps",true]'])).toBe(true);
  });

  test("explicit false flags are distinct from omitted declarations", () => {
    const manifest = { ...manifestWith({}), acceptsCallerCaps: false, escalateChildCaps: false };
    expect(requestedReleaseGrants(manifest)).toEqual(['["acceptsCallerCaps",false]', '["escalateChildCaps",false]']);
    expect(hasExactReleaseGrants(manifest, [])).toBe(false);
    expect(hasExactReleaseGrants(manifest, requestedReleaseGrants(manifest))).toBe(true);
  });

  test("both delegation declarations must be reviewed together", () => {
    const manifest = { ...manifestWith({ storage: true }), acceptsCallerCaps: true, escalateChildCaps: true };
    const grants = requestedReleaseGrants(manifest);
    expect(grants).toHaveLength(3);
    expect(hasExactReleaseGrants(manifest, grants.filter((grant) => !grant.includes("escalateChildCaps")))).toBe(false);
    expect(hasExactReleaseGrants(manifest, grants)).toBe(true);
  });

  test("comparison does not rewrite the manifest or caller grant list", () => {
    const manifest = manifestWith({ storage: true, network: ["https://example.com"] });
    const before = structuredClone(manifest);
    const grants = requestedReleaseGrants(manifest).reverse();
    const beforeGrants = [...grants];
    expect(hasExactReleaseGrants(manifest, grants)).toBe(true);
    expect(manifest).toEqual(before);
    expect(grants).toEqual(beforeGrants);
  });

  test("noncanonical caller strings cannot substitute for an exact grant", () => {
    const manifest = manifestWith({ storage: true });
    expect(hasExactReleaseGrants(manifest, ['[ "storage", true ]'])).toBe(false);
    expect(hasExactReleaseGrants(manifest, ["storage"])).toBe(false);
    expect(hasExactReleaseGrants(manifest, ['["storage",true]'])).toBe(true);
  });
});
