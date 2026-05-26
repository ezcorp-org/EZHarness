#!/usr/bin/env bun
// substack-engagement preuninstall.
//
// The review queue (project-scoped storage) and the voice-profile entity
// are intentionally left intact — if the user reinstalls later, their
// pending drafts and tuned voice come back. The host's extension_storage
// rows are cleaned up only if the extension row is deleted entirely
// (cascade); this script does not actively wipe user data.

console.log(
  "substack-engagement: uninstalling. Your review queue and voice profile are",
);
console.log("preserved in extension storage and return on reinstall.");
