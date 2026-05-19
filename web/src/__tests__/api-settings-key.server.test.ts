/**
 * Server-handler unit tests for /api/settings/[key] (+server.ts).
 *
 * Covers the admin-role gate, the missing-body 400, and the sensitive-key
 * deny list (sec gate that prevents the generic settings API from
 * disclosing JWT/provider credential rows).
 *
 * Success-path GET/PUT/DELETE are intentionally omitted — they hit the
 * settings query layer, which would need PGlite + drizzle wiring.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/settings", () => ({
  getSetting: vi.fn(),
  upsertSetting: vi.fn(async () => undefined),
  deleteSetting: vi.fn(async () => true),
}));

const { getSetting, upsertSetting, deleteSetting } = await import(
  "$server/db/queries/settings"
);
const { GET, PUT, DELETE } = await import(
  "../routes/api/settings/[key]/+server.ts"
);

function makeEvent(opts: {
  key: string;
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: string;
}) {
  const req = new Request(`http://localhost/api/settings/${opts.key}`, {
    method: opts.method ?? "GET",
    ...(opts.body !== undefined
      ? { body: JSON.stringify(opts.body), headers: { "content-type": "application/json" } }
      : {}),
  });
  return {
    url: new URL(`http://localhost/api/settings/${opts.key}`),
    locals: opts.locals ?? {},
    params: { key: opts.key },
    request: req,
  } as any;
}

const adminLocals = {
  user: { id: "u1", email: "u@x", name: "u", role: "admin" },
};

describe("GET /api/settings/[key]", () => {
  test("non-admin throws 403 Response", async () => {
    let res: Response | undefined;
    try {
      await GET(
        makeEvent({
          key: "ui:theme",
          locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
        }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(403);
  });

  test("sensitive key (instance:jwtSecret) returns 403", async () => {
    const res = await GET(
      makeEvent({ key: "instance:jwtSecret", locals: adminLocals }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(
      "This setting key is managed internally and cannot be accessed via the settings API",
    );
  });

  test("sensitive key (provider:apiKey:*) returns 403", async () => {
    const res = await GET(
      makeEvent({ key: "provider:apiKey:openai", locals: adminLocals }),
    );
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/settings/[key]", () => {
  test("missing body.value returns 400", async () => {
    const res = await PUT(
      makeEvent({
        key: "ui:theme",
        locals: adminLocals,
        body: {},
        method: "PUT",
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("value required");
  });

  test("sensitive key returns 403 even with valid body", async () => {
    const res = await PUT(
      makeEvent({
        key: "provider:oauth:google",
        locals: adminLocals,
        body: { value: "x" },
        method: "PUT",
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/settings/[key]", () => {
  test("non-admin throws 403", async () => {
    let res: Response | undefined;
    try {
      await DELETE(
        makeEvent({
          key: "ui:theme",
          locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
          method: "DELETE",
        }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(403);
  });

  test("sensitive key returns 403", async () => {
    const res = await DELETE(
      makeEvent({
        key: "provider:apiKey:anthropic",
        locals: adminLocals,
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(403);
  });

  test("returns 404 when deleteSetting reports no row", async () => {
    vi.mocked(deleteSetting).mockResolvedValueOnce(false as any);
    const res = await DELETE(
      makeEvent({
        key: "ui:theme",
        locals: adminLocals,
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("returns 200 { ok: true } on successful delete", async () => {
    vi.mocked(deleteSetting).mockResolvedValueOnce(true as any);
    const res = await DELETE(
      makeEvent({
        key: "ui:theme",
        locals: adminLocals,
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
    expect(deleteSetting).toHaveBeenCalledWith("ui:theme");
  });
});

describe("GET /api/settings/[key] — value paths (mocked queries)", () => {
  beforeEach(() => vi.mocked(getSetting).mockReset());

  test("returns 404 when the key is not stored", async () => {
    vi.mocked(getSetting).mockResolvedValueOnce(undefined as any);
    const res = await GET(
      makeEvent({ key: "ui:theme", locals: adminLocals }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("returns 200 with { value } on success", async () => {
    vi.mocked(getSetting).mockResolvedValueOnce("dark" as any);
    const res = await GET(
      makeEvent({ key: "ui:theme", locals: adminLocals }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { value?: unknown };
    expect(body.value).toBe("dark");
  });
});

describe("PUT /api/settings/[key] — value persistence", () => {
  beforeEach(() => vi.mocked(upsertSetting).mockClear());

  test("returns 200 { ok: true } on successful upsert", async () => {
    const res = await PUT(
      makeEvent({
        key: "ui:theme",
        locals: adminLocals,
        method: "PUT",
        body: { value: "light" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
    expect(upsertSetting).toHaveBeenCalledWith("ui:theme", "light");
  });
});
