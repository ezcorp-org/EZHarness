/**
 * Server-handler unit tests for /api/tool-calls/[id]/permission/+server.ts.
 *
 * The handler delegates to `$server/routes/tool-permission#handleToolPermission`
 * after `requireScope("chat")` + `requireAuth`. Tests cover:
 *  - 401 when locals.user is missing.
 *  - 403 when the API-key lacks 'chat' scope.
 *  - Delegate invocation with (request, params.id, user) on the happy path.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { expectThrownResponse as expectThrown } from "./helpers/server-route-test-utils";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const handleToolPermission = vi.fn(
  async (_req: Request, _id: string, _user: unknown) =>
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
);
vi.mock("$server/routes/tool-permission", () => ({
  handleToolPermission,
}));

const { POST } = await import(
  "../routes/api/tool-calls/[id]/permission/+server"
);

function makeEvent(opts: {
  id?: string;
  body?: unknown;
  locals?: Record<string, unknown>;
}) {
  const id = opts.id ?? "tc-1";
  const init: RequestInit = { method: "POST" };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { "content-type": "application/json" };
  }
  return makeRequestEvent(`http://localhost/api/tool-calls/${id}/permission`, {
    locals: opts.locals ?? {},
    params: { id },
    request: init,
  });
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

describe("POST /api/tool-calls/[id]/permission", () => {
  beforeEach(() => handleToolPermission.mockClear());

  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(() => POST(makeEvent({ body: { approved: true } })), 401);
    expect(handleToolPermission).not.toHaveBeenCalled();
  });

  test("rejects 403 when API-key lacks 'chat' scope", async () => {
    const res = await POST(
      makeEvent({
        body: { approved: true },
        locals: { ...authedUser, apiKeyScopes: ["read"] },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required?: string };
    expect(body.required).toBe("chat");
    expect(handleToolPermission).not.toHaveBeenCalled();
  });

  test("delegates to handleToolPermission(request, id, user) on success", async () => {
    const res = await POST(
      makeEvent({ id: "tc-42", body: { approved: true }, locals: authedUser }),
    );
    expect(res.status).toBe(200);
    expect(handleToolPermission).toHaveBeenCalledTimes(1);
    const [req, id, user] = handleToolPermission.mock.calls[0]!;
    expect(req).toBeInstanceOf(Request);
    expect(id).toBe("tc-42");
    expect(user).toEqual(authedUser.user);
  });
});
