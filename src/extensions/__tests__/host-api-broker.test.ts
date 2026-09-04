import { expect, test } from "bun:test";
import { routeMatches, validateHostApiRequest } from "../host-api-broker";

const permissions = { routes: [{ method: "GET", path: "/api/conversations/:id" }, { method: "POST", path: "/api/conversations" }] };

test("API broker matches exact segments and methods", () => {
  expect(routeMatches("/api/conversations/:id", "/api/conversations/conv_1")).toBe(true);
  expect(routeMatches("/api/conversations/:id", "/api/conversations/id/messages")).toBe(false);
  expect(validateHostApiRequest({ method: "GET", path: "/api/conversations/conv_1?limit=1" }, permissions)).toEqual({ method: "GET", path: "/api/conversations/conv_1?limit=1" });
  expect(validateHostApiRequest({ method: "POST", path: "/api/conversations", body: { title: "test" } }, permissions)).toHaveProperty("body");
  expect(() => validateHostApiRequest({ method: "DELETE", path: "/api/conversations/conv_1" }, permissions)).toThrow("not approved");
});

test("API broker rejects external, normalized, encoded and malformed paths", () => {
  for (const path of ["https://evil.test/api/conversations/id", "//evil.test/api/conversations/id", "/api/../api/conversations/id", "/api/conversations/%2e%2e", "/api/conversations/id%2fmessages", "/api/conversations/id\\messages", "/api/conversations/id#fragment", "/api/conversations/id\n"]) expect(() => validateHostApiRequest({ method: "GET", path }, permissions)).toThrow();
  for (const input of [null, [], {}, { path: "/api/conversations/id", method: "get" }, { path: "/api/conversations/id", method: "GET", body: {} }]) expect(() => validateHostApiRequest(input, permissions)).toThrow();
});

test("even a declared grant cannot reach human approval or privileged host routes", () => {
  for (const path of ["/api/extensions/releases/id/approve", "/api/extensions/control", "/api/auth/login", "/api/settings/providers", "/api/__test/mock-llm", "/api/runtime-events", "/api/not-a-route"]) {
    expect(() => validateHostApiRequest({ method: "POST", path }, { routes: [{ method: "POST", path }] })).toThrow("not available");
  }
});
