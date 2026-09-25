import { beforeEach, expect, mock, test } from "bun:test";

let rows: unknown[][];
let queries = 0;
let fail = false;
let qualification: { validUntil: string } | null;
let active: Record<string, unknown>;
const connection = { installationId: "installation", releaseId: "release", connectionId: "connection", connectionRevision: 1, label: "Development" };
const preset = { id: "compose", profile: "persistent-web-compose.v1" };
const run = { runId: "run", state: "AWAITING_RESTART", deadlineAt: "2999-01-01T00:00:00Z" };
mock.module("$server/auth/middleware", () => ({ requireAdminSession: (locals: { user?: { role: string }; authMethod?: string }) =>
  locals.user?.role === "admin" && locals.authMethod === "session" ? locals.user : Response.json({}, { status: locals.user ? 403 : 401 }) }));
mock.module("$server/db/connection", () => ({ getDb: () => ({ execute: async () => { queries++; if (fail) throw new Error("SECRET"); return rows.shift() ?? []; } }) }));
mock.module("$server/extensions/extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => undefined }));
mock.module("$server/extensions/release-process", () => ({ getReleaseRuntime: () => ({}), resolveActiveRelease: async (id: string) => {
  if (id === "inactive") throw new Error("SECRET"); return active;
} }));
mock.module("$server/infrastructure/incus-qualification", () => ({ IncusQualificationStore: class { async load() { return qualification; } } }));
const { GET } = await import("./+server");
const admin = { user: { role: "admin" }, authMethod: "session" };
const request = (locals: unknown = admin) => GET({ locals } as Parameters<typeof GET>[0]);

beforeEach(() => {
  rows = [[connection], [{ id: "project", name: "Project" }], [], []]; queries = 0; fail = false;
  qualification = null;
  active = { installation: { generation: 3 }, release: { id: "release", manifest: { sandboxProviders: [{ id: "incus", kind: "sandbox", protocolMajor: 1, presets: [preset] }] } } };
});

test("only an admin human session can list infrastructure", async () => {
  expect((await request({})).status).toBe(401);
  expect((await request({ ...admin, authMethod: "api-key" })).status).toBe(403);
  expect((await request({ user: { role: "member" }, authMethod: "session" })).status).toBe(403);
  expect(queries).toBe(0);
});

test("lists current environments with explicit missing qualification and no cache", async () => {
  const response = await request();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ environments: [{ ...connection, label: "Development · compose", releaseGeneration: 3,
    presetId: "compose", profile: preset.profile, qualified: false, qualificationValidUntil: null,
    qualificationState: "not_qualified", qualificationRunId: null, blockedReason: "Run qualification before creating a sandbox." }],
    projects: [{ id: "project", name: "Project" }], features: [], truncated: false });
});

test("shows saved running, expired, failed, and qualified outcomes", async () => {
  for (const [saved, expected] of [[run, "running"], [{ ...run, state: "FAILED" }, "failed"],
    [{ ...run, deadlineAt: "2000-01-01T00:00:00Z" }, "failed"], [{ ...run, state: "COMPLETED" }, "not_qualified"]] as const) {
    rows = [[connection], [], [], [saved]];
    const result = await (await request()).json();
    expect(result.environments[0].qualificationState).toBe(expected);
    expect(result.environments[0].qualificationRunId).toBe("run");
  }
  qualification = { validUntil: "2999-01-01T00:00:00Z" };
  rows = [[connection], [], [], []];
  expect((await (await request()).json()).environments[0]).toMatchObject({ qualified: true,
    qualificationState: "qualified", qualificationValidUntil: qualification.validUntil, blockedReason: null });
  rows = [[connection], [], [], [run]];
  expect((await (await request()).json()).environments[0]).toMatchObject({ qualified: false, qualificationState: "running" });
});

test("keeps existing features visible when their release is inactive or changed", async () => {
  const feature = { bindingId: "old", observedState: "UNKNOWN", operation: { state: "OUTCOME_UNKNOWN" } };
  rows = [[{ ...connection, installationId: "inactive" }, { ...connection, releaseId: "old" }], [], [feature]];
  expect(await (await request()).json()).toMatchObject({ environments: [], features: [feature] });
  for (const providers of [undefined, [], [{ id: "other", kind: "sandbox" }], [{ id: "incus", kind: "sandbox", protocolMajor: 2 }]]) {
    active = { installation: { generation: 3 }, release: { id: "release", manifest: { sandboxProviders: providers } } };
    rows = [[connection], [], []];
    expect((await (await request()).json()).environments).toEqual([]);
  }
});

test("bounds each result collection and reports truncation", async () => {
  active = { installation: { generation: 3 }, release: { id: "release", manifest: { sandboxProviders: [{ id: "incus", kind: "sandbox", protocolMajor: 1,
    presets: Array.from({ length: 101 }, (_, i) => ({ ...preset, id: `preset-${i}` })) }] } } };
  rows = [[connection], Array(101).fill({ id: "project" }), Array(101).fill({ bindingId: "binding" })];
  const result = await (await request()).json();
  expect(result.environments).toHaveLength(100); expect(result.projects).toHaveLength(100);
  expect(result.features).toHaveLength(100); expect(result.truncated).toBe(true);
  rows = [Array(101).fill({ ...connection, installationId: "inactive" }), [], []];
  expect((await (await request()).json()).truncated).toBe(true);
});

test("sanitizes failures without leaking database diagnostics", async () => {
  fail = true;
  const response = await request();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: "management_unavailable", message: "Sandbox status is unavailable. Try refreshing." });
});
