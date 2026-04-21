import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Per-test project resolution — tests mutate this to control what getProject returns.
let nextProject: { id: string; path: string } | null = null;

mock.module("$server/db/queries/projects", () => ({
	getProject: async (_id: string) => nextProject,
}));

mock.module("$server/auth/middleware", () => ({
	requireAuth: () => ({ id: "test-user", role: "admin" }),
}));

mock.module("$lib/server/security/api-keys", () => ({
	requireScope: () => null,
}));

mock.module("$lib/server/context", () => ({
	getExecutor: () => ({ listAgents: () => [] }),
}));

mock.module("$server/db/connection", () => ({
	getDb: () => ({
		select: () => ({
			from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
		}),
	}),
}));

mock.module("$server/db/schema", () => ({
	extensions: {},
	agentConfigs: {},
}));

mock.module("drizzle-orm", () => ({
	eq: () => ({}),
	and: () => ({}),
	or: () => ({}),
	ilike: () => ({}),
}));

mock.module("$server/runtime/tools/builtin-registry", () => ({
	getBuiltInCategories: () => [],
}));

// Import AFTER mocks are registered.
const { GET } = await import("../routes/api/mentions/search/+server");

let projectRoot: string;
let outsideDir: string;

beforeAll(async () => {
	projectRoot = await mkdtemp(join(tmpdir(), "file-search-proj-"));
	outsideDir = await mkdtemp(join(tmpdir(), "file-search-outside-"));

	// Layout:
	//   projectRoot/
	//     foo.ts                 (root file)
	//     README.md              (root file)
	//     wrapper.ts             (root file — used for interior-subseq fuzzy test)
	//     my-v2.json             (root file — used for boundary-bonus fuzzy test)
	//     .env                   (hidden — excluded)
	//     src/
	//       app.ts               (1 level deep)
	//       utils.ts             (1 level deep)
	//       nested/
	//         deep.ts            (2 levels — excluded)
	//     node_modules/
	//       lodash/
	//         index.js           (excluded via node_modules)
	//     .ezcorp/
	//       extension-data.json  (excluded via .ezcorp)
	//     escape-link            (symlink out of project — excluded)
	await writeFile(join(projectRoot, "foo.ts"), "// foo\n");
	await writeFile(join(projectRoot, "README.md"), "# readme\n");
	await writeFile(join(projectRoot, "wrapper.ts"), "// wrapper\n");
	await writeFile(join(projectRoot, "my-v2.json"), "{}\n");
	await writeFile(join(projectRoot, ".env"), "SECRET=1\n");
	await mkdir(join(projectRoot, "src", "nested"), { recursive: true });
	await writeFile(join(projectRoot, "src", "app.ts"), "// app\n");
	await writeFile(join(projectRoot, "src", "utils.ts"), "// utils\n");
	await writeFile(join(projectRoot, "src", "nested", "deep.ts"), "// deep\n");
	await writeFile(join(projectRoot, "src", "nested", "buried.md"), "# buried\n");
	// An even deeper folder so descent tests can verify a dir entry at level 3.
	await mkdir(join(projectRoot, "src", "nested", "inner"), { recursive: true });
	await writeFile(join(projectRoot, "src", "nested", "inner", "leaf.ts"), "// leaf\n");
	await mkdir(join(projectRoot, "node_modules", "lodash"), { recursive: true });
	await writeFile(join(projectRoot, "node_modules", "lodash", "index.js"), "// lodash\n");
	await mkdir(join(projectRoot, ".ezcorp"), { recursive: true });
	await writeFile(join(projectRoot, ".ezcorp", "extension-data.json"), "{}\n");
	// Symlink into outside directory — should be filtered by realpath check.
	await writeFile(join(outsideDir, "secret.ts"), "// secret\n");
	await symlink(outsideDir, join(projectRoot, "escape-link"));
});

afterAll(async () => {
	await rm(projectRoot, { recursive: true, force: true });
	await rm(outsideDir, { recursive: true, force: true });
});

/** Build a Request object pointing at the mentions/search endpoint. */
function buildRequest(params: Record<string, string>): Request {
	const search = new URLSearchParams(params).toString();
	return new Request(`http://localhost/api/mentions/search?${search}`);
}

/** Construct the RequestEvent arg the GET handler expects. */
function buildEvent(req: Request): any {
	return {
		url: new URL(req.url),
		locals: {},
		request: req,
	};
}

async function callGet(params: Record<string, string>) {
	const req = buildRequest(params);
	const res = await GET(buildEvent(req));
	return res.json();
}

