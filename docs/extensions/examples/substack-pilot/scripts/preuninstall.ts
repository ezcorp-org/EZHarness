#!/usr/bin/env bun
// substack-pilot preuninstall.
//
// User post types are intentionally left intact — if the user reinstalls
// the extension later, their custom prompts come back. The host's
// extension_storage table will eventually be cleaned up if the extension
// row is deleted entirely (cascade), but this script does not actively
// wipe user data.

console.log("substack-pilot: uninstalling. User-defined post types are preserved");
console.log("in extension storage and will be available again on reinstall.");
