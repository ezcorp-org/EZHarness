/**
 * e2e (real tier): `GET /api/health?detail=true` is reachable by an admin over
 * real HTTP, while the bare liveness path stays anonymous.
 *
 * `/api/health` sits in `PUBLIC_PATHS` in `web/src/hooks.server.ts`, and
 * `event.locals.user` used to be assigned ONLY inside the `if (!isPublic)`
 * branch — so the detail branch's `role === "admin"` gate never saw a
 * principal and answered 401 to every caller, admins included. The Settings →
 * System Health card polls exactly this URL and could only ever render
 * "Unable to load health status."
 *
 * F5's remedy for `/api/auth/invite` (move the bare path into
 * PUBLIC_SUBPATHS_ONLY) is not available here: a liveness probe must answer an
 * anonymous caller on its bare path forever. So the hook now resolves a
 * presented session cookie opportunistically on public `/api/*` paths.
 *
 * This has to be the REAL tier for the same reason the invite spec does: the
 * mock tier stubs `/api/health` at the network layer (several specs under
 * `web/e2e/`), so the request never reaches `hooks.server.ts` — which is
 * precisely why the bug survived. The stub answers before the broken code runs.
 */
import { test, expect } from "../fixtures/hydration.js";

test.describe("admin health-detail reachability", () => {
  test("?detail=true needs an admin; the bare probe needs nobody", async ({
    request,
    baseURL,
  }) => {
    // `request` carries the bootstrapped admin session cookie (storageState).
    // Pre-fix this returned 401 no matter who asked.
    const detail = await request.get("/api/health?detail=true");
    expect(detail.status(), await detail.text()).toBe(200);
    const body = (await detail.json()) as {
      status?: string;
      db?: { status: string };
      embeddings?: { status: string };
      providers?: Record<string, unknown>;
    };
    // The component breakdown is the whole point of `?detail=true` — a bare
    // `{ status }` would mean the detail branch was skipped, not reached.
    expect(body.status).toMatch(/^(healthy|degraded)$/);
    expect(body.db?.status).toBe("up");
    expect(body.embeddings?.status).toMatch(/^(ready|not_initialized)$/);
    expect(body.providers).toBeDefined();

    // Cookieless raw fetch — proves the detail branch is genuinely gated and
    // not merely passing because the browser context happens to be authed.
    const anonDetail = await fetch(`${baseURL}/api/health?detail=true`);
    expect(anonDetail.status).toBe(401);
    expect((await anonDetail.json()).error).toBe("Admin access required");

    // Direction 2, the one the fix must not have cost: the liveness probe is
    // still answerable with no auth at all, and still returns ONLY the
    // top-level status. This is what the Docker HEALTHCHECK and any
    // orchestrator poll.
    const anonProbe = await fetch(`${baseURL}/api/health`);
    expect(anonProbe.status).toBe(200);
    const probeBody = await anonProbe.json();
    expect(probeBody.status).toMatch(/^(healthy|degraded)$/);
    expect(probeBody.db).toBeUndefined();
    expect(probeBody.providers).toBeUndefined();
  });

  test("the other two public system probes are unchanged and anonymous", async ({
    baseURL,
  }) => {
    // `/api/ready` and `/api/version` share the PUBLIC_PATHS allowlist with
    // `/api/health`, so they were checked for the same latent defect. Neither
    // reads `locals` nor applies a role gate — they return the same body to
    // every caller — so there was nothing to fix. Pinned here so a future
    // role gate on either one cannot be added without a failing test.
    const ready = await fetch(`${baseURL}/api/ready`);
    expect([200, 503]).toContain(ready.status);
    expect((await ready.json()).state).toMatch(/^(booting|ready|degraded)$/);

    const version = await fetch(`${baseURL}/api/version`);
    expect(version.status).toBe(200);
    expect(typeof (await version.json()).current).toBe("string");
  });
});
