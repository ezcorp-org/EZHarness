import { describe, expect, test } from "bun:test";
import { FactoryTemporalRetentionError } from "../temporal-retention";
import type { FactoryProvisioningError } from "./steps";
import {
  FACTORY_TEMPORAL_HISTORY_RETENTION_DAYS,
  factoryTemporalLocalArchiveUris,
  factoryTemporalNamespaceArguments,
  factoryTemporalRegisterRequest,
} from "./temporal-namespace";

const HISTORY = "file:///tmp/archive/history/ns";
const VISIBILITY = "file:///tmp/archive/visibility/ns";

function refusal(work: () => unknown): FactoryProvisioningError {
  try { work(); } catch (error) { return error as FactoryProvisioningError; }
  throw new Error("expected a refusal");
}

describe("factoryTemporalNamespaceArguments (re-exported from W15)", () => {
  test("names the namespace, a thirty-day retention, and both archives enabled", () => {
    const args = factoryTemporalNamespaceArguments("tenant-01.w16", HISTORY, VISIBILITY);
    expect(args).toEqual([
      "--namespace", "tenant-01.w16", "--retention", "720h",
      "--history-archival-state", "enabled", "--history-uri", HISTORY,
      "--visibility-archival-state", "enabled", "--visibility-uri", VISIBILITY,
    ]);
    expect(Object.isFrozen(args)).toBe(true);
    expect(FACTORY_TEMPORAL_HISTORY_RETENTION_DAYS).toBe(30);
  });

  test("a malformed namespace or archive URI is refused by name", () => {
    for (const [namespace, history, visibility] of [["-bad", HISTORY, VISIBILITY], ["ns", "not a uri", VISIBILITY], ["ns", HISTORY, "/no/scheme"]] as const) {
      const error = refusal(() => factoryTemporalNamespaceArguments(namespace, history, visibility)) as unknown as FactoryTemporalRetentionError;
      expect(error).toBeInstanceOf(FactoryTemporalRetentionError);
      expect(error.code).toBe("factory_temporal_invalid");
    }
  });
});

describe("factoryTemporalRegisterRequest", () => {
  test("translates exactly those arguments into the RegisterNamespace request", () => {
    const request = factoryTemporalRegisterRequest(factoryTemporalNamespaceArguments("ns", HISTORY, VISIBILITY), "owner-marker");
    expect(request).toEqual({
      namespace: "ns", description: "owner-marker",
      workflowExecutionRetentionPeriod: { seconds: 30 * 86_400 },
      historyArchivalState: 2, historyArchivalUri: HISTORY,
      visibilityArchivalState: 2, visibilityArchivalUri: VISIBILITY,
    });
    expect(Object.isFrozen(request)).toBe(true);
  });

  const valid = [...factoryTemporalNamespaceArguments("ns", HISTORY, VISIBILITY)];
  const replaced = (flag: string, value: string) => { const copy = [...valid]; copy[copy.indexOf(flag) + 1] = value; return copy; };
  const without = (flag: string) => { const copy = [...valid]; copy.splice(copy.indexOf(flag), 2); return copy; };
  const cases: ReadonlyArray<readonly [string, readonly string[], string]> = [
    ["an option without a value", [...valid, "--namespace"], "an option has no value"],
    ["an unknown option", [...valid, "--cluster", "x"], "unknown option --cluster"],
    ["a repeated option", [...valid, "--namespace", "other"], "--namespace is repeated"],
    ["a retention not in whole hours", replaced("--retention", "30d"), "the retention is not whole hours"],
    ["no retention at all", without("--retention"), "the retention is not whole hours"],
    ["history archival disabled", replaced("--history-archival-state", "disabled"), "--history-archival-state is not enabled"],
    ["visibility archival disabled", replaced("--visibility-archival-state", "disabled"), "--visibility-archival-state is not enabled"],
    ["no namespace", without("--namespace"), "the namespace or an archive URI is missing"],
    ["no history URI", without("--history-uri"), "the namespace or an archive URI is missing"],
    ["no visibility URI", without("--visibility-uri"), "the namespace or an archive URI is missing"],
  ];
  for (const [label, args, detail] of cases) {
    test(`${label} is refused, never dropped`, () => {
      const error = refusal(() => factoryTemporalRegisterRequest(args, "m"));
      expect(error.code).toBe("temporal_namespace_arguments_invalid");
      expect(error.message).toBe(`Namespace arguments are not translatable: ${detail}.`);
    });
  }
});

test("the local archive lives in the Temporal container's own file store, one directory per namespace", () => {
  const uris = factoryTemporalLocalArchiveUris("tenant-01.w16");
  expect(uris).toEqual({ history: "file:///tmp/factory-temporal-archival/history/tenant-01.w16", visibility: "file:///tmp/factory-temporal-archival/visibility/tenant-01.w16" });
  expect(Object.isFrozen(uris)).toBe(true);
  expect(() => factoryTemporalNamespaceArguments("tenant-01.w16", uris.history, uris.visibility)).not.toThrow();
});
