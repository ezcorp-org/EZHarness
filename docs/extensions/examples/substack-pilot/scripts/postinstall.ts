#!/usr/bin/env bun
// substack-pilot postinstall.
//
// Note on seeding: the host installer runs this script in a plain Bun
// context — there is no JSON-RPC channel to the host's storage handler
// yet, so we can't write `post-type:*` rows here. Instead, the bundled
// seed prompts under `./prompts/*.md` are loaded lazily on the first
// `list_post_types` call (see lib/post-types.ts: ensureSeedsLoaded).
//
// All this script does is verify the seed-prompt files are readable and
// emit a friendly setup hint. If a seed file is missing the extension
// still works — the missing default just won't be auto-seeded.

import { join } from "node:path";

const EXT_DIR = import.meta.dir;
const PROMPTS_DIR = join(EXT_DIR, "..", "prompts");
const SEEDS = ["weekly", "monthly", "ad-hoc"] as const;

async function main() {
  const missing: string[] = [];
  for (const slug of SEEDS) {
    const path = join(PROMPTS_DIR, `${slug}.md`);
    const file = Bun.file(path);
    if (!(await file.exists())) missing.push(slug);
  }

  if (missing.length > 0) {
    console.warn(
      `WARNING: substack-pilot: ${missing.length} default prompt file(s) missing on disk: ` +
        `${missing.join(", ")}. Reinstall the extension to seed default post types ` +
        `(the extension still works without them — only the auto-seeded defaults for ` +
        `the listed slug(s) will be unavailable).`,
    );
  }

  console.log("substack-pilot installed.");
  console.log("Next steps:");
  console.log(
    "  1. Open /extensions/substack-pilot and fill SUBSTACK_PUBLICATION_URL, " +
      "SUBSTACK_SESSION_TOKEN, SUBSTACK_USER_ID.",
  );
  console.log(
    "  2. In chat: type `![ext:substack-pilot]` then ask " +
      "\"What Substack post types do I have?\" — the three defaults " +
      "(weekly, monthly, ad-hoc) will auto-seed on first call.",
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("substack-pilot postinstall:", (err as Error).message);
    process.exit(1);
  });
}
