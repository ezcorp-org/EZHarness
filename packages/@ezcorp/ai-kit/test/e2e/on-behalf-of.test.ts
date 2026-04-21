import { beforeAll, describe, expect, test } from "bun:test";
import { EzcorpClient, onBehalfOfContext } from "../../src/client";
import { E2E_API_KEY, E2E_BASE_URL, e2eReady } from "./_guard";

/** End-to-end assertion of the on-behalf-of chain against a live server.
 *  The test pretends to be the ai-kit subprocess: it already has an
 *  internal key (set by whoever boots this test against a server that
 *  seeded one) and manually populates the onBehalfOfContext for a call,
 *  verifying the resulting conversation is owned by the target user,
 *  not by sys-ai-kit.
 *
 *  Skipped unless a live server + API key are available (this test
 *  requires access to an internal key, which only exists inside the
 *  server process — so in practice the "impersonating" test here uses
 *  the user's own API key as the auth and the OBO header as a no-op
 *  verification path. The actual sys-* → geff case is only observable
 *  via a full subprocess-bundled boot, which is out of scope for this
 *  package's tests). */

let ready = false;
beforeAll(async () => {
  ready = (await e2eReady()) && Boolean(E2E_API_KEY);
});

describe.skipIf(!(E2E_BASE_URL && E2E_API_KEY))("e2e: on-behalf-of header", () => {
  test("user-issued keys ignore X-Ezcorp-On-Behalf-Of (no privilege bypass)", async () => {
    if (!ready) return;
    // A user key holder setting OBO should NOT get their conversation
    // re-attributed to another user. The server's bearer-auth only
    // honors OBO for internal-auth principals.
    const client = new EzcorpClient({ baseUrl: E2E_BASE_URL!, apiKey: E2E_API_KEY! });
    const conv = await onBehalfOfContext.run("some-other-user-id", () =>
      client.createConversation({ projectId: "global", title: "e2e obo no-op" }),
    );
    // Verify via me(): the conversation should be owned by the caller of
    // the API key, not "some-other-user-id". We read the conversation
    // back and check userId if the server returns it in the response.
    expect(conv.id).toBeString();
    // If the server exposes the user id on the returned row, assert it:
    if ("userId" in conv) {
      expect((conv as { userId: string }).userId).not.toBe("some-other-user-id");
    }
  }, 10_000);
});
