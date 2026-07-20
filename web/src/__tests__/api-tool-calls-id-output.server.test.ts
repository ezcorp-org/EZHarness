/**
 * Server-handler unit tests for /api/tool-calls/[id]/output/+server.ts.
 *
 * Covers requireAuth + requireScope gates plus the 404 and 200
 * shapes. The DB layer is mocked at the $server/db/connection
 * boundary; each test installs its own drizzle-style chain.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const selectMock = vi.fn();
vi.mock("$server/db/connection", () => ({
  getDb: () => ({
    select: (...args: unknown[]) => selectMock(...args),
  }),
}));
// Importing the schema pulls in drizzle-orm; stub it out.
vi.mock("$server/db/schema", () => ({
  toolCalls: { id: "id", output: "output" },
}));

const { GET } = await import(
  "../routes/api/tool-calls/[id]/output/+server"
);

function makeEvent(opts: {
  id?: string;
  locals?: Record<string, unknown>;
}) {
  const id = opts.id ?? "tc-1";
  return {
    url: new URL(`http://localhost/api/tool-calls/${id}/output`),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(`http://localhost/api/tool-calls/${id}/output`),
  } as any;
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

async function expectThrown(
  fn: () => Promise<Response> | Response,
  status: number,
): Promise<Response> {
  let res: Response | undefined;
  try {
    res = await fn();
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(Response);
    res = thrown as Response;
  }
  expect(res!.status).toBe(status);
  return res!;
}

function chainReturning(rows: unknown[]) {
  return {
    from: () => ({
      where: async () => rows,
    }),
  };
}

describe("GET /api/tool-calls/[id]/output", () => {
  beforeEach(() => {
    selectMock.mockReset();
  });

  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(() => GET(makeEvent({})), 401);
  });

  test("rejects 403 when API-key lacks 'read' scope", async () => {
    const res = await GET(
      makeEvent({ locals: { ...authedUser, apiKeyScopes: ["chat"] } }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required?: string };
    expect(body.required).toBe("read");
  });

  test("returns 404 when no matching row", async () => {
    selectMock.mockReturnValue(chainReturning([]));
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("flattens { content: [text] } shape into a string", async () => {
    selectMock.mockReturnValue(
      chainReturning([
        {
          // userId matches authedUser (u1) so the ownership guard passes via
          // the null-conversationId fallback branch. Cross-tenant 404s are
          // asserted in security-web-tool-call-output-idor.server.test.ts.
          userId: "u1",
          conversationId: null,
          output: {
            content: [
              { type: "text", text: "hello" },
              { type: "text", text: "world" },
            ],
          },
        },
      ]),
    );
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output?: string };
    expect(body.output).toBe("hello\nworld");
  });

  test("returns raw output when shape is not recognized", async () => {
    selectMock.mockReturnValue(
      chainReturning([{ userId: "u1", conversationId: null, output: { foo: "bar" } }]),
    );
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output?: unknown };
    expect(body.output).toEqual({ foo: "bar" });
  });
});
