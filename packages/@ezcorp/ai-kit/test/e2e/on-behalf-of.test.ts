// @ezcorp-host-integration
import { beforeAll, describe, expect, test } from "bun:test";
import { EzcorpClient, onBehalfOfContext } from "../../src/client";
import { E2E_API_KEY, E2E_BASE_URL, requireE2eReady } from "./_guard";

/** A user API key cannot change conversation ownership with an OBO header.
 * The real-auth browser lane supplies its own server and test-user key.
 * Internal-key delegation is covered by real-subprocess-obo.test.ts. */

describe.skipIf(!(E2E_BASE_URL && E2E_API_KEY))("e2e: on-behalf-of header", () => {
  beforeAll(requireE2eReady);

  test("user-issued keys ignore X-Ezcorp-On-Behalf-Of (no privilege bypass)", async () => {
    // A user key holder setting OBO should NOT get their conversation
    // re-attributed to another user. The server's bearer-auth only
    // honors OBO for internal-auth principals.
    const client = new EzcorpClient({ baseUrl: E2E_BASE_URL!, apiKey: E2E_API_KEY! });
    const user = await client.me();
    const conv = await onBehalfOfContext.run("some-other-user-id", () =>
      client.createConversation({ projectId: "global", title: "e2e obo no-op" }),
    );
    expect(conv.id).toBeString();
    expect(conv).toMatchObject({ userId: user.id });
    expect(await client.getConversation(conv.id)).toMatchObject({ id: conv.id, userId: user.id });
  }, 10_000);
});
