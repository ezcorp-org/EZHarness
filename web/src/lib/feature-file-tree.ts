/**
 * Pure tree builder for the `$feature` chip's hover popover.
 *
 * Takes a flat list of project-relative file paths (the shape stored in
 * `feature_files.relpath`) and produces a nested tree of `dir` and
 * `file` nodes mirroring how a code editor's explorer pane lays them
 * out. Sort order matches the editor convention: directories first,
 * then files, both alphabetised case-insensitively.
 *
 * Pure / framework-free so it can be unit-tested without DOM and reused
 * elsewhere if another surface ever needs the same shape.
 */

export type FileTreeFile = {
	type: "file";
	/** basename — `bar.ts` for `src/foo/bar.ts` */
	name: string;
	/** full project-relative path — what the LLM / scanner sees */
	path: string;
};

export type FileTreeDir = {
	type: "dir";
	name: string;
	path: string;
	children: FileTreeNode[];
};

export type FileTreeNode = FileTreeFile | FileTreeDir;

type DirAccum = {
	path: string;
	children: Map<string, DirAccum>;
	files: string[];
};

/**
 * Build a sorted tree from raw relpaths.
 *
 * - Duplicate relpaths are collapsed (same file shouldn't appear twice
 *   even if both a `'scan'` and `'user'` row exist for it — composite
 *   PK normally prevents this, but be defensive).
 * - Empty / leading-slash inputs are skipped so a malformed row can't
 *   produce a phantom top-level "/" directory.
 */
export function buildFileTree(relpaths: readonly string[]): FileTreeNode[] {
	const root: DirAccum = { path: "", children: new Map(), files: [] };
	const seen = new Set<string>();

	for (const raw of relpaths) {
		if (!raw) continue;
		// Drop leading `./` or `/` so the path starts at a real segment.
		const normalised = raw.replace(/^\.?\//, "");
		if (!normalised || seen.has(normalised)) continue;
		seen.add(normalised);

		const parts = normalised.split("/").filter((p) => p.length > 0);
		if (parts.length === 0) continue;

		let cur = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const segment = parts[i]!;
			let next = cur.children.get(segment);
			if (!next) {
				const nextPath = cur.path ? `${cur.path}/${segment}` : segment;
				next = { path: nextPath, children: new Map(), files: [] };
				cur.children.set(segment, next);
			}
			cur = next;
		}
		cur.files.push(parts[parts.length - 1]!);
	}

	return materialise(root);
}

function materialise(acc: DirAccum): FileTreeNode[] {
	const dirs: FileTreeDir[] = [];
	for (const [name, sub] of acc.children) {
		dirs.push({
			type: "dir",
			name,
			path: sub.path,
			children: materialise(sub),
		});
	}
	dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

	const files: FileTreeFile[] = acc.files
		.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
		.map((name) => ({
			type: "file",
			name,
			path: acc.path ? `${acc.path}/${name}` : name,
		}));

	return [...dirs, ...files];
}
