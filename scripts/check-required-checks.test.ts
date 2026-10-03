import { describe, expect, test } from "bun:test";
import {
  compareRequiredChecks,
  existingRequiredChecks,
  formatInspection,
  inspectRequiredChecks,
  inspectionPassed,
  runRequiredCheck,
} from "./check-required-checks.ts";

function fakeFetch(impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(impl, { preconnect: fetch.preconnect });
}

describe("required-check inspection", () => {
  test("normalizes contexts and checks without duplicates", () => {
    expect(existingRequiredChecks({
      contexts: ["Beta", "Alpha", 7],
      checks: [{ context: "Alpha", app_id: 1 }, { context: "Gamma" }, null],
    })).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  test("passes only an exact strict bidirectional match", () => {
    const exact = compareRequiredChecks("owner/repo", "main", true, ["B", "A", "A"], ["A", "B"]);
    expect(exact).toMatchObject({ desired: ["A", "B"], existing: ["A", "B"], missing: [], unexpected: [] });
    expect(inspectionPassed(exact)).toBe(true);
    expect(inspectionPassed({ ...exact, strict: false })).toBe(false);
  });

  test("reports missing and unexpected checks in both directions", () => {
    const inspection = compareRequiredChecks("owner/repo", "main", true, ["A", "renamed-C"], ["A", "B", "C"]);
    expect(inspection.missing).toEqual(["B", "C"]);
    expect(inspection.unexpected).toEqual(["renamed-C"]);
    expect(inspectionPassed(inspection)).toBe(false);
    expect(formatInspection(inspection)).toContain("missing (2): B, C");
    expect(formatInspection(inspection)).toContain("unexpected (1): renamed-C");
  });

  test("reads branch protection without using a mutating request", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const inspection = await inspectRequiredChecks({
      repository: "owner/repo",
      branch: "release/x",
      token: "secret",
      fetchImpl: fakeFetch(async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({ strict: true, contexts: ["A"], checks: [{ context: "B" }] });
      }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toEndWith("/repos/owner/repo/branches/release%2Fx/protection/required_status_checks");
    expect(calls[0]!.init?.method).toBeUndefined();
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: "Bearer secret" });
    expect(inspection.existing).toEqual(["A", "B"]);
  });

  test("fails closed on HTTP and malformed responses", async () => {
    const fetchHttp = fakeFetch(async () => new Response("denied", { status: 403 }));
    await expect(inspectRequiredChecks({ repository: "owner/repo", branch: "main", token: "x", fetchImpl: fetchHttp })).rejects.toThrow("HTTP 403");

    const fetchMalformed = fakeFetch(async () => Response.json({ contexts: [] }));
    await expect(inspectRequiredChecks({ repository: "owner/repo", branch: "main", token: "x", fetchImpl: fetchMalformed })).rejects.toThrow("strict");
  });

  test("rejects malformed repository coordinates before a request", async () => {
    await expect(inspectRequiredChecks({ repository: "missing-owner", branch: "main", token: "x", fetchImpl: fakeFetch(async () => Response.json({})) })).rejects.toThrow("owner/name");
  });

  test("CLI seam reports exact and drifted configurations", async () => {
    const output: string[] = [];
    const exact = compareRequiredChecks("owner/repo", "main", true, ["A"], ["A"]);
    const drifted = compareRequiredChecks("owner/repo", "main", true, [], ["A"]);
    expect(await runRequiredCheck({
      env: { GITHUB_TOKEN: "token", GITHUB_REPOSITORY: "owner/repo", REQUIRED_CHECKS_BRANCH: "main" },
      inspect: async () => exact,
      log: { log: (value) => output.push(String(value)) },
    })).toBe(0);
    expect(output.at(-1)).toContain("missing (0): none");
    expect(await runRequiredCheck({ env: { GH_TOKEN: "token" }, inspect: async () => drifted, log: { log() {} } })).toBe(1);
    await expect(runRequiredCheck({ env: {} })).rejects.toThrow("GITHUB_TOKEN");
  });
});
