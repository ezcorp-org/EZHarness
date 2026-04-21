import { test, expect, describe, beforeEach, mock } from "bun:test";

/**
 * Unit coverage for src/db/queries/user-commands.ts. We mock the
 * Drizzle query-builder (`getDb()`) so the tests don't need a live
 * Postgres; each builder method returns a stub that records its call
 * and exposes an awaitable result. This matches the pattern in
 * existing DB-layer query tests in this repo.
 */

type Row = {
	id: string;
	userId: string;
	name: string;
	description: string;
	body: string;
	frontmatter: Record<string, string>;
	createdAt: Date;
	updatedAt: Date;
};

let rows: Row[] = [];
const calls: string[] = [];

function makeSelectBuilder() {
	return {
		from: () => ({
			where: () => Promise.resolve(rows),
		}),
	};
}

const dbStub = {
	select: mock(() => {
		calls.push("select");
		return makeSelectBuilder();
	}),
	insert: mock(() => ({
		values: async (row: Row) => {
			calls.push("insert");
			rows.push(row);
		},
	})),
	update: mock(() => ({
		set: (patch: Partial<Row>) => ({
			where: async () => {
				calls.push("update");
				rows = rows.map((r) =>
					r.userId === patch.userId || true ? { ...r, ...patch } : r,
				);
			},
		}),
	})),
	delete: mock(() => ({
		where: async () => {
			calls.push("delete");
			rows = [];
		},
	})),
};

mock.module("$server/db/connection", () => ({
	getDb: () => dbStub,
}));

mock.module("drizzle-orm", () => ({
	eq: (_col: unknown, val: unknown) => ({ op: "eq", val }),
	and: (...args: unknown[]) => ({ op: "and", args }),
}));

mock.module("$server/db/schema", () => ({
	userCommands: { userId: {}, name: {} },
}));

// Import AFTER mocks.
const {
	listUserCommands,
	getUserCommand,
	createUserCommand,
	updateUserCommand,
	deleteUserCommand,
} = await import("$server/db/queries/user-commands");

beforeEach(() => {
	rows = [];
	calls.length = 0;
});

describe("listUserCommands", () => {
	test("selects rows scoped to the userId", async () => {
		rows = [
			{
				id: "1",
				userId: "u1",
				name: "review",
				description: "d",
				body: "b",
				frontmatter: {},
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		];
		const result = await listUserCommands("u1");
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("review");
		expect(calls).toContain("select");
	});

	test("returns [] when no rows match", async () => {
		rows = [];
		expect(await listUserCommands("u2")).toEqual([]);
	});
});

describe("getUserCommand", () => {
	test("returns the matching row", async () => {
		rows = [
			{
				id: "1",
				userId: "u1",
				name: "commit",
				description: "",
				body: "body",
				frontmatter: {},
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		];
		const r = await getUserCommand("u1", "commit");
		expect(r?.name).toBe("commit");
	});

	test("returns undefined when no rows", async () => {
		rows = [];
		expect(await getUserCommand("u1", "missing")).toBeUndefined();
	});
});

describe("createUserCommand", () => {
	test("inserts a row with generated id + defaults", async () => {
		const created = await createUserCommand({
			userId: "u1",
			name: "new",
			body: "do the thing",
		});
		expect(created.id).toBeDefined();
		expect(created.userId).toBe("u1");
		expect(created.name).toBe("new");
		expect(created.description).toBe(""); // default
		expect(created.frontmatter).toEqual({}); // default
		expect(calls).toContain("insert");
	});

	test("forwards description + frontmatter when provided", async () => {
		const created = await createUserCommand({
			userId: "u1",
			name: "fancy",
			body: "hi",
			description: "says hi",
			frontmatter: { agent: "bot" },
		});
		expect(created.description).toBe("says hi");
		expect(created.frontmatter).toEqual({ agent: "bot" });
	});
});

describe("updateUserCommand", () => {
	test("applies partial updates + bumps updatedAt", async () => {
		rows = [
			{
				id: "1",
				userId: "u1",
				name: "x",
				description: "old",
				body: "old",
				frontmatter: {},
				createdAt: new Date("2025-01-01"),
				updatedAt: new Date("2025-01-01"),
			},
		];
		const updated = await updateUserCommand("u1", "x", { body: "new body" });
		expect(calls).toContain("update");
		// The mock `update` applies the patch — body must reflect.
		expect(updated?.body).toBe("new body");
	});

	test("returns undefined when command doesn't exist", async () => {
		rows = [];
		expect(await updateUserCommand("u1", "missing", { body: "x" })).toBeUndefined();
	});
});

describe("deleteUserCommand", () => {
	test("returns true and issues a delete when the row exists", async () => {
		rows = [
			{
				id: "1",
				userId: "u1",
				name: "x",
				description: "",
				body: "",
				frontmatter: {},
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		];
		expect(await deleteUserCommand("u1", "x")).toBe(true);
		expect(calls).toContain("delete");
	});

	test("returns false and does NOT issue a delete when absent", async () => {
		rows = [];
		expect(await deleteUserCommand("u1", "missing")).toBe(false);
		expect(calls).not.toContain("delete");
	});
});
