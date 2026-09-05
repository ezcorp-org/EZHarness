import { expect, test } from "bun:test";
import { canonicalJson } from "@ezcorp/extension-contract";
import { buildWorkflowReleaseConsent, parseWorkflowReleaseConsent, workflowDelegationReleaseAllows, workflowDelegationReleaseBinding, MAX_WORKFLOW_CONSENT_BYTES } from "../runtime/workflow-release-consent";
import { systemCachedWorkflow, type CachedWorkflow } from "../runtime/workflow-scope";

function entry(name = "source:task", installationId = "source"): CachedWorkflow & { extensionRelease: NonNullable<CachedWorkflow["extensionRelease"]> } {
  return { ...systemCachedWorkflow({ name, description: "Task", steps: [] }, "extension"), extensionRelease: { installationId, binding: "exact-release", ownerId: "owner", scope: "global" } };
}
const origin = { release: entry().extensionRelease!, workflowName: "host-root", ownerKind: "user" as const, ownerId: "owner", projectId: null };

test("consent groups only named targets and keeps initiating origin separate", () => {
  const target = entry("target:task", "target");
  const binding = buildWorkflowReleaseConsent(origin, [target, target, entry(), systemCachedWorkflow({ name: "host", description: "Host", steps: [] }, "yaml")]);
  expect(parseWorkflowReleaseConsent(binding)).toEqual({ version: 2, origin, releases: [{ release: entry().extensionRelease, workflows: ["source:task"] }, { release: target.extensionRelease, workflows: ["target:task"] }] });
  expect(workflowDelegationReleaseAllows(target, binding)).toBe(true);
  expect(workflowDelegationReleaseAllows(entry("target:other", "target"), binding)).toBe(false);
  expect(workflowDelegationReleaseAllows({ ...target, extensionRelease: { ...target.extensionRelease!, binding: "replacement" } }, binding)).toBe(false);
  expect(parseWorkflowReleaseConsent(buildWorkflowReleaseConsent(origin, []))).toEqual({ version: 2, origin, releases: [] });
});

test("version one remains exact and cannot authorize another installation", () => {
  const source = entry();
  const binding = workflowDelegationReleaseBinding(source)!;
  expect(parseWorkflowReleaseConsent(binding)?.version).toBe(1);
  expect(workflowDelegationReleaseAllows(source, binding)).toBe(true);
  expect(workflowDelegationReleaseAllows(entry("target:task", "target"), binding)).toBe(false);
  expect(workflowDelegationReleaseAllows(source, null)).toBe(false);
  expect(workflowDelegationReleaseAllows({ ...source, extensionRelease: undefined }, binding)).toBe(false);
  expect(workflowDelegationReleaseBinding({ ...source, extensionRelease: undefined })).toBeNull();
});

test("malformed, noncanonical and over-bounded consent is rejected", () => {
  const valid = { version: 2, origin, releases: [{ release: entry().extensionRelease!, workflows: ["source:task"] }] };
  for (const binding of [null, undefined, "", "{", " "+canonicalJson(valid), "x".repeat(MAX_WORKFLOW_CONSENT_BYTES + 1)]) expect(parseWorkflowReleaseConsent(binding)).toBeNull();
  for (const value of [null, [], {}, { ...valid, version: 3 }, { ...valid, extra: true }, { ...valid, origin: { ...origin, ownerKind: "admin" } }, { ...valid, origin: { ...origin, ownerId: "" } }, { ...valid, origin: { ...origin, projectId: 1 } }, { ...valid, origin: { ...origin, release: { ...origin.release, scope: "project:" } } }, { ...valid, releases: {} }, { ...valid, releases: Array(33).fill(valid.releases[0]) }, { ...valid, releases: [valid.releases[0], valid.releases[0]] }, { ...valid, releases: [{ ...valid.releases[0], workflows: [] }] }, { ...valid, releases: [{ ...valid.releases[0], workflows: ["z", "a"] }] }, { ...valid, releases: [{ ...valid.releases[0], workflows: ["same"] }, { release: { ...origin.release, installationId: "target" }, workflows: ["same"] }] }]) expect(parseWorkflowReleaseConsent(canonicalJson(value))).toBeNull();
  expect(() => buildWorkflowReleaseConsent(origin, [{ ...entry(), extensionRelease: undefined }])).toThrow("sealed");
  expect(() => buildWorkflowReleaseConsent(origin, [entry(), { ...entry(), extensionRelease: { ...origin.release, binding: "changed" } }])).toThrow("changed");
  expect(() => buildWorkflowReleaseConsent(origin, Array.from({ length: 257 }, (_, index) => entry(`source:task-${index}`)))).toThrow("bounds");
});
