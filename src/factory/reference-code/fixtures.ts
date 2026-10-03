import type { ReferenceCodeFile } from "./snapshot";

/**
 * The C10 golden fixture: one supported launch repository and every candidate a test needs.
 *
 * The repository is real, not a sketch. Its lockfile was produced by `bun install`, its scripts run
 * under Bun and TypeScript, and at the base commit the protected test suite FAILS, because
 * `slugify` throws. That last part is what makes the valid journey mean something: a candidate only
 * passes `declared-tests` by actually implementing the request.
 *
 * The negative candidates are the three C10 names plus the two scan cases. Each one breaks exactly
 * one mandatory claim, so a test that expects a rejection also proves WHICH protected rule refused
 * it rather than that something, somewhere, went wrong.
 */

/** The exact bytes of the launch repository at its base commit. */
export const REFERENCE_CODE_LAUNCH_FILES: Readonly<Record<string, string>> = Object.freeze({
  ["package.json"]: `{
  "name": "slugify-launch",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "bun build src/slugify.ts --outdir dist --target bun",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "devDependencies": {
    "@types/bun": "1.3.5",
    "typescript": "5.9.3"
  }
}
`,
  ["bun.lock"]: `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "slugify-launch",
      "devDependencies": {
        "@types/bun": "1.3.5",
        "typescript": "5.9.3",
      },
    },
  },
  "packages": {
    "@types/bun": ["@types/bun@1.3.5", "", { "dependencies": { "bun-types": "1.3.5" } }, "sha512-RnygCqNrd3srIPEWBd5LFeUYG7plCoH2Yw9WaZGyNmdTEei+gWaHqydbaIRkIkcbXwhBT94q78QljxN0Sk838w=="],

    "@types/node": ["@types/node@26.5.1", "", { "dependencies": { "undici-types": "~8.9.0" } }, "sha512-CzNm2FezW4VR/LjG6yUdiEgLE/rAQ9Slj5gCu/C2VrdcW7I0ahNZ8DRbHT7zOZ6r3ONgd/bsQIeSaoDGrd1C6g=="],

    "bun-types": ["bun-types@1.3.5", "", { "dependencies": { "@types/node": "*" } }, "sha512-inmAYe2PFLs0SUbFOWSVD24sg1jFlMPxOjOSSCYqUgn4Hsc3rDc7dFvfVYjFPNHtov6kgUeulV4SxbuIV/stPw=="],

    "typescript": ["typescript@5.9.3", "", { "bin": { "tsc": "bin/tsc", "tsserver": "bin/tsserver" } }, "sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw=="],

    "undici-types": ["undici-types@8.9.0", "", {}, "sha512-KTDyRTYX8sWmKXAikPHHSyc63CRPETMctyjKFupcC6OBLXT3xsN0e9aF7m+mIXutFWpUXuedtowG7iLOzp0kQg=="],
  }
}
`,
  ["tsconfig.json"]: `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["src", "test"]
}
`,
  ["src/slugify.ts"]: `/** Turns a title into a URL slug. */
export function slugify(_value: string): string {
  throw new Error("slugify is not implemented");
}
`,
  ["test/slugify.protected.test.ts"]: `import { expect, test } from "bun:test";
import { slugify } from "../src/slugify.ts";

test("slugifies the golden title", () => {
  expect(slugify("Hello, Factory!")).toBe("hello-factory");
});

test("empty input slugifies to an empty string", () => {
  expect(slugify("")).toBe("");
});

test("punctuation-only input slugifies to an empty string", () => {
  expect(slugify("!!!")).toBe("");
});

test("repeated spaces collapse into one separator", () => {
  expect(slugify("a   b")).toBe("a-b");
});
`,
});

/** The request text a tenant files, and the boundaries it is approved for. */
export const REFERENCE_CODE_FIXTURE_REQUEST = Object.freeze({
  issue: 'Implement `slugify` in `src/slugify.ts` so that `slugify("Hello, Factory!")` returns "hello-factory". Lowercase the input, treat every run of non-alphanumeric characters as one separator, join the remaining words with single hyphens, and return an empty string when no words remain. Do not change any test or configuration file.',
  title: "Implement slugify",
  allowedPaths: Object.freeze(["src/"]),
  protectedPaths: Object.freeze(["test/slugify.protected.test.ts", "package.json", "tsconfig.json", "bun.lock"]),
  dependencyLockPath: "bun.lock",
  baseBranch: "main",
});

