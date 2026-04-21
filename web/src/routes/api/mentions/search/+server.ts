import { json } from "@sveltejs/kit";
import { getExecutor, getCommandRegistry } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getDb } from "$server/db/connection";
import { extensions, agentConfigs } from "$server/db/schema";
import { eq, and, or, ilike } from "drizzle-orm";
import { readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as projectQueries from "$server/db/queries/projects";
import { fuzzyScore } from "$lib/fuzzy-match";
import type { RequestHandler } from "./$types";

const MAX_RESULTS = 10;

// Directory entries we never surface in file-mention autocomplete. Matches
// the UX rules we've agreed on with the user: hidden dotfiles, dependency
// folders, git metadata, and our own extension-data directory.
const EXCLUDED_DIR_NAMES = new Set<string>(["node_modules", ".git", ".ezcorp"]);

type FileType = "ext" | "agent" | "team" | "path" | "cmd";

interface PathCandidate {
	name: string;
	description: string;
	kind: "file" | "dir";
}

/**
 * Read a single directory's direct children and push matching entries into
 * `out`. Respects the exclusion list + symlink-escape check.
 */
async function readDirectChildren(
	realRoot: string,
	absDir: string,
	relDirPrefix: string,
	out: PathCandidate[],
): Promise<void> {
	async function insideRoot(absPath: string): Promise<boolean> {
		try {
			const real = await realpath(absPath);
			return real === realRoot || real.startsWith(realRoot + "/");
		} catch {
			return false;
		}
	}

	if (!(await insideRoot(absDir))) return;

	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(absDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const d of entries) {
		if (d.name.startsWith(".")) continue;
		if (EXCLUDED_DIR_NAMES.has(d.name)) continue;
		const abs = join(absDir, d.name);
		if (!(await insideRoot(abs))) continue;
		const rel = relDirPrefix ? `${relDirPrefix}/${d.name}` : d.name;
		if (d.isDirectory()) {
			out.push({ name: rel, description: abs, kind: "dir" });
			continue;
		}
		if (!d.isFile() && !d.isSymbolicLink()) continue;
		out.push({ name: rel, description: abs, kind: "file" });
	}
}

/**
 * List candidate paths for `@[file|dir:…]` autocomplete.
 *
 * Query semantics (enables folder-tree navigation):
 *   - **No slash in query** (e.g. `""` or `"src"`) → list project root +
 *     one-level-deep entries (files & dirs), fuzzy-ranked by the query.
 *     Unchanged from the flat-listing behaviour.
 *   - **Slash in query** (e.g. `"src/"` or `"src/ne"` or `"src/nested/"`) →
 *     "descent" mode. Let `dirPrefix` = everything up to & including the
 *     last `/`, and `tail` = everything after. List the direct children of
 *     `<project>/<dirPrefix>`; if `tail` is non-empty, fuzzy-match it
 *     against the child `basename`. Result entries carry the full
 *     relative path (e.g. `src/nested`, `src/app.ts`).
 *
 * In descent mode we do **not** recurse further — the user can keep
 * selecting folders to walk deeper level-by-level.
 *
 * Symlinks that escape the project root are filtered out. Results are
 * sliced to `limit` after ranking.
 */
async function listProjectFiles(
	projectPath: string,
	query: string,
	limit: number,
): Promise<PathCandidate[]> {
	let realRoot: string;
	try {
		realRoot = await realpath(projectPath);
	} catch {
		return [];
	}

	const candidates: PathCandidate[] = [];
	const lastSlash = query.lastIndexOf("/");

	if (lastSlash >= 0) {
		// Descent mode: walk ONE specific folder.
		const dirPrefix = query.slice(0, lastSlash); // e.g. "src/nested"
		const tail = query.slice(lastSlash + 1); // e.g. "ap" or ""

		// Honour the exclusion policy in descent mode too: if any segment of
		// the descent prefix is an excluded dir (node_modules / .git /
		// .ezcorp) or a hidden dotfile, return []. Prevents the user from
		// typing `@node_modules/` to sidestep the root-level filter.
		const segments = dirPrefix.split("/").filter((s) => s.length > 0);
		for (const seg of segments) {
			if (seg.startsWith(".")) return [];
			if (EXCLUDED_DIR_NAMES.has(seg)) return [];
		}

		const absDir = dirPrefix ? join(realRoot, dirPrefix) : realRoot;
		await readDirectChildren(realRoot, absDir, dirPrefix, candidates);

		if (!tail) return candidates.slice(0, limit);

		const scored: Array<{ c: PathCandidate; score: number }> = [];
		for (const c of candidates) {
			// Match against the *basename* so the user's typed tail doesn't
			// have to duplicate the prefix they just descended into.
			const lastIdx = c.name.lastIndexOf("/");
			const basename = lastIdx >= 0 ? c.name.slice(lastIdx + 1) : c.name;
			const s = fuzzyScore(tail, basename);
			if (s !== null) scored.push({ c, score: s });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit).map((x) => x.c);
	}

	// No slash: original flat listing (root + one level deep).
	await readDirectChildren(realRoot, realRoot, "", candidates);
	// Descend one level for each root-level dir and add its children.
	const rootDirs = candidates.filter((c) => c.kind === "dir").map((c) => c.name);
	for (const sub of rootDirs) {
		await readDirectChildren(realRoot, join(realRoot, sub), sub, candidates);
	}

	if (!query) return candidates.slice(0, limit);

	const scored: Array<{ c: PathCandidate; score: number }> = [];
	for (const c of candidates) {
		const s = fuzzyScore(query, c.name);
		if (s !== null) scored.push({ c, score: s });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((x) => x.c);
}

export const GET: RequestHandler = async ({ url, locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	const user = requireAuth(locals);

	const q = url.searchParams.get("q") ?? "";
	const type = url.searchParams.get("type") as FileType | null;
	const projectId = url.searchParams.get("projectId");
	const results: Array<{
		name: string;
		description: string;
		kind: "agent" | "extension" | "team" | "file" | "dir" | "command";
		source?: string;
		body?: string;
	}> = [];
	const lowerQ = q.toLowerCase();
	const pattern = `%${q}%`;

	// Slash-command searches are mutually exclusive with other kinds.
	// The registry merges filesystem + DB sources; we fuzzy-rank by name
	// (or description) and return at most MAX_RESULTS entries. Unlike
	// `type=path`, missing projectId is tolerated — registry falls back
	// to home + DB commands only.
	if (type === "cmd") {
		let projectPath: string | null = null;
		if (projectId) {
			const project = await projectQueries.getProject(projectId);
			projectPath = project?.path ? resolve(project.path) : null;
		}
		const registry = getCommandRegistry();
		const cmds = await registry.listCommands({
			userId: user.id,
			projectId: projectId ?? "global",
			projectPath,
		});

		if (!q) {
			for (const c of cmds.slice(0, MAX_RESULTS)) {
				results.push({
					name: c.name,
					description: c.description,
					kind: "command",
					source: c.source,
					body: c.body,
				});
			}
			return json(results);
		}

		const scored: Array<{ c: typeof cmds[number]; score: number }> = [];
		for (const c of cmds) {
			const nameScore = fuzzyScore(q, c.name);
			const descScore = fuzzyScore(q, c.description);
			const best =
				nameScore !== null && descScore !== null
					? Math.max(nameScore, descScore)
					: nameScore !== null
					? nameScore
					: descScore;
			if (best !== null) scored.push({ c, score: best });
		}
		scored.sort((a, b) => b.score - a.score);
		for (const { c } of scored.slice(0, MAX_RESULTS)) {
			results.push({
				name: c.name,
				description: c.description,
				kind: "command",
				source: c.source,
				body: c.body,
			});
		}
		return json(results);
	}

	// Path searches are mutually exclusive with other kinds — when the `@`
	// sigil is active the popover lists files + dirs only. If no active
	// project (or unknown project), return an empty list instead of falling
	// through to agent/ext/team results.
	if (type === "path") {
		if (!projectId) return json([]);
		const project = await projectQueries.getProject(projectId);
		const projectPath = project?.path ? resolve(project.path) : null;
		if (!projectPath) return json([]);
		const paths = await listProjectFiles(projectPath, q, MAX_RESULTS);
		for (const p of paths) {
			results.push({ name: p.name, description: p.description, kind: p.kind });
		}
		return json(results);
	}

	// Search teams first (unless filtered to agents or extensions only)
	if (type !== "agent" && type !== "ext") {
		const teamConditions = [eq(agentConfigs.category, "team")];
		if (q) {
			teamConditions.push(or(ilike(agentConfigs.name, pattern), ilike(agentConfigs.description, pattern))!);
		}
		const teams = await getDb()
			.select({ name: agentConfigs.name, description: agentConfigs.description })
			.from(agentConfigs)
			.where(and(...teamConditions))
			.limit(MAX_RESULTS);
		for (const t of teams) {
			results.push({ name: t.name, description: t.description, kind: "team" });
			if (results.length >= MAX_RESULTS) break;
		}
	}

	// Search agents (unless filtered to extensions or teams only)
	if (type !== "ext" && type !== "team" && results.length < MAX_RESULTS) {
		const teamNames = new Set(results.filter((r) => r.kind === "team").map((r) => r.name));
		const executor = getExecutor();
		const agents = executor.listAgents();
		for (const a of agents) {
			if (teamNames.has(a.name)) continue;
			if (!q || a.name.toLowerCase().includes(lowerQ) || a.description.toLowerCase().includes(lowerQ)) {
				results.push({ name: a.name, description: a.description, kind: "agent" });
			}
			if (results.length >= MAX_RESULTS) break;
		}
	}

	// Search extensions (unless filtered to agents or teams only)
	if (type !== "agent" && type !== "team" && results.length < MAX_RESULTS) {
		const remaining = MAX_RESULTS - results.length;
		const conditions = [eq(extensions.enabled, true)];
		if (q) {
			conditions.push(or(ilike(extensions.name, pattern), ilike(extensions.description, pattern))!);
		}
		const exts = await getDb()
			.select({ name: extensions.name, description: extensions.description })
			.from(extensions)
			.where(and(...conditions))
			.limit(remaining);
		for (const e of exts) {
			results.push({ name: e.name, description: e.description, kind: "extension" });
		}
	}

	// Search built-in tool categories (unless filtered to agents or teams only)
	if (type !== "agent" && type !== "team" && results.length < MAX_RESULTS) {
		const { getBuiltInCategories } = await import("$server/runtime/tools/builtin-registry");
		const existingNames = new Set(results.map(r => r.name));
		for (const cat of getBuiltInCategories()) {
			if (existingNames.has(cat.name)) continue;
			if (!q || cat.name.toLowerCase().includes(lowerQ) || cat.description.toLowerCase().includes(lowerQ)) {
				results.push({ name: cat.name, description: cat.description, kind: "extension" });
			}
			if (results.length >= MAX_RESULTS) break;
		}
	}

	return json(results);
};