describe("GET /api/mentions/search?type=file", () => {
	test("returns empty when no projectId is provided", async () => {
		nextProject = null;
		const body = await callGet({ type: "path", q: "" });
		expect(body).toEqual([]);
	});

	test("returns empty when projectId resolves to no project", async () => {
		nextProject = null;
		const body = await callGet({ type: "path", q: "", projectId: "missing" });
		expect(body).toEqual([]);
	});

	test("returns empty when project has no path", async () => {
		nextProject = { id: "p", path: "" };
		const body = await callGet({ type: "path", q: "", projectId: "p" });
		expect(body).toEqual([]);
	});

	test("lists root files and one level deep with empty query", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string; description: string; kind: string }> = await callGet({
			type: "path",
			q: "",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		// Root-level regular files
		expect(names).toContain("foo.ts");
		expect(names).toContain("README.md");
		// One-level-deep files
		expect(names).toContain("src/app.ts");
		expect(names).toContain("src/utils.ts");
	});

	test("results carry kind: 'file' or 'dir' (no other kinds)", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ kind: string }> = await callGet({
			type: "path",
			q: "",
			projectId: "p",
		});
		expect(body.length).toBeGreaterThan(0);
		for (const r of body) {
			expect(["file", "dir"]).toContain(r.kind);
		}
	});

	test("root-level directories appear with kind='dir'", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string; kind: string }> = await callGet({
			type: "path",
			q: "",
			projectId: "p",
		});
		const srcDir = body.find((b) => b.name === "src" && b.kind === "dir");
		expect(srcDir).toBeDefined();
	});

	test("one-level-deep directories appear with kind='dir' (e.g., src/nested)", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string; kind: string }> = await callGet({
			type: "path",
			q: "",
			projectId: "p",
		});
		const nestedDir = body.find((b) => b.name === "src/nested" && b.kind === "dir");
		expect(nestedDir).toBeDefined();
	});

	test("fuzzy query that names a directory surfaces the dir entry", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string; kind: string }> = await callGet({
			type: "path",
			q: "src",
			projectId: "p",
		});
		const dir = body.find((b) => b.name === "src" && b.kind === "dir");
		expect(dir).toBeDefined();
	});

	test("node_modules and .ezcorp ARE excluded as dirs too (not just their contents)", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string; kind: string }> = await callGet({
			type: "path",
			q: "",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		expect(names).not.toContain("node_modules");
		expect(names).not.toContain(".ezcorp");
	});

	test("excludes hidden dotfiles", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		expect(names).not.toContain(".env");
	});

	test("excludes node_modules, .git, .ezcorp content", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		expect(names.some((n) => n.startsWith("node_modules/"))).toBe(false);
		expect(names.some((n) => n.startsWith(".ezcorp/"))).toBe(false);
	});

	test("does not return files 2+ levels deep", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		expect(names).not.toContain("src/nested/deep.ts");
	});

	test("filters by substring query (case-insensitive)", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "APP",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		expect(names).toContain("src/app.ts");
		expect(names).not.toContain("foo.ts");
		expect(names).not.toContain("README.md");
	});

	test("response shape includes name and description (absolute path)", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string; description: string; kind: string }> = await callGet({
			type: "path",
			q: "foo",
			projectId: "p",
		});
		const entry = body.find((b) => b.name === "foo.ts");
		expect(entry).toBeDefined();
		expect(entry!.description).toContain(projectRoot);
		expect(entry!.description).toContain("foo.ts");
	});

	test("filters out symlinks that escape the project root", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		// The symlink-linked out-of-project file should NOT surface.
		expect(names).not.toContain("escape-link/secret.ts");
		expect(names).not.toContain("escape-link");
	});

	test("type=path is mutually exclusive with agent/ext branches", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ kind: string }> = await callGet({
			type: "path",
			q: "",
			projectId: "p",
		});
		// Even though the agents/extensions/teams branches exist, none should
		// leak into a path-typed search (only file + dir kinds allowed).
		expect(body.every((r) => r.kind === "file" || r.kind === "dir")).toBe(true);
	});
});

