import { test, expect, describe, beforeEach, mock } from "bun:test";

/**
 * Unit coverage for `findFreeName` + the rename behaviors wired into
 * createUserCommand / updateUserCommand. Mirrors the mocking pattern
 * in user-commands-queries.test.ts: stub the Drizzle query-builder
 * via `getDb()` so the helper's logic is exercised without a live
 * Postgres.
 *
 * Coverage targets:
 *   - findFreeName: no collision returns desired; collision returns -2;
 *     gap-respecting (a, a-3 → a-2); honors `ignoreName` so a row's
 *     own name isn't treated as a self-collision.
 *   - createUserCommand: applies the rename inline (POST review twice
 *     → second saved as review-2; third → review-3).
 *   - updateUserCommand: rename-path through `patch.name` applies the
 *     same suffix policy; no rename when name unchanged; returns
 *     undefined when target row missing.
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

function makeSelectBuilder() {
	return {
		from: () => ({
			where: () => Promise.resolve(rows),
		}),
	};
}

const dbStub = {
	select: mock(() => makeSelectBuilder()),
	insert: mock(() => ({
		values: async (row: Row) => {
			rows.push(row);
		},
	})),
	update: mock(() => ({
		set: (patch: Partial<Row>) => ({
			where: async () => {
				// Mock applies the patch to every row (the test seeds a single
				// row at a time so the wider match is fine).
				rows = rows.map((r) => ({ ...r, ...patch }));
			},
		}),
	})),
	delete: mock(() => ({
		where: async () => {
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
	findFreeName,
	createUserCommand,
	updateUserCommand,
} = await import("$server/db/queries/user-commands");

beforeEach(() => {
	rows = [];
});

function seed(userId: string, names: string[]) {
	rows = names.map((n, i) => ({
		id: `id-${i}`,
		userId,
		name: n,
		description: "",
		body: "",
		frontmatter: {},
		createdAt: new Date(),
		updatedAt: new Date(),
	}));
}

describe("findFreeName", () => {
	test("returns desired name when no collision", async () => {
		seed("u1", []);
		expect(await findFreeName("u1", "review")).toBe("review");
	});

	test("returns -2 suffix when desired name is taken", async () => {
		seed("u1", ["review"]);
		expect(await findFreeName("u1", "review")).toBe("review-2");
	});

	test("returns -3 when both desired and -2 are taken", async () => {
		seed("u1", ["review", "review-2"]);
		expect(await findFreeName("u1", "review")).toBe("review-3");
	});

	test("handles gap: a + a-3 → a-2", async () => {
		seed("u1", ["a", "a-3"]);
		expect(await findFreeName("u1", "a")).toBe("a-2");
	});

	test("ignoreName skips a row's own current name", async () => {
		seed("u1", ["review"]);
		// Asking for `review` while ignoring the row already named `review`
		// returns `review` (the row would keep its name on an update).
		expect(await findFreeName("u1", "review", "review")).toBe("review");
	});

	test("ignoreName only applies to that one row — other collisions still suffix", async () => {
		seed("u1", ["review", "audit"]);
		// Ignoring `audit` doesn't help if the desired name is `review`.
		expect(await findFreeName("u1", "review", "audit")).toBe("review-2");
	});
});

describe("createUserCommand auto-suffix", () => {
	test("first create keeps desired name", async () => {
		const c = await createUserCommand({ userId: "u1", name: "review", body: "b" });
		expect(c.name).toBe("review");
	});

	test("second create with same name auto-suffixes to -2", async () => {
		await createUserCommand({ userId: "u1", name: "review", body: "b" });
		const c2 = await createUserCommand({ userId: "u1", name: "review", body: "b" });
		expect(c2.name).toBe("review-2");
	});

	test("third create with same name advances to -3", async () => {
		await createUserCommand({ userId: "u1", name: "review", body: "b" });
		await createUserCommand({ userId: "u1", name: "review", body: "b" });
		const c3 = await createUserCommand({ userId: "u1", name: "review", body: "b" });
		expect(c3.name).toBe("review-3");
	});
});

describe("updateUserCommand rename-path", () => {
	test("returns undefined when row missing", async () => {
		seed("u1", []);
		const r = await updateUserCommand("u1", "absent", { body: "x" });
		expect(r).toBeUndefined();
	});

	test("patch with same name updates without renaming", async () => {
		seed("u1", ["a"]);
		const r = await updateUserCommand("u1", "a", { name: "a", body: "new" });
		expect(r).toBeDefined();
		// Mock applies patch globally; `name` should not have been touched
		// because patch.name === name.
		expect(r!.name).toBe("a");
	});

	test("patch with new free name renames cleanly", async () => {
		seed("u1", ["a"]);
		const r = await updateUserCommand("u1", "a", { name: "b" });
		expect(r).toBeDefined();
		expect(r!.name).toBe("b");
	});

	test("patch with colliding new name auto-suffixes", async () => {
		seed("u1", ["a", "b"]);
		const r = await updateUserCommand("u1", "a", { name: "b" });
		// Mock-level: after rename the row's name becomes 'b-2'. Because the
		// stub's update applies the patch to every row, both rows now have
		// `name: 'b-2'`; the follow-up getUserCommand reads `userId, savedName`
		// → first matching row wins. The assertion that matters is `savedName`.
		expect(r).toBeDefined();
		expect(r!.name).toBe("b-2");
	});
});
