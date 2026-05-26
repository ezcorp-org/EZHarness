import { test, expect, describe, afterEach } from "bun:test";
import {
  readCredentials,
  buildTransportSpec,
  resolveClient,
  getProductionClient,
  _setSubstackClientForTests,
  _setSubstackClientFactoryForTests,
  _resetSubstackClientForTests,
  type SubstackClient,
  type SubstackCredentials,
} from "../lib/substack-client";

const CREDS: SubstackCredentials = {
  publicationUrl: "https://me.substack.com",
  sessionToken: "tok-xyz",
  userId: "12345",
};

const SETTINGS = {
  substack_publication_url: CREDS.publicationUrl,
  substack_session_token: CREDS.sessionToken,
  substack_user_id: CREDS.userId,
};

function fakeClient(): SubstackClient {
  return {
    async listOwnPostComments() {
      return [];
    },
    async postCommentReply() {
      return { ok: true };
    },
    async listNewSubscribers(c) {
      return { subscribers: [], cursor: c ?? "" };
    },
    async sendDirectMessage() {
      return { ok: true };
    },
    async listNote(id) {
      return { id, author: "", body: "" };
    },
    async postNoteComment() {
      return { ok: true };
    },
  };
}

afterEach(() => {
  _resetSubstackClientForTests();
});

describe("readCredentials", () => {
  test("returns creds when all three settings are present + non-empty", () => {
    expect(readCredentials(SETTINGS)).toEqual(CREDS);
  });

  test("returns null when any setting is missing", () => {
    expect(readCredentials({})).toBeNull();
    expect(readCredentials({ substack_publication_url: CREDS.publicationUrl })).toBeNull();
    expect(
      readCredentials({
        substack_publication_url: CREDS.publicationUrl,
        substack_session_token: CREDS.sessionToken,
      }),
    ).toBeNull();
  });

  test("returns null for blank / non-string values", () => {
    expect(
      readCredentials({ ...SETTINGS, substack_session_token: "" }),
    ).toBeNull();
    expect(
      readCredentials({ ...SETTINGS, substack_user_id: 123 as unknown as string }),
    ).toBeNull();
  });

  test("undefined settings → null", () => {
    expect(readCredentials(undefined)).toBeNull();
  });
});

describe("buildTransportSpec", () => {
  test("spawn shape is npx -y substack-mcp@latest with the allowlisted env", () => {
    const spec = buildTransportSpec(CREDS);
    expect(spec.command).toBe("npx");
    expect(spec.args).toEqual(["-y", "substack-mcp@latest"]);
    expect(spec.env.SUBSTACK_PUBLICATION_URL).toBe(CREDS.publicationUrl);
    expect(spec.env.SUBSTACK_SESSION_TOKEN).toBe(CREDS.sessionToken);
    expect(spec.env.SUBSTACK_USER_ID).toBe(CREDS.userId);
    // Only the 5 allowlisted keys — never the host's full process.env.
    expect(Object.keys(spec.env).sort()).toEqual([
      "HOME",
      "PATH",
      "SUBSTACK_PUBLICATION_URL",
      "SUBSTACK_SESSION_TOKEN",
      "SUBSTACK_USER_ID",
    ]);
  });
});

describe("resolveClient", () => {
  test("returns the injected test client when set (no creds needed)", async () => {
    const c = fakeClient();
    _setSubstackClientForTests(c);
    const res = await resolveClient({});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.client).toBe(c);
  });

  test("MISSING_CREDENTIALS when no client + no creds", async () => {
    _setSubstackClientForTests(null);
    const res = await resolveClient({});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("MISSING_CREDENTIALS");
      expect(res.error).toContain("credentials missing");
    }
  });

  test("builds the production client via the injected factory + threads creds/transport", async () => {
    _setSubstackClientForTests(null);
    const captured: { creds?: SubstackCredentials; command?: string } = {};
    const made = fakeClient();
    _setSubstackClientFactoryForTests(async (creds, transport) => {
      captured.creds = creds;
      captured.command = transport.command;
      return made;
    });
    const res = await resolveClient(SETTINGS);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.client).toBe(made);
    expect(captured.creds).toEqual(CREDS);
    expect(captured.command).toBe("npx");
  });

  test("factory throw → TRANSPORT_ERROR (no crash)", async () => {
    _setSubstackClientForTests(null);
    _setSubstackClientFactoryForTests(async () => {
      throw new Error("spawn ENOENT");
    });
    const res = await resolveClient(SETTINGS);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("TRANSPORT_ERROR");
      expect(res.error).toContain("spawn ENOENT");
    }
  });
});

describe("getProductionClient", () => {
  test("memoizes the client across calls within a subprocess lifetime", async () => {
    let factoryCalls = 0;
    const made = fakeClient();
    _setSubstackClientFactoryForTests(async () => {
      factoryCalls++;
      return made;
    });
    const a = await getProductionClient(CREDS);
    const b = await getProductionClient(CREDS);
    expect(a).toBe(b);
    expect(factoryCalls).toBe(1);
  });
});