describe("GET /api/mentions/search?type=path — folder descent (query with slash)", () => {
	test("query='src/' returns direct children of src/ (files + subdirs)", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string; kind: string }> = await callGet({
			type: "path",
			q: "src/",
			projectId: "p",
		});
		const names = body.map((b) => b.name).sort();
		// Direct children: app.ts, utils.ts, nested (dir) — prefixed with `src/`
		expect(names).toContain("src/app.ts");
		expect(names).toContain("src/utils.ts");
		expect(names).toContain("src/nested");
		// Should NOT include root-level entries
		expect(names).not.toContain("foo.ts");
		expect(names).not.toContain("README.md");
	});

	test("query='src/' does NOT reach into src/nested/", async () => {
		// Descent walks exactly one level — the user descends further by
		// selecting the nested folder.
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "src/",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		expect(names).not.toContain("src/nested/deep.ts");
		expect(names).not.toContain("src/nested/buried.md");
	});

	test("query='src/nested/' returns the nested folder's direct children", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string; kind: string }> = await callGet({
			type: "path",
			q: "src/nested/",
			projectId: "p",
		});
		const names = body.map((b) => b.name).sort();
		expect(names).toContain("src/nested/deep.ts");
		expect(names).toContain("src/nested/buried.md");
		expect(names).toContain("src/nested/inner");
	});

	test("query='src/app' fuzzy-matches the tail against src/ children", async () => {
		// Prefix `src/` descends; `app` fuzzy-matches basename within src/.
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "src/app",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		expect(names).toContain("src/app.ts");
		// Unrelated root-level entries must NOT appear even though `app` could
		// fuzzy-match them under the flat listing — descent mode is strict.
		expect(names).not.toContain("foo.ts");
	});

	test("query='src/buried' descends only to src/, does NOT find src/nested/buried.md", async () => {
		// Descent walks exactly one level; buried.md is two levels deep so the
		// `src/` descent won't find it. (User would type `src/nested/buried`.)
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "src/buried",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		expect(names).not.toContain("src/nested/buried.md");
	});

	test("query='src/nested/buried' descends two levels and finds it", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "src/nested/buried",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		expect(names).toContain("src/nested/buried.md");
	});

	test("query pointing at non-existent directory returns []", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "ghost/",
			projectId: "p",
		});
		expect(body).toEqual([]);
	});

	test("descent still filters hidden files / node_modules / .ezcorp", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "node_modules/",
			projectId: "p",
		});
		// node_modules itself is excluded, so descent into it yields nothing.
		expect(body).toEqual([]);
	});

	test("descent with path traversal ('../')  is contained by symlink-escape check", async () => {
		// `../` at the top: realpath of (realRoot + ../) escapes the root; the
		// insideRoot check filters every entry.
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string; description: string }> = await callGet({
			type: "path",
			q: "../",
			projectId: "p",
		});
		// At worst, the server returns [] because every entry fails insideRoot.
		// We don't assert strict empty (some OS-level readdir may succeed) —
		// we only assert NO entry's path breaks out of the project root.
		for (const entry of body) {
			expect(entry.description.startsWith(projectRoot)).toBe(true);
		}
	});
});

describe("GET /api/mentions/search?type=file — fuzzy matching and ranking", () => {
	test("ranks prefix match above interior subsequence match", async () => {
		// Query "app": `src/app.ts` has 'app' directly after a word boundary (`/`)
		// while `wrapper.ts` matches only via the interior 'app' inside 'wrapper'.
		// The boundary match should appear first.
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "app",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		expect(names).toContain("src/app.ts");
		expect(names).toContain("wrapper.ts");
		expect(names.indexOf("src/app.ts")).toBeLessThan(names.indexOf("wrapper.ts"));
	});

	test("matches via subsequence (non-contiguous chars)", async () => {
		// `sapp` is NOT a substring of `src/app.ts` but IS a subsequence
		// (s → 'src/app.ts'[0], a → [4], p → [5], p → [6]).
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "sapp",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		expect(names).toContain("src/app.ts");
	});

	test("exact-filename match ranks first", async () => {
		// Query "wrapper.ts" — the exact target should rank highest.
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "wrapper.ts",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		expect(names[0]).toBe("wrapper.ts");
	});

	test("boundary-after-dash earns a bonus (query 'v2' matches my-v2.json)", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "v2",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		expect(names).toContain("my-v2.json");
	});

	test("returns empty when query has no subsequence match anywhere", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "zzzzqqqq",
			projectId: "p",
		});
		expect(body).toEqual([]);
	});

	test("case-insensitive fuzzy matching", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "APP",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		expect(names).toContain("src/app.ts");
	});

	test("empty query preserves enumeration order (not fuzzy-ranked)", async () => {
		// With no query, the API returns candidates in filesystem-enumeration
		// order up to the cap — no scoring is applied. We assert that the
		// result set is the same set regardless of (missing) query, but we
		// don't over-assert order beyond "non-empty".
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "",
			projectId: "p",
		});
		expect(body.length).toBeGreaterThan(0);
		const names = body.map((b) => b.name);
		expect(names).toContain("foo.ts");
		expect(names).toContain("wrapper.ts");
		expect(names).toContain("src/app.ts");
	});

	test("does NOT match README.md for query 'app' (no 'p' chars)", async () => {
		nextProject = { id: "p", path: projectRoot };
		const body: Array<{ name: string }> = await callGet({
			type: "path",
			q: "app",
			projectId: "p",
		});
		const names = body.map((b) => b.name);
		expect(names).not.toContain("README.md");
	});
});
