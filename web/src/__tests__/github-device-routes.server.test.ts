import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const mocks = vi.hoisted(() => ({ start: vi.fn(), poll: vi.fn(), cancel: vi.fn() }));
vi.mock("$server/integrations/github-user/broker", () => ({
	startDeviceAuthorization: mocks.start,
	pollDeviceAuthorization: mocks.poll,
	cancelDeviceAuthorization: mocks.cancel,
}));
vi.mock("$server/integrations/github-user/transport", () => ({
	GithubUserError: class GithubUserError extends Error {
		constructor(public code: string, message: string) { super(message); }
	},
}));

const start = await import("../routes/api/github/device/start/+server");
const poll = await import("../routes/api/github/device/poll/+server");
const cancel = await import("../routes/api/github/device/cancel/+server");
const { deviceAuthResponse, deviceJson, deviceRouteError } = await import("../routes/api/github/device/_route");
const { GithubUserError } = await import("$server/integrations/github-user/transport");

const user = { id: "owner-1", email: "owner@example.test", name: "Owner", role: "user" };
const attemptId = "00000000-0000-4000-8000-000000000001";
const reviewId = "00000000-0000-4000-8000-000000000002";
const attempt = { attemptId, userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresAt: "2026-09-23T15:00:00.000Z", intervalSeconds: 5 };
const routes = [
	{ name: "start", path: "/api/github/device/start", handler: start.POST, mock: mocks.start, body: {} },
	{ name: "poll", path: "/api/github/device/poll", handler: poll.POST, mock: mocks.poll, body: { attemptId } },
	{ name: "cancel", path: "/api/github/device/cancel", handler: cancel.POST, mock: mocks.cancel, body: { attemptId } },
] as const;

function event(path: string, body: string, locals: Record<string, unknown> = { user, authMethod: "session", sessionId: "session-1" }) {
	return makeRequestEvent(`http://localhost${path}`, {
		locals, request: { method: "POST", body, headers: { "content-type": "application/json" } },
	});
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.start.mockResolvedValue(attempt);
	mocks.poll.mockResolvedValue({ status: "pending", nextPollAt: "2026-09-23T14:50:05.000Z" });
	mocks.cancel.mockResolvedValue({ status: "cancelled" });
});

describe("GitHub device session boundary", () => {
	for (const route of routes) {
		test(`${route.name} refuses anonymous, API-key, and unverified session callers`, async () => {
			for (const [locals, status] of [
				[{}, 401],
				[{ user, authMethod: "api-key", sessionId: "session-1" }, 403],
				[{ user, authMethod: "session" }, 403],
			] as const) {
				const result = await route.handler(event(route.path, JSON.stringify(route.body), locals) as never);
				expect(result.status).toBe(status);
				expect(result.headers.get("cache-control")).toBe("no-store");
			}
			expect(route.mock).not.toHaveBeenCalled();
		});

		test(`${route.name} rejects malformed, oversized, and caller-owned inputs`, async () => {
			for (const body of ["{", JSON.stringify("x".repeat(1025)), "{}", JSON.stringify({ ...route.body, userId: "other" })]) {
				const result = await route.handler(event(route.path, body) as never);
				expect(result.status).toBe(route.name === "start" && body === "{}" ? 200 : 400);
				expect(result.headers.get("cache-control")).toBe("no-store");
			}
			if (route.name !== "start") expect((await route.handler(event(route.path, JSON.stringify({ attemptId: "../../other" })) as never)).status).toBe(400);
		});

		test(`${route.name} binds the verified owner and session, returns no secrets, and contains provider errors`, async () => {
			const result = await route.handler(event(route.path, JSON.stringify(route.body)) as never);
			expect(result.status).toBe(200);
			expect(result.headers.get("cache-control")).toBe("no-store");
			expect(route.mock).toHaveBeenCalledWith({ userId: user.id, sessionId: "session-1", ...route.body });
			expect(JSON.stringify(await result.json())).not.toMatch(/device_code|access_token|refresh_token/);
			route.mock.mockRejectedValue(new Error("private GitHub token"));
			const failed = await route.handler(event(route.path, JSON.stringify(route.body)) as never);
			expect(failed.status).toBe(503);
			expect(failed.headers.get("cache-control")).toBe("no-store");
			expect(JSON.stringify(await failed.json())).not.toContain("private GitHub token");
		});
	}
});

test("start accepts only an internal review ID and sends it with the verified identity", async () => {
	for (const body of [{ returnReviewId: "https://evil.test" }, { returnTo: "//evil.test" }]) {
		expect((await start.POST(event("/api/github/device/start", JSON.stringify(body)) as never)).status).toBe(400);
	}
	const result = await start.POST(event("/api/github/device/start", JSON.stringify({ returnReviewId: reviewId })) as never);
	expect(result.status).toBe(200);
	expect(mocks.start).toHaveBeenCalledWith({ userId: user.id, sessionId: "session-1", returnReviewId: reviewId });
});

test("poll and cancel hide foreign or invalid attempt ownership", async () => {
	for (const route of [routes[1], routes[2]]) {
		route.mock.mockRejectedValue(new GithubUserError("DEVICE_ATTEMPT_UNAVAILABLE", "owner is someone else"));
		const result = await route.handler(event(route.path, JSON.stringify(route.body)) as never);
		expect(result.status).toBe(404);
		expect(await result.json()).toEqual({ error: "GitHub device authorization is unavailable" });
	}
});

test("single-use exchange failure asks for a new code without exposing the provider error", async () => {
	mocks.poll.mockRejectedValue(new GithubUserError("DEVICE_RESTART_REQUIRED", "private /user lookup detail"));
	const result = await poll.POST(event("/api/github/device/poll", JSON.stringify({ attemptId })) as never);
	expect(result.status).toBe(409);
	expect(result.headers.get("cache-control")).toBe("no-store");
	expect(await result.json()).toEqual({ code: "DEVICE_RESTART_REQUIRED", error: "GitHub account lookup failed. Start a new connection." });
});

test("shared device errors return safe status, and auth denials retain no-store", async () => {
	for (const [code, status] of [["SESSION_EXPIRED", 403], ["INVALID_RETURN", 400], ["OTHER", 503]] as const) {
		const result = deviceRouteError(new GithubUserError(code, "secret"), "Safe failure");
		expect(result.status).toBe(status);
		expect(result.headers.get("cache-control")).toBe("no-store");
		expect(JSON.stringify(await result.json())).not.toContain("secret");
	}
	const auth = deviceAuthResponse(new Response("denied", { status: 403, headers: { "x-example": "kept" } }));
	expect(auth.status).toBe(403);
	expect(auth.headers.get("cache-control")).toBe("no-store");
	expect(auth.headers.get("x-example")).toBe("kept");
	expect(await auth.text()).toBe("denied");
	expect((await deviceJson({ ok: true }).json())).toEqual({ ok: true });
});
