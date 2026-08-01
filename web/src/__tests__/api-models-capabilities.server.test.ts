/**
 * Server-handler unit tests for /api/models/capabilities (+server.ts).
 *
 * Pure URL-param + auth surface — no DB or network calls reachable from
 * the error paths exercised below.
 */

import { test, expect, describe, beforeEach, vi } from "vitest";
import { GET } from "../routes/api/models/capabilities/+server";

function makeEvent(href: string, locals: Record<string, unknown> = {}) {
  return { url: new URL(href), locals } as any;
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

describe("GET /api/models/capabilities", () => {
  test("rejects unauthenticated callers with 401", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent("http://localhost/api/models/capabilities?provider=anthropic&model=claude-opus"));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("returns 400 when provider param is missing", async () => {
    const res = await GET(
      makeEvent("http://localhost/api/models/capabilities?model=claude-opus", authedUser),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("provider and model");
  });

  test("returns 400 when model param is missing", async () => {
    const res = await GET(
      makeEvent("http://localhost/api/models/capabilities?provider=anthropic", authedUser),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("provider and model");
  });
});

// ── Auto (smart routing) ────────────────────────────────────────────────
//
// Auto has no concrete model, so the handler answers with the INTERSECTION of
// every rung of the tier ladder. These tests pin the behaviour that keeps the
// composer's paperclip usable on turn 1 without over-promising a capability
// the model actually served might not have.

vi.mock("$server/db/queries/settings", () => ({
	getSetting: vi.fn(async () => undefined),
}));

vi.mock("$server/db/queries/conversation-extensions", () => ({
	getConversationExtensionMimes: vi.fn(async () => []),
	getExtensionMimesByNames: vi.fn(() => []),
}));

const capsByModel = new Map<string, unknown>();

vi.mock("$server/providers/model-capabilities", () => ({
	getCapabilitiesWithExtensions: (provider: string, model: string) =>
		capsByModel.get(`${provider}::${model}`) ?? {
			kinds: ["text", "pdf", "image"],
			acceptedMimeTypes: ["text/plain", "application/pdf", "image/png"],
			maxBytesPerFile: 10_000_000,
			maxFilesPerMessage: 10,
			deliveryStrategy: "inline",
		},
}));

describe("GET /api/models/capabilities?provider=auto&model=auto", () => {
	beforeEach(() => {
		capsByModel.clear();
	});

	test("answers with the ladder intersection instead of 400/404", async () => {
		const res = await GET(
			makeEvent("http://localhost/api/models/capabilities?provider=auto&model=auto", authedUser),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			provider: string;
			model: string;
			kinds: string[];
			acceptedMimeTypes: string[];
		};
		// The sentinel is echoed back so the client cache keys on it.
		expect(body.provider).toBe("auto");
		expect(body.model).toBe("auto");
		expect(body.kinds.length).toBeGreaterThan(0);
		expect(body.acceptedMimeTypes).toContain("text/plain");
	});

	test("does NOT offer a capability that some rung lacks", async () => {
		// Make ONE default-ladder rung text-only. Whatever else the ladder
		// holds, images must drop out — routing could serve that rung.
		const { DEFAULT_TIER_LADDER } = await import("$server/runtime/routing/tier-ladder");
		const firstRung = DEFAULT_TIER_LADDER.fast[0]!;
		capsByModel.set(`${firstRung.provider}::${firstRung.model}`, {
			kinds: ["text"],
			acceptedMimeTypes: ["text/plain"],
			maxBytesPerFile: 2_000_000,
			maxFilesPerMessage: 3,
			deliveryStrategy: "inline",
		});

		const res = await GET(
			makeEvent("http://localhost/api/models/capabilities?provider=auto&model=auto", authedUser),
		);
		const body = (await res.json()) as {
			kinds: string[];
			acceptedMimeTypes: string[];
			maxBytesPerFile: number;
			maxFilesPerMessage: number;
		};
		expect(body.kinds).not.toContain("image");
		expect(body.acceptedMimeTypes).not.toContain("image/png");
		// Limits clamp to the most restrictive rung.
		expect(body.maxBytesPerFile).toBe(2_000_000);
		expect(body.maxFilesPerMessage).toBe(3);
	});

	test("404s rather than inventing limits when the ladder has no rungs", async () => {
		const settings = await import("$server/db/queries/settings");
		vi.mocked(settings.getSetting).mockResolvedValueOnce({
			fast: [],
			balanced: [],
			powerful: [],
		});
		const res = await GET(
			makeEvent("http://localhost/api/models/capabilities?provider=auto&model=auto", authedUser),
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("auto selection");
	});

	test("drafted `!ext:NAME` mentions widen the accepted MIME set", async () => {
		// The `extensions=` param carries extension names the user has typed but
		// not yet sent, so an .xlsx can be dragged into a fresh chat mentioning
		// `!ext:excel` on the FIRST message instead of after a round-trip.
		const ext = await import("$server/db/queries/conversation-extensions");
		vi.mocked(ext.getExtensionMimesByNames).mockReturnValueOnce([
			"application/vnd.ms-excel",
		] as never);

		const res = await GET(
			makeEvent(
				"http://localhost/api/models/capabilities?provider=anthropic&model=claude-opus&extensions=excel,%20sheets",
				authedUser,
			),
		);
		expect(res.status).toBe(200);
		// Names are trimmed and blanks dropped before the registry lookup.
		expect(vi.mocked(ext.getExtensionMimesByNames)).toHaveBeenCalledWith(["excel", "sheets"]);
	});

	test("an empty `extensions=` param resolves to no drafted names", async () => {
		const ext = await import("$server/db/queries/conversation-extensions");
		vi.mocked(ext.getExtensionMimesByNames).mockClear();
		const res = await GET(
			makeEvent(
				"http://localhost/api/models/capabilities?provider=anthropic&model=claude-opus&extensions=%20,%20",
				authedUser,
			),
		);
		expect(res.status).toBe(200);
		// All-blank list filters to empty, so the registry is never consulted.
		expect(vi.mocked(ext.getExtensionMimesByNames)).not.toHaveBeenCalled();
	});

	test("a concrete model is unaffected by the auto branch", async () => {
		const res = await GET(
			makeEvent(
				"http://localhost/api/models/capabilities?provider=anthropic&model=claude-opus",
				authedUser,
			),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { provider: string; model: string };
		expect(body.provider).toBe("anthropic");
		expect(body.model).toBe("claude-opus");
	});
});
