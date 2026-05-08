/**
 * Phase 52.3 — server loader test for the per-conversation audit
 * `+page.server.ts`.
 *
 * Auth surface (owner-only / admin-bypass) is covered by the API
 * route's unit suite (`api-conversations-id-audit.server.test.ts`).
 * This test focuses on the path-scope guard: the loader must 404
 * when the URL's `params.id` (project segment) doesn't match the
 * resolved conversation's `projectId`. Without that check, an admin
 * (or owner of any conv) could paste a foreign-project URL and the
 * loader would silently render the audit page for a conversation
 * that doesn't belong to the project shown in the breadcrumb — an
 * information-disclosure surface the reviewer flagged.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/conversations", () => ({
	getConversation: vi.fn(),
	getMessages: vi.fn(),
}));

vi.mock("$server/db/queries/audit-merge", () => ({
	mergeAuditForConversation: vi.fn(),
}));

vi.mock("$server/db/queries/extensions", () => ({
	listExtensions: vi.fn(),
}));

const { getConversation, getMessages } = await import(
	"$server/db/queries/conversations"
);
const { mergeAuditForConversation } = await import(
	"$server/db/queries/audit-merge"
);
const { listExtensions } = await import("$server/db/queries/extensions");
const { load } = await import(
	"../routes/(app)/project/[id]/chat/[convId]/audit/+page.server.ts"
);

const ownerUser = { id: "u-owner", email: "o@x", name: "owner", role: "user" };
const adminUser = { id: "u-admin", email: "a@x", name: "admin", role: "admin" };

function makeEvent(opts: {
	params: { id: string; convId: string };
	locals: Record<string, unknown>;
}) {
	return {
		params: opts.params,
		locals: opts.locals,
	} as any;
}

describe("/project/[id]/chat/[convId]/audit +page.server.ts", () => {
	beforeEach(() => {
		vi.mocked(getConversation).mockReset();
		vi.mocked(getMessages).mockReset();
		vi.mocked(mergeAuditForConversation).mockReset();
		vi.mocked(listExtensions).mockReset();
		vi.mocked(getMessages).mockResolvedValue([] as any);
		vi.mocked(mergeAuditForConversation).mockResolvedValue({
			entries: [],
			nextCursor: null,
		});
		vi.mocked(listExtensions).mockResolvedValue([] as any);
	});

	test("unknown conversation → 404", async () => {
		vi.mocked(getConversation).mockResolvedValue(null as any);
		await expect(
			load(
				makeEvent({
					params: { id: "proj-1", convId: "conv-missing" },
					locals: { user: ownerUser },
				}),
			),
		).rejects.toMatchObject({ status: 404 });
	});

	test("conv.projectId mismatches params.id → 404 (path-scope guard)", async () => {
		// Owner has access to the conv, but pasted a URL with a
		// different project segment. Loader must fail-closed.
		vi.mocked(getConversation).mockResolvedValue({
			id: "conv-1",
			userId: ownerUser.id,
			projectId: "proj-OTHER",
			title: "Other project conv",
		} as any);
		await expect(
			load(
				makeEvent({
					params: { id: "proj-1", convId: "conv-1" },
					locals: { user: ownerUser },
				}),
			),
		).rejects.toMatchObject({ status: 404 });
		// The merger must not have been called — the guard fires before
		// any DB read past the conversation lookup.
		expect(vi.mocked(mergeAuditForConversation)).not.toHaveBeenCalled();
	});

	test("admin pasting a foreign-project URL is also 404", async () => {
		// Admins bypass owner-only gating but do NOT bypass the path-
		// scope guard — the project segment in the breadcrumb must
		// match the actual conv's project.
		vi.mocked(getConversation).mockResolvedValue({
			id: "conv-1",
			userId: ownerUser.id,
			projectId: "proj-OTHER",
			title: "Other project conv",
		} as any);
		await expect(
			load(
				makeEvent({
					params: { id: "proj-1", convId: "conv-1" },
					locals: { user: adminUser },
				}),
			),
		).rejects.toMatchObject({ status: 404 });
	});

	test("non-owner non-admin → 404 (fail-closed, mirrors API)", async () => {
		vi.mocked(getConversation).mockResolvedValue({
			id: "conv-1",
			userId: "u-someone-else",
			projectId: "proj-1",
		} as any);
		await expect(
			load(
				makeEvent({
					params: { id: "proj-1", convId: "conv-1" },
					locals: { user: ownerUser },
				}),
			),
		).rejects.toMatchObject({ status: 404 });
	});

	test("happy path returns entries + cursor + light message projection", async () => {
		vi.mocked(getConversation).mockResolvedValue({
			id: "conv-1",
			userId: ownerUser.id,
			projectId: "proj-1",
			title: "My conv",
		} as any);
		vi.mocked(getMessages).mockResolvedValue([
			{
				id: "m1",
				role: "user",
				createdAt: "2026-05-01T10:00:00Z",
				content: "hello world",
			},
		] as any);
		vi.mocked(mergeAuditForConversation).mockResolvedValue({
			entries: [{ kind: "capability", id: "c1" } as any],
			nextCursor: "cur-2",
		});
		const result = (await load(
			makeEvent({
				params: { id: "proj-1", convId: "conv-1" },
				locals: { user: ownerUser },
			}),
		)) as {
			conversation: { id: string; title: string; projectId: string };
			entries: unknown[];
			nextCursor: string | null;
			messages: Array<{ id: string; contentPreview: string }>;
			extensionsById: Record<string, unknown>;
		};
		expect(result.conversation).toMatchObject({ id: "conv-1", projectId: "proj-1" });
		expect(result.entries).toHaveLength(1);
		expect(result.nextCursor).toBe("cur-2");
		expect(result.messages[0]!.contentPreview).toBe("hello world");
	});
});
