#!/usr/bin/env bun
// substack-engagement postinstall.
//
// The host installer runs this in a plain Bun context — there is no
// JSON-RPC channel to the host's storage handler yet, so we can't write
// queue rows or entities here. The single `default` voice-profile is
// seeded by the SDK from the `entities[].seed` block (which resolves
// `{file:./prompts/voice-sample.md}` at install time).
//
// All this script does is verify the seed prompt is readable and emit a
// friendly setup hint. If the file is missing the extension still works
// — the voice falls back to the agent prompt.

import { join } from "node:path";

const EXT_DIR = import.meta.dir;
const VOICE_SAMPLE = join(EXT_DIR, "..", "prompts", "voice-sample.md");

async function main() {
  const file = Bun.file(VOICE_SAMPLE);
  if (!(await file.exists())) {
    console.warn(
      "WARNING: substack-engagement: prompts/voice-sample.md is missing on disk. " +
        "The default voice profile won't auto-seed (the extension still works — " +
        "drafts fall back to the agent prompt). Reinstall to seed it.",
    );
  }

  console.log("substack-engagement installed.");
  console.log("Next steps:");
  console.log(
    "  1. Open /extensions/substack-engagement and fill Publication URL, " +
      "Session token, and User ID.",
  );
  console.log(
    "  2. Edit the 'Default Voice' profile to match how you write.",
  );
  console.log(
    "  3. In chat: `![ext:substack-engagement]` then ask it to scan your " +
      "comments. Review the drafts via `open_review_queue` and approve the " +
      "good ones — nothing sends until you approve it.",
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("substack-engagement postinstall:", (err as Error).message);
    process.exit(1);
  });
}
