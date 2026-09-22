import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const DEV_USER = "1000:1000";
const VOLUME_ROOTS = [
	"/app",
	"/app/state",
	"/app/cache",
	"/app/web",
	"/app/web/.ezcorp",
	"/app/.ezcorp",
	"/app/.ezcorp/extension-releases",
] as const;

async function dockerfile(): Promise<string> {
	return Bun.file(join(ROOT, "Dockerfile.dev")).text();
}

function instructions(source: string): string[] {
	return source
		.split("\n")
		.reduce<string[]>((lines, line) => {
			const previous = lines.at(-1);
			if (previous?.endsWith("\\")) {
				lines[lines.length - 1] = `${previous.slice(0, -1)} ${line.trim()}`;
			} else {
				lines.push(line.trim());
			}
			return lines;
		}, [])
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

describe("Dockerfile.dev image ownership", () => {
	test("constructs UID:GID 1000 ownership without recursively copying up /app", async () => {
		const source = await dockerfile();
		const steps = instructions(source);

		expect(source).not.toMatch(/\bchown\s+-R\b/);

		const setup = steps.find(
			(step) => step.startsWith("RUN ") && step.includes("mkdir -p /app/state"),
		);
		expect(setup).toBeDefined();
		for (const root of VOLUME_ROOTS) {
			expect(setup).toContain(root);
		}
		expect(setup).toContain(`chown ${DEV_USER} ${VOLUME_ROOTS.join(" ")}`);

		const unprivilegedUser = steps.indexOf(`USER ${DEV_USER}`);
		expect(unprivilegedUser).toBeGreaterThan(steps.indexOf(setup!));

		const copies = steps.filter((step) => step.startsWith("COPY "));
		expect(copies.length).toBeGreaterThan(0);
		for (const copy of copies) {
			expect(copy).toStartWith(`COPY --chown=${DEV_USER} `);
		}

		const writableSteps = steps.filter(
			(step) => step.startsWith("RUN ") && /(bun install|bun run --cwd)/.test(step),
		);
		expect(writableSteps).toHaveLength(3);
		for (const step of writableSteps) {
			expect(steps.indexOf(step)).toBeGreaterThan(unprivilegedUser);
		}

		const installs = writableSteps.filter((step) => step.includes("bun install"));
		expect(installs).toHaveLength(2);
		for (const install of installs) {
			expect(install).toContain(
				"--mount=type=cache,target=/home/bun/.bun/install/cache,uid=1000,gid=1000,sharing=locked",
			);
			expect(install).toContain("BUN_INSTALL_CACHE_DIR=/home/bun/.bun/install/cache");
		}

		const runtimeUser = steps.lastIndexOf("USER root");
		expect(runtimeUser).toBeGreaterThan(unprivilegedUser);
		for (const step of writableSteps) {
			expect(steps.indexOf(step)).toBeLessThan(runtimeUser);
		}
	});
});
