// sec-C4 helper: clamp a caller-submitted permission set to the
// intersection of what the extension's manifest actually requested.
//
// MOVED (fix-wave B Phase 2): the implementation now lives in
// `src/extensions/clamp-permissions.ts` alongside the per-surface clamp
// helpers it delegates to. The move exists because the BACKEND installer
// (`updateExtension` + the installFromLocal same-source refresh) must
// re-clamp stored grants against a NEW manifest, and backend code cannot
// import from `web/src/**` (the root tsconfig excludes it; the `$server`
// aliases only resolve inside the web build). This file stays as a
// re-export so every existing web route / test import keeps working —
// same symbols, same behavior, one canonical implementation.
export {
	clampExtensionPermissions,
	manifestEventsIncludeFullPayload,
} from "$server/extensions/clamp-permissions";
