import { expect, test, vi } from "vitest";
import { renderExtensionPage, type RenderPullDeps } from "./hub-render-pull";
import { ExtensionPageCache } from "$server/extensions/page-cache";
import type { Extension } from "$server/db/schema";

vi.setConfig({ testTimeout: 30_000 });

function fixture() {
  const extension = { id: crypto.randomUUID(), name: "private-page", grantedPermissions: { eventSubscriptions: [] } } as unknown as Extension;
  const callPage = vi.fn(async (_extension: Extension, _page: string, userId: string) => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return { jsonrpc: "2.0" as const, id: "render", result: { title: `Private data for ${userId}`, nodes: [] } };
  });
  const deps: Partial<RenderPullDeps> = { authorize: async () => "release-1:grants-1", findPage: async () => ({ extension, page: { id: "dashboard", title: "Private page" } }), callPage, cache: new ExtensionPageCache(), timeoutMs: 1000 };
  return { deps, callPage };
}

test("a second authenticated viewer never receives the first viewer's cached page", async () => {
  const { deps, callPage } = fixture();
  expect((await renderExtensionPage("private-page", "dashboard", "alice", deps)).page?.title).toBe("Private data for alice");
  expect((await renderExtensionPage("private-page", "dashboard", "bob", deps)).page?.title).toBe("Private data for bob");
  expect(callPage).toHaveBeenCalledTimes(2);
});

test("concurrent viewers never share a render promise with another principal", async () => {
  const { deps, callPage } = fixture();
  const [alice, bob] = await Promise.all([renderExtensionPage("private-page", "dashboard", "alice", deps), renderExtensionPage("private-page", "dashboard", "bob", deps)]);
  expect(alice.page?.title).toBe("Private data for alice");
  expect(bob.page?.title).toBe("Private data for bob");
  expect(callPage).toHaveBeenCalledTimes(2);
});

test("revoked access cannot read a fresh cached page", async () => {
  const { deps, callPage } = fixture();
  await renderExtensionPage("private-page", "dashboard", "alice", deps);
  deps.authorize = async () => { throw new Error("Membership revoked"); };
  expect(await renderExtensionPage("private-page", "dashboard", "alice", deps)).toEqual({ notFound: true });
  expect(callPage).toHaveBeenCalledTimes(1);
});

test("release, generation or grant changes cannot reuse cached content", async () => {
  const { deps, callPage } = fixture();
  for (const binding of ["release-1:grants-1", "release-2:grants-1", "release-2:grants-2", "release-2:grants-2:g3"]) {
    deps.authorize = async () => binding;
    expect((await renderExtensionPage("private-page", "dashboard", "alice", deps)).page?.title).toBe("Private data for alice");
  }
  expect(callPage).toHaveBeenCalledTimes(4);
});

test("authority revoked while rendering discards the output", async () => {
  const { deps } = fixture();
  let reads = 0;
  deps.authorize = async () => { if (++reads > 1) throw new Error("Revoked"); return "release-1"; };
  expect(await renderExtensionPage("private-page", "dashboard", "alice", deps)).toEqual({ notFound: true });
});

test("changed authority while rendering never stores or returns old output", async () => {
  const { deps } = fixture();
  let reads = 0;
  deps.authorize = async () => ++reads === 1 ? "old-release" : "new-release";
  expect((await renderExtensionPage("private-page", "dashboard", "alice", deps)).error).toContain("Page access changed");
});

test("the host bounds concurrent private render work without joining other principals", async () => {
  const { deps } = fixture();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  deps.callPage = async () => { await hold; return { jsonrpc: "2.0", id: 1, result: { title: "bounded", nodes: [] } }; };
  const calls = Array.from({ length: 129 }, (_, index) => renderExtensionPage("private-page", "dashboard", `principal-${index}`, deps));
  try { expect((await Promise.race(calls)).error).toContain("Too many page renders"); }
  finally { release(); }
  expect((await Promise.all(calls)).filter(result => result.page)).toHaveLength(128);
});

test("compound scope values cannot collide across run and view fields", async () => {
  const { deps, callPage } = fixture();
  await renderExtensionPage("private-page", "dashboard", "alice", deps, undefined, "one:view:two");
  await renderExtensionPage("private-page", "dashboard", "alice", deps, undefined, "one", undefined, "two");
  expect(callPage).toHaveBeenCalledTimes(2);
});
