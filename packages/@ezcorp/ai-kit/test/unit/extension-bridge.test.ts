import { expect, test } from "bun:test";
import { createBrokerFetch } from "../../extension";

test("broker carries route and body without client credentials", async () => {
  const calls: unknown[] = [];
  const fetch = createBrokerFetch(async <Result>(method: string, input: unknown) => {
    calls.push({ method, input });
    return { status: 201, body: "{}", headers: { "content-type": "application/json" } } as Result;
  });
  const response = await fetch("https://extension-api.invalid/api/conversations?limit=2", { method: "POST", headers: { authorization: "Bearer forbidden" }, body: "{}" });
  expect(response.status).toBe(201);
  expect(calls).toEqual([{ method: "ezcorp/api.request", input: { path: "/api/conversations?limit=2", method: "POST", body: "{}" } }]);
  await expect(fetch("https://attacker.invalid/api/conversations")).rejects.toThrow("Invalid host API origin");
  expect(calls).toHaveLength(1);
});

test("events are bounded broker polls with cursors and cancellation", async () => {
  const calls: unknown[] = [];
  const fetch = createBrokerFetch(async <Result>(method: string, input: unknown) => {
    calls.push({ method, input });
    return { cursor: "next", events: [{ type: "change" }], done: true } as Result;
  });
  const response = await fetch("https://extension-api.invalid/api/runtime-events");
  expect(await response.text()).toBe('data: {"type":"change"}\n\n');
  expect(calls).toEqual([{ method: "ezcorp/api.events", input: { cursor: undefined, waitMs: 1000 } }]);
});

test("empty responses use no body", async () => {
  const fetch = createBrokerFetch(async <Result>() => ({ status: 204, body: "" }) as Result);
  expect((await fetch("https://extension-api.invalid/api/conversations", { method: "DELETE" })).status).toBe(204);
});
