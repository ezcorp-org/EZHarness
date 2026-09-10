import { expect, test } from "../fixtures/hydration.js";

test("always-expose persists the requester preference and creates a redeemable preview", async ({ request }) => {
  const seeded = await request.post("/api/__test/seed", {
    data: { title: "Preview consent round trip" },
  });
  expect(seeded.status(), await seeded.text()).toBe(201);
  const { conversationId } = await seeded.json();

  const exposed = await request.post("/api/preview/consent", {
    data: { conversationId, port: 5173, action: "always-expose" },
  });
  expect(exposed.ok(), await exposed.text()).toBeTruthy();
  const { previewId, code, subdomainLabel } = await exposed.json();
  expect(previewId).toBe(subdomainLabel);
  expect(code).toEqual(expect.any(String));

  const minted = await request.post(`/api/preview/${previewId}/token`);
  expect(minted.ok(), await minted.text()).toBeTruthy();
  expect((await minted.json()).code).toEqual(expect.any(String));
});
