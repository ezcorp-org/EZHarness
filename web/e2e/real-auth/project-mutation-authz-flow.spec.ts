/**
 * e2e: PUT/DELETE /api/projects/[id] are admin-only, end-to-end.
 *
 * Before the fix these two handlers ran with NO authorization past
 * `requireAuth` — scope check, auth check, then straight to the write. Any
 * authenticated principal could destroy any project by id, or silently
 * repoint its `path` (which drives filesystem scoping for that project).
 *
 * There is no owner to check: `projects` (src/db/schema.ts:24-32) has no
 * `userId`/`createdBy` column and there is no `project_members` table — see
 * the note in src/runtime/workflow-scope.ts:173-181. So the enforced rule is
 * role-based: mutating an instance-global object requires the admin role.
 *
 * The member-role key below is minted WITH the `read` scope — exactly the
 * scope these handlers ask for. It therefore clears the scope gate and is
 * stopped only by the role gate. That is deliberate: it demonstrates the fix
 * lives on the ownership/role axis and that `requireScope(locals, "read")`
 * was left untouched (whether `read` should authorize deletion at all is a
 * separate open question, not resolved here).
 *
 * Raw `fetch` is used for the member calls so the bootstrapped admin's
 * session cookie is provably absent — the only authority is the key.
 *
 * Not covered here: the null-`userId` knowledge-base branch of the same
 * change. `POST /api/knowledge-base` always stamps `userId`
 * (web/src/routes/api/knowledge-base/+server.ts:80), so an unowned row is not
 * reachable over HTTP and that branch is pinned at handler level instead, in
 * src/__tests__/security/cross-tenant-deletion-projects-kb-modes.test.ts.
 */
import { test, expect } from "@playwright/test";

test.describe("projects — mutating routes are admin-only", () => {
  test("member-role key cannot delete or repoint a project; admin still can", async ({
    request,
    baseURL,
  }) => {
    // 1. As the bootstrapped admin (cookie), create the target project.
    const createRes = await request.post("/api/projects", {
      data: { name: "e2e-authz-target", path: "/tmp/e2e-authz-target" },
    });
    expect(createRes.status(), await createRes.text()).toBe(201);
    const project = (await createRes.json()) as { id: string; path: string };
    expect(project.id).toBeTruthy();

    // 2. Mint a member-role key that DOES hold the `read` scope the handlers
    //    require, so the scope gate cannot be what refuses it below.
    const keyRes = await request.post("/api/settings/developer/api-keys", {
      // role omitted → member
      data: { name: "e2e-projects-authz", scopes: ["read"] },
    });
    expect(keyRes.status(), await keyRes.text()).toBe(201);
    const memberKey = (await keyRes.json()) as { key: string; role: string };
    expect(memberKey.role).toBe("member");

    // Cookieless bearer helper — the key is the ONLY authority.
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${baseURL}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${memberKey.key}` },
      });

    // Sanity: the principal really is a member, and it really is authenticated
    // (so the 403s below are authorization, not a failed login).
    const me = await call("/api/auth/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { role: string } }).user.role).toBe("member");

    // The member CAN still read the project — reads stay instance-global, and
    // this proves the id is valid, so the refusals below are not a bad id.
    const memberGet = await call(`/api/projects/${project.id}`);
    expect(memberGet.status).toBe(200);

    // 3. ATTACK: member deletes an instance project. Refused.
    const memberDelete = await call(`/api/projects/${project.id}`, { method: "DELETE" });
    expect(memberDelete.status, await memberDelete.text()).toBe(403);

    // 4. ATTACK: member repoints the project's filesystem path. Refused, and
    //    no mutation landed.
    const memberPut = await call(`/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/attacker/controlled" }),
    });
    expect(memberPut.status, await memberPut.text()).toBe(403);

    const afterAttack = await request.get(`/api/projects/${project.id}`);
    expect(afterAttack.status()).toBe(200);
    const stillThere = (await afterAttack.json()) as { path: string };
    expect(stillThere.path).toBe("/tmp/e2e-authz-target");

    // 5. The admin (cookie) can still do both — a fix that denies everyone
    //    would pass steps 3-4 on its own.
    const adminPut = await request.put(`/api/projects/${project.id}`, {
      data: { name: "e2e-authz-renamed" },
    });
    expect(adminPut.status(), await adminPut.text()).toBe(200);
    expect(((await adminPut.json()) as { name: string }).name).toBe("e2e-authz-renamed");

    const adminDelete = await request.delete(`/api/projects/${project.id}`);
    expect(adminDelete.status(), await adminDelete.text()).toBe(200);

    // …and it is really gone.
    const gone = await request.get(`/api/projects/${project.id}`);
    expect(gone.status()).toBe(404);
  });
});