/** The implementation that satisfies every protected claim. */
export const REFERENCE_CODE_ACCEPTED_SLUGIFY = `/** Turns a title into a URL slug: lowercase words joined by single hyphens. */
export function slugify(value: string): string {
  const words: string[] = [];
  let word = "";
  for (const character of value.toLowerCase()) {
    if ((character >= "a" && character <= "z") || (character >= "0" && character <= "9")) {
      word += character;
      continue;
    }
    if (word.length > 0) {
      words.push(word);
      word = "";
    }
  }
  if (word.length > 0) words.push(word);
  return words.join("-");
}
`;

/** Returns the requested case rather than a slug: the golden assertion fails. */
const UNCHANGED_CASE_SLUGIFY = `/** Turns a title into a URL slug. */
export function slugify(value: string): string {
  return value.replace(/[^A-Za-z0-9!]+/g, "-");
}
`;

/**
 * A hard-coded provider key. Correct output, and still unreleasable.
 *
 * The key is assembled from parts rather than written out, so this repository's own scanners see
 * no contiguous credential literal while the fixture file the validator reads still contains one.
 */
const LEAKED_SECRET_SLUGIFY = [
  `const TELEMETRY_KEY = "${["sk", "ant", "api03"].join("-")}-QmFkU2VjcmV0Rm9yVGVzdGluZ09ubHlOb3RBUmVhbEtleQAA-ZmFrZQAA";`,
  "",
  REFERENCE_CODE_ACCEPTED_SLUGIFY.replace("const words: string[] = [];", "void TELEMETRY_KEY;\n  const words: string[] = [];"),
].join("\n");

/** A manifest that adds a dependency the pinned advisory snapshot rates critical. */
const VULNERABLE_MANIFEST = REFERENCE_CODE_LAUNCH_FILES["package.json"]!.replace(
  '"devDependencies": {',
  '"dependencies": {\n    "event-stream": "3.3.6"\n  },\n  "devDependencies": {',
);

const encoder = new TextEncoder();

function file(path: string, text: string): ReferenceCodeFile {
  return { path, mode: "100644", content: encoder.encode(text) };
}

/** The launch repository as a complete, sorted file list. */
export function referenceCodeLaunchRepository(): readonly ReferenceCodeFile[] {
  return Object.entries(REFERENCE_CODE_LAUNCH_FILES)
    .map(([path, text]) => file(path, text))
    .sort((left, right) => (left.path < right.path ? -1 : 1));
}

/** Replaces one path in a complete tree, keeping every other byte identical. */
export function withReferenceCodeFile(files: readonly ReferenceCodeFile[], path: string, text: string): readonly ReferenceCodeFile[] {
  const replaced = files.map(entry => (entry.path === path ? file(path, text) : entry));
  if (replaced.some(entry => entry.path === path)) return replaced;
  return [...replaced, file(path, text)].sort((left, right) => (left.path < right.path ? -1 : 1));
}

/** Drops one path from a complete tree. */
export function withoutReferenceCodeFile(files: readonly ReferenceCodeFile[], path: string): readonly ReferenceCodeFile[] {
  return files.filter(entry => entry.path !== path);
}

export type ReferenceCodeFixtureName =
  | "accepted"
  | "unchanged-case"
  | "removed-protected-test"
  | "outside-allowed-paths"
  | "leaked-secret"
  | "vulnerable-dependency";

/**
 * Every fixture candidate, by the claim it is built to exercise.
 *
 * `accepted` is the one that must pass. The rest each fail exactly one mandatory claim:
 * `unchanged-case` fails the declared tests, `removed-protected-test` changes a protected asset,
 * `outside-allowed-paths` writes where the request was not approved, `leaked-secret` trips the
 * secret scanner, and `vulnerable-dependency` trips the pinned advisory snapshot.
 */
export function referenceCodeFixtureCandidate(name: ReferenceCodeFixtureName): readonly ReferenceCodeFile[] {
  const base = referenceCodeLaunchRepository();
  const accepted = withReferenceCodeFile(base, "src/slugify.ts", REFERENCE_CODE_ACCEPTED_SLUGIFY);
  switch (name) {
    case "accepted":
      return accepted;
    case "unchanged-case":
      return withReferenceCodeFile(base, "src/slugify.ts", UNCHANGED_CASE_SLUGIFY);
    case "removed-protected-test":
      return withoutReferenceCodeFile(accepted, "test/slugify.protected.test.ts");
    case "outside-allowed-paths":
      return withReferenceCodeFile(accepted, "tools/release.ts", "export const released = true;\n");
    case "leaked-secret":
      return withReferenceCodeFile(base, "src/slugify.ts", LEAKED_SECRET_SLUGIFY);
    case "vulnerable-dependency":
      return withReferenceCodeFile(accepted, "package.json", VULNERABLE_MANIFEST);
  }
}
