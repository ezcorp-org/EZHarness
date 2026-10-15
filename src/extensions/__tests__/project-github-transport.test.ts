import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";

/**
 * The publication half of the shared transport.
 *
 * W07's release broker holds its credential in private service configuration rather than in the
 * project secret store, and it materializes a whole tree rather than one review page. Those are the
 * two things these cases pin: where the token comes from, and that the wider bounds are bounded.
 */

let secretRequested = 0;
let status = 200;
let payload: unknown = { ok: true };
mock.module("../secrets-store", () => ({ getSecret: async () => { secretRequested += 1; return "project-store-token"; } }));
const fetcher = mock(async (_url: string, _init: RequestInit, _options: Record<string, unknown>) =>
  status === 204 ? new Response(null, { status: 204 }) : Response.json(payload, { status }));
mock.module("../../search/egress", () => ({ guardedFetch: fetcher }));
const { ProjectGitHubHttpError, requestProjectGitHub } = await import("../project-github-transport");

beforeEach(() => { secretRequested = 0; status = 200; payload = { ok: true }; fetcher.mockClear(); });
afterAll(() => { restoreModuleMocks(); });

const base = { projectId: "project", path: "/repos/owner/name", authorize: async () => {} };

test("a caller with its own credential never reaches the project secret store", async () => {
  let reads = 0;
  expect(await requestProjectGitHub({ ...base, readToken: async () => { reads += 1; return "broker-token"; } })).toEqual({ ok: true });
  expect([reads, secretRequested]).toEqual([1, 0]);
  const [, init] = fetcher.mock.calls[0]!;
  expect((init.headers as Record<string, string>).authorization).toBe("Bearer broker-token");
  // The default caller still uses the project store.
  expect(await requestProjectGitHub(base)).toEqual({ ok: true });
  expect(secretRequested).toBe(1);
});

test("a broker without a configured credential is refused before any network call", async () => {
  await expect(requestProjectGitHub({ ...base, readToken: async () => null })).rejects.toMatchObject({ code: "credential_required" });
  expect(fetcher).not.toHaveBeenCalled();
});

test("the publication bounds are passed through and are themselves bounded", async () => {
  await requestProjectGitHub({ ...base, method: "POST", body: { tree: [] }, maxBodyBytes: 16 * 1024 * 1024, timeoutMs: 60_000 });
  expect(fetcher.mock.calls[0]![2]).toMatchObject({ maxBodyBytes: 16 * 1024 * 1024, timeoutMs: 60_000, allowedHosts: ["api.github.com"], maxRedirects: 0 });
  // The default caller keeps the review-sized budget.
  await requestProjectGitHub(base);
  expect(fetcher.mock.calls[1]![2]).toMatchObject({ maxBodyBytes: 2 * 1024 * 1024, timeoutMs: 15_000 });
  for (const bounds of [{ maxBodyBytes: 0 }, { maxBodyBytes: 65 * 1024 * 1024 }, { maxBodyBytes: 1.5 }, { timeoutMs: 0 }, { timeoutMs: 120_001 }, { timeoutMs: 1.5 }]) {
    await expect(requestProjectGitHub({ ...base, ...bounds })).rejects.toMatchObject({ code: "github_path_invalid" });
  }
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("a delete is a permitted method and an empty success is null rather than a parse failure", async () => {
  status = 204;
  expect(await requestProjectGitHub({ ...base, method: "DELETE", readToken: async () => "broker-token" })).toBeNull();
  expect((fetcher.mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
});

test("a refused status carries its code and an error payload is still a failure", async () => {
  status = 422;
  const refused = await requestProjectGitHub(base).then(() => null, (error: unknown) => error);
  expect(refused).toBeInstanceOf(ProjectGitHubHttpError);
  expect((refused as InstanceType<typeof ProjectGitHubHttpError>).status).toBe(422);
  status = 200;
  payload = { errors: [{ message: "rejected" }] };
  await expect(requestProjectGitHub(base)).rejects.toMatchObject({ code: "github_failed" });
});
