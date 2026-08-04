/**
 * e2e (real tier): a `private` workflow you may not read is INVISIBLE on the
 * write verbs too, not merely refused.
 *
 * `denialStatus` (src/runtime/workflow-scope.ts) used to answer every EDIT
 * denial with a 403, including one against a `private` row the caller cannot
 * even see. A name that does not exist answered 404. Those two responses
 * differing is an existence oracle: `PUT /api/workflows/<guess>` told an
 * unprivileged caller whether `<guess>` was a real private workflow
 * belonging to somebody else. GET already hid it; PUT and DELETE did not.
 *
 * This HAS to be the real tier. The mock tier stubs `/api/workflows/**` at
 * the network layer, so the ladder never runs — the stub answers before the
 * code under test does. It also needs two GENUINELY different users: an API
 * key minted by the admin carries the ADMIN's `userId` (only the role is
 * clamped), so a key-based "member" is still the owner of everything the
 * admin created and the ladder would rightly let it through. So the second
 * principal here is a real second account, created through the invite flow.
 *
 * The discrimination that keeps this from being "404 everything": the
 * `project` workflow in the same run still answers 403. That tier's read
 * audience is every authenticated principal, so the caller can already see
 * it in their own list and a 404 would be a lie they could disprove in one
 * click.
 */
import { test, expect } from "@playwright/test";

// `workflow_definitions.name` is globally unique and a create is refused on a
// collision, so the run stamps its own names rather than assuming a fresh DB.
const RUN = Date.now();
const PRIVATE_NAME = `e2e-oracle-private-${RUN}`;
const PROJECT_NAME = `e2e-oracle-project-${RUN}`;
/** A name that is definitely not a workflow — the control response. */
const MISSING_NAME = `e2e-oracle-no-such-workflow-${RUN}`;

const definition = (name: string, visibility: "private" | "project") => ({
  name,
  description: "existence-oracle probe target",
  visibility,
  steps: [{ name: "one", kind: "transform", output: { a: "b" } }],
});

test.describe("workflows — a private row hides its existence from every verb", () => {
  test("PUT/DELETE on someone else's private workflow are indistinguishable from a missing name", async ({
    request,
    baseURL,
  }) => {
    // 1. As the bootstrapped admin (cookie via storageState), create the two
    //    target rows. Both are owned by the ADMIN, so the second user below
    //    owns neither.
    for (const [name, visibility] of [
      [PRIVATE_NAME, "private"],
      [PROJECT_NAME, "project"],
    ] as const) {
      const created = await request.post("/api/workflows", {
        data: definition(name, visibility),
      });
      expect(created.status(), await created.text()).toBe(201);
    }

    // 2. Mint a SECOND real account. An invite + accept is the only path that
    //    produces a distinct `users.id`, which is what the ownership rung
    //    actually compares.
    const email = `e2e-oracle-${RUN}@example.com`;
    const invited = await request.post("/api/auth/invite", {
      data: { email, role: "member" },
    });
    expect(invited.status(), await invited.text()).toBe(201);
    const { invite } = (await invited.json()) as { invite: { token: string } };

    const accepted = await fetch(`${baseURL}/api/auth/invite/${invite.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Oracle Probe", email, password: "ProbeUser1" }),
    });
    expect(accepted.status, await accepted.clone().text()).toBe(201);
    // The accept response sets the new user's session cookie. Forwarding it
    // by hand (rather than reusing Playwright's `request`) keeps the admin's
    // cookie provably absent from every probe below.
    const cookie = accepted
      .headers.getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(cookie.length).toBeGreaterThan(0);

    const asOther = (path: string, init: RequestInit = {}) =>
      fetch(`${baseURL}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), cookie },
      });

    // Sanity: the probe really is a different, authenticated principal.
    const me = await asOther("/api/auth/me");
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { user: { email: string; role: string } };
    expect(meBody.user.email).toBe(email);
    expect(meBody.user.role).toBe("member");

    // 3. The READ side, verified rather than assumed: GET is already a 404.
    const read = await asOther(`/api/workflows/${PRIVATE_NAME}`);
    expect(read.status).toBe(404);

    // 4. The oracle. Each write verb against the private row must match the
    //    same verb against a name that does not exist — STATUS and BODY,
    //    because either one alone still separates the two cases.
    const body = JSON.stringify({ description: "probed" });
    const jsonHeaders = { "content-type": "application/json" };
    /** Status + body together — comparing either alone still leaks. */
    const probe = async (name: string, method: "PUT" | "DELETE") => {
      const res = await asOther(`/api/workflows/${name}`, {
        method,
        ...(method === "PUT" ? { headers: jsonHeaders, body } : {}),
      });
      return { status: res.status, text: await res.text() };
    };

    const putPrivate = await probe(PRIVATE_NAME, "PUT");
    const putMissing = await probe(MISSING_NAME, "PUT");
    expect(putPrivate.status).toBe(404);
    expect(putPrivate).toEqual(putMissing);

    const delPrivate = await probe(PRIVATE_NAME, "DELETE");
    const delMissing = await probe(MISSING_NAME, "DELETE");
    expect(delPrivate.status).toBe(404);
    expect(delPrivate).toEqual(delMissing);

    // 5. Discrimination: the concealment is `private`-only. A `project` row
    //    the probe cannot edit still says 403 and says why — it is in their
    //    own list, so there is nothing left to hide.
    const putProject = await probe(PROJECT_NAME, "PUT");
    expect(putProject.status).toBe(403);
    expect(putProject).not.toEqual(putMissing);

    // 6. Discrimination: the 404s were CONCEALMENT, not absence, and not a
    //    delete that quietly succeeded. The owner still has both rows.
    const ownerRead = await request.get(`/api/workflows/${PRIVATE_NAME}`);
    expect(ownerRead.status(), await ownerRead.text()).toBe(200);
    expect(((await ownerRead.json()) as { visibility: string }).visibility).toBe("private");
  });
});
